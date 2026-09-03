import { createHash } from 'node:crypto'
import { prisma } from '../platform/db.js'
import { findUnsupportedClaims } from './claimGuard.js'
import type { SalesCollateral } from './collateral.js'
import { editableProse, immutableDrift } from './revisionContent.js'

// TASK #980 — the gate a revision must pass before it can be approved.
//
// The product rule this enforces: approval is not a checkbox. A reviewer may
// only sign off a revision that still says true things, and "still true" is
// checked mechanically rather than assumed from the fact that a human looked
// at it.
//
// The check that does the most work is quantitativeClaims(). A reviewer cannot
// reach a metric through the edit schema, but they can type one into a summary.
// So every "N of M" that appears anywhere in reviewer prose is matched against
// the counts the audit actually recorded, and an unmatched pair blocks
// approval. That is what stops "3 of 12" quietly becoming "5 of 12".

export interface ValidationError {
  check: string
  field: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  checkedAt: Date
  passed: string[]
  errors: ValidationError[]
}

export interface ValidationInput {
  auditRunId: string
  tenantId: string
  /** The revision being validated. */
  content: SalesCollateral
  /** The originally generated collateral, for immutability comparison. */
  original: SalesCollateral
  pdfBytes: Buffer | null
  pdfSha256: string | null
}

/**
 * Number pairs the audit actually measured.
 *
 * Built from the stored findings and the crawl statistics — never from the
 * revision under review, which would make the check circular.
 */
async function allowedNumberPairs(auditRunId: string): Promise<{ pairs: Set<string>; metrics: Set<string> }> {
  const [findings, run] = await Promise.all([
    prisma.catalogFinding.findMany({
      where: { auditRunId },
      select: { metric: true, observedCount: true, affectedCount: true, sampleSize: true },
    }),
    prisma.websiteAuditRun.findUnique({
      where: { id: auditRunId },
      select: { pagesFetched: true, productPages: true, categoryPages: true },
    }),
  ])

  const pairs = new Set<string>()
  const metrics = new Set<string>()

  for (const f of findings) {
    metrics.add(f.metric)
    pairs.add(`${f.observedCount}/${f.sampleSize}`)
    pairs.add(`${f.affectedCount}/${f.sampleSize}`)
  }

  if (run) {
    // The crawl's own counts, which the summary legitimately quotes.
    pairs.add(`${run.productPages}/${run.pagesFetched}`)
    pairs.add(`${run.categoryPages}/${run.pagesFetched}`)
    pairs.add(`${run.productPages}/${run.productPages}`)
  }

  return { pairs, metrics }
}

/** Every "N of M" in a piece of prose. */
function numberPairsIn(text: string): Array<{ raw: string; key: string }> {
  const out: Array<{ raw: string; key: string }> = []
  const re = /(\d[\d,]*)\s+of\s+(\d[\d,]*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const a = m[1]!.replace(/,/g, '')
    const b = m[2]!.replace(/,/g, '')
    out.push({ raw: m[0], key: `${a}/${b}` })
  }
  return out
}

export async function validateRevision(input: ValidationInput): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const passed: string[] = []

  // ── 1. Structure ────────────────────────────────────────────────────────
  const required: Array<[string, unknown]> = [
    ['companyName', input.content.companyName],
    ['website', input.content.website],
    ['auditDate', input.content.auditDate],
    ['headline', input.content.headline],
    ['summary', input.content.summary],
    ['nextStep', input.content.nextStep],
    ['scopeNote', input.content.scopeNote],
  ]
  const missing = required.filter(([, v]) => typeof v !== 'string' || !String(v).trim())
  if (missing.length) {
    missing.forEach(([k]) =>
      errors.push({ check: 'structure', field: k, message: `"${k}" is required and must not be empty.` }),
    )
  } else {
    passed.push('structure')
  }

  // ── 2. Immutable fields unchanged ───────────────────────────────────────
  const drift = immutableDrift(input.original, input.content)
  if (drift.length) {
    drift.forEach((f) =>
      errors.push({
        check: 'immutable_fields',
        field: f,
        message: `"${f}" is source-controlled and differs from the generated report. Re-audit to change it.`,
      }),
    )
  } else {
    passed.push('immutable_fields')
  }

  // ── 3. Evidence references resolve ──────────────────────────────────────
  const findings = await prisma.catalogFinding.findMany({
    where: { auditRunId: input.auditRunId },
    select: { code: true, evidence: true },
  })

  const referenced = findings.flatMap((f) =>
    ((f.evidence ?? []) as Array<{ observationId: string }>).map((e) => ({ code: f.code, id: e.observationId })),
  )
  // Synthetic page-level references (page:<id>) point at AuditedPage, not at an
  // observation row, and are resolved against that table instead.
  const observationIds = referenced.filter((r) => !r.id.startsWith('page:')).map((r) => r.id)
  const pageIds = referenced.filter((r) => r.id.startsWith('page:')).map((r) => r.id.slice(5))

  const [foundObs, foundPages] = await Promise.all([
    observationIds.length
      ? prisma.pageObservation.findMany({ where: { id: { in: observationIds } }, select: { id: true } })
      : Promise.resolve([]),
    pageIds.length
      ? prisma.auditedPage.findMany({ where: { id: { in: pageIds } }, select: { id: true } })
      : Promise.resolve([]),
  ])

  const foundSet = new Set([...foundObs.map((o) => o.id), ...foundPages.map((p) => `page:${p.id}`)])
  const dangling = referenced.filter((r) => !foundSet.has(r.id))
  if (dangling.length) {
    dangling.slice(0, 5).forEach((d) =>
      errors.push({
        check: 'evidence_resolves',
        field: d.code,
        message: `Finding "${d.code}" cites observation ${d.id}, which no longer exists.`,
      }),
    )
  } else {
    passed.push('evidence_resolves')
  }

  // ── 4. Claim guard on reviewer-editable prose ───────────────────────────
  const prose = editableProse(input.content)
  let guardFailed = false
  for (const { field, text } of prose) {
    const violations = findUnsupportedClaims(text)
    violations.forEach((v) => {
      guardFailed = true
      errors.push({
        check: 'claim_guard',
        field,
        message: `[${v.pattern}] "${v.match}" — ${v.why}`,
      })
    })
  }
  if (!guardFailed) passed.push('claim_guard')

  // ── 5. Quantitative claims match measured counts ────────────────────────
  const { pairs } = await allowedNumberPairs(input.auditRunId)
  let numbersFailed = false
  for (const { field, text } of prose) {
    for (const found of numberPairsIn(text)) {
      if (pairs.has(found.key)) continue
      numbersFailed = true
      errors.push({
        check: 'quantitative_claims',
        field,
        message:
          `"${found.raw}" does not match any count this audit recorded. ` +
          'A figure in the report must come from the stored observations; re-audit to change what was measured.',
      })
    }
  }
  if (!numbersFailed) passed.push('quantitative_claims')

  // ── 6 & 7. A PDF exists and its digest matches its bytes ────────────────
  if (!input.pdfBytes || !input.pdfSha256) {
    errors.push({
      check: 'pdf_present',
      field: 'pdf',
      message: 'This revision has no rendered PDF. Regenerate the revision before approving it.',
    })
  } else {
    passed.push('pdf_present')
    const actual = createHash('sha256').update(input.pdfBytes).digest('hex')
    if (actual !== input.pdfSha256) {
      errors.push({
        check: 'pdf_integrity',
        field: 'pdf',
        message: `The stored PDF does not match its recorded digest (stored ${input.pdfSha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…).`,
      })
    } else {
      passed.push('pdf_integrity')
    }
  }

  return { ok: errors.length === 0, checkedAt: new Date(), passed, errors }
}
