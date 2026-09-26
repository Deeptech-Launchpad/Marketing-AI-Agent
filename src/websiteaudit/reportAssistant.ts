import { z } from 'zod'
import { getLlm } from '../llm/index.js'
import { prisma } from '../platform/db.js'
import { NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { findUnsupportedClaims, type ClaimViolation } from './claimGuard.js'
import type { SalesCollateral } from './collateral.js'
import { buildCustomerView } from './customerView.js'
import { buildRemediation, buildScorecard, NO_SUBJECT_SCORECARD } from './discoverabilityScore.js'
import { RevisionEditSchema } from './revisionContent.js'
import { loadScorecardInput } from './scorecardInput.js'

// THE AUDIT ASSISTANT — A CHATBOT THAT KNOWS ONE AUDIT AND NOTHING ELSE.
//
// Sales asks things like "draft a better description for their hero product",
// "write the customer a two-paragraph summary", "tighten the executive
// summary". A general chatbot would answer all of those fluently and
// confidently — out of its own knowledge of what such a company probably
// sells, which is the one source this platform has spent its whole design
// refusing to use.
//
// So this assistant is GROUNDED, and the grounding is the product:
//
//   · It is handed ONE document: this audit's findings, scorecard, roadmap,
//     hero product record and approved wording — built from the same customer
//     view the Workbench and the PDF render, so it cannot describe a different
//     audit from the one on screen.
//   · It is told to answer only from that document, to say plainly when the
//     audit does not contain the answer, and to cite what it used.
//   · Everything it produces is checked AFTER it produces it. Nothing is
//     trusted because the prompt asked nicely:
//       - the claim guard runs over every reply, draft and proposed edit
//         (ROI, money, guarantees, rankings, whole-catalogue generalisations);
//       - every figure it states is checked against the audit document, and a
//         figure the audit does not contain is flagged on the draft;
//       - a proposed report edit must pass the revision schema, and one that
//         trips the claim guard is returned BLOCKED rather than applicable.
//
// WHAT IT CAN CHANGE: NOTHING, DIRECTLY.
//
// It may PROPOSE an edit to the report's editable prose. Applying one is a
// separate human action that goes through the existing revision route — the
// same one the Approval screen uses — which re-runs validation, stores a new
// revision, and leaves approval to a reviewer. The assistant has no write path
// of its own, so it cannot alter an approved report, skip review, or touch
// evidence, metrics or findings: those are immutable in the revision schema.

/** How much conversation is carried back to the model. Bounded on purpose. */
const MAX_HISTORY_TURNS = 8
const MAX_MESSAGE_CHARS = 2000

export const AssistantTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(6000),
})
export type AssistantTurn = z.infer<typeof AssistantTurnSchema>

/** What the model must return. Every field is post-checked before use. */
const AssistantOutput = z.object({
  /** The answer, in plain prose, grounded in the audit document. */
  reply: z.string().min(1).max(4000),
  /** Ready-to-use outputs Sales asked for. Empty when none was asked for. */
  drafts: z
    .array(
      z.object({
        kind: z.enum(['product_description', 'spec_table', 'customer_email', 'talk_track', 'summary', 'other']),
        title: z.string().min(1).max(160),
        content: z.string().min(1).max(6000),
      }),
    )
    .max(3),
  /**
   * A proposed change to the report's editable prose, or null. Only the fields
   * the revision schema allows can appear here; everything else is immutable.
   */
  proposedEdit: z
    .object({
      changeReason: z.string().min(10).max(500),
      headline: z.string().max(200).nullable(),
      summary: z.string().max(4000).nullable(),
      nextStep: z.string().max(2000).nullable(),
    })
    .nullable(),
  /** Which items of the audit document the reply relied on (check refs, finding codes, field ids). */
  citations: z.array(z.string().max(80)).max(12),
})

export interface AssistantDraft {
  kind: string
  title: string
  content: string
  /** Figures in the draft that do not appear anywhere in the audit document. */
  ungroundedFigures: string[]
  claimViolations: ClaimViolation[]
}

export interface AssistantProposedEdit {
  changeReason: string
  /** Exactly the RevisionEdit the revise route accepts. */
  edit: { headline?: string; summary?: string; nextStep?: string }
  /** The report's current wording for each field being changed, for a side-by-side. */
  current: { headline?: string; summary?: string; nextStep?: string }
  /** True when the edit cannot be applied as proposed. */
  blocked: boolean
  blockedReasons: string[]
}

export interface AssistantAnswer {
  reply: string
  drafts: AssistantDraft[]
  proposedEdit: AssistantProposedEdit | null
  citations: string[]
  /** Checks that fired on the reply itself. Shown, never silently dropped. */
  warnings: string[]
  model: string | null
}

/**
 * The audit, as one compact document.
 *
 * Built from the customer view (the Workbench's and the PDF's own source), the
 * scorecard, the remediation roadmap, the stored findings and the report's
 * current wording. Nothing here is recomposed or summarised by a model; it is
 * the stored record, trimmed to what an assistant needs.
 */
export async function buildAssistantContext(tenantId: string, auditRunId: string): Promise<{
  document: Record<string, unknown>
  currentWording: { headline: string; summary: string; nextStep: string }
}> {
  const report = await prisma.auditReport.findFirst({ where: { tenantId, auditRunId } })
  if (!report) throw new NotFoundError('No audit report exists for that run, so there is nothing to discuss.')

  const view = await buildCustomerView(tenantId, auditRunId)
  const run = await prisma.websiteAuditRun.findFirstOrThrow({ where: { id: auditRunId, tenantId } })

  const revision = await prisma.auditReportRevision.findFirst({
    where: { auditReportId: report.id, revisionNumber: report.currentRevision },
  })
  const collateral = ((revision?.content ?? report.collateral) ?? {}) as Partial<SalesCollateral>

  const hero = view.caseStudies[0] ?? null
  const scorecardInput = hero ? await loadScorecardInput(run.id, hero, run.productPages) : null
  const scorecard = scorecardInput ? buildScorecard(scorecardInput) : NO_SUBJECT_SCORECARD
  const remediation = scorecardInput ? buildRemediation(scorecard) : []

  const findings = await prisma.catalogFinding.findMany({
    where: { auditRunId },
    orderBy: { affectedCount: 'desc' },
    select: {
      code: true,
      title: true,
      priority: true,
      affectedCount: true,
      sampleSize: true,
      sampleUnit: true,
      finding: true,
      recommendation: true,
    },
  })

  const currentWording = {
    headline: collateral.headline ?? '',
    summary: collateral.summary ?? '',
    nextStep: collateral.nextStep ?? '',
  }

  const document = {
    company: view.companyName,
    website: view.website,
    auditDate: view.auditDate,
    reportStatus: report.status,
    scope: {
      pagesInspected: view.pagesInspected,
      productPagesInspected: view.productPagesInspected,
      note: view.scopeNote,
    },
    productEvidenceState: {
      state: view.productEvidence.state,
      headline: view.productEvidence.headline,
    },
    currentReportWording: currentWording,
    scorecard: {
      overall: scorecard.overall,
      verdict: scorecard.verdict,
      assessedChecks: scorecard.assessedCount,
      denominatorNote: scorecard.denominatorNote,
      checks: scorecard.pillars.flatMap((p) =>
        p.checks.map((c) => ({ ref: c.ref, pillar: p.title, metric: c.metric, status: c.status, finding: c.finding, basis: c.basis })),
      ),
    },
    roadmap: remediation.map((r) => ({
      title: r.title,
      onThePageToday: r.observedBefore,
      problem: r.currentGap,
      recommendedChange: r.remediation,
      expectedImprovement: r.impact,
      addresses: r.addresses,
      effort: r.effort,
    })),
    findings: findings.map((f) => ({
      code: f.code,
      title: f.title,
      priority: f.priority,
      scope: `${f.affectedCount} of ${f.sampleSize} ${f.sampleUnit}`,
      finding: f.finding,
      recommendation: f.recommendation,
    })),
    heroProduct: hero
      ? {
          title: hero.title,
          url: hero.sourceUrl,
          publishedFields: hero.fields
            .filter((f) => f.before)
            .map((f) => ({ field: f.field, label: f.label, value: f.before })),
          missingFields: hero.fields.filter((f) => f.state === 'absent').map((f) => ({ field: f.field, label: f.label })),
          statedInProseOnly: hero.fields.flatMap((f) =>
            (f.derivedAttributes ?? []).map((d) => ({ label: d.label, value: d.value, fromText: d.sourceText })),
          ),
        }
      : null,
    recommendedFieldsForCategory: {
      category: view.recommendedSchema.determined ? view.recommendedSchema.categoryLabel : null,
      attributes: view.recommendedSchema.attributes.map((a) => ({ label: a.label, state: a.state, value: a.value, why: a.why })),
    },
    proposedWording: view.proposedContent?.overview ?? null,
    illustrativeExampleFormats: view.illustrativeExamples,
  }

  return { document, currentWording }
}

/** Every number-like token in a piece of text. */
function figuresIn(text: string): string[] {
  return [...new Set(text.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [])]
}

/**
 * Figures the text states that the audit document does not contain.
 *
 * Deliberately simple and deliberately strict. A draft product description
 * that says "5 litre" when the page said "5L" is flagged, and a reviewer can
 * see why; a description that invents "rated to 90°C" is flagged, and that is
 * the case this exists for.
 */
export function ungroundedFigures(text: string, documentText: string): string[] {
  const haystack = documentText.toLowerCase()
  return figuresIn(text).filter((n) => !haystack.includes(n.toLowerCase()))
}

/**
 * Example values used in a draft WITHOUT an example label beside them.
 *
 * The illustrative examples ("2.4 kg", "300 × 200 × 150 mm") are in the
 * document so drafts can show what a finished field looks like — but they are
 * not the customer's data, so a figure found only there is grounded only where
 * the same line says it is an example. "Weight: 2.4 kg" alone would read as a
 * real specification once copied out of the panel.
 */
export function unlabelledExampleFigures(text: string, factText: string, exampleText: string): string[] {
  const facts = factText.toLowerCase()
  const examples = exampleText.toLowerCase()
  const hits = new Set<string>()
  for (const segment of text.split(/\r?\n|\|/)) {
    if (/example|\[[^\]]+\]/i.test(segment)) continue
    for (const n of figuresIn(segment)) {
      const key = n.toLowerCase()
      if (!facts.includes(key) && examples.includes(key)) hits.add(n)
    }
  }
  return [...hits]
}

export async function askReportAssistant(input: {
  tenantId: string
  auditRunId: string
  message: string
  history: AssistantTurn[]
}): Promise<AssistantAnswer> {
  const message = input.message.trim().slice(0, MAX_MESSAGE_CHARS)
  const { document, currentWording } = await buildAssistantContext(input.tenantId, input.auditRunId)
  const documentText = JSON.stringify(document)
  // The audit's facts, without the illustrative examples: what a report edit
  // may state, and what an unlabelled figure in a draft must come from.
  const { illustrativeExampleFormats, ...facts } = document
  const factText = JSON.stringify(facts)
  const exampleText = JSON.stringify(illustrativeExampleFormats ?? {})

  const history = input.history
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => `${t.role === 'user' ? 'SALES' : 'ASSISTANT'}: ${t.content}`)
    .join('\n\n')

  const result = await getLlm().generate({
    promptKey: 'report.assistant',
    variables: {
      auditDocument: JSON.stringify(document, null, 1),
      conversation: history || '(this is the first message)',
      message,
    },
    schema: AssistantOutput,
    feature: 'report_assistant',
    tenantId: input.tenantId,
  })
  const out = result.data

  const warnings = findUnsupportedClaims(out.reply).map((v) => `Reply: [${v.pattern}] "${v.match}" — ${v.why}`)

  const drafts: AssistantDraft[] = out.drafts.map((d) => ({
    kind: d.kind,
    title: d.title,
    content: d.content,
    ungroundedFigures: ungroundedFigures(d.content, documentText),
    claimViolations: [
      ...findUnsupportedClaims(d.content),
      ...unlabelledExampleFigures(d.content, factText, exampleText).map((n) => ({
        pattern: 'unlabelled-example',
        match: n,
        why: 'is an illustrative example value, not this customer’s data — label it as an example or replace it with the real value',
      })),
    ],
  }))

  let proposedEdit: AssistantProposedEdit | null = null
  if (out.proposedEdit) {
    const edit: AssistantProposedEdit['edit'] = {}
    const current: AssistantProposedEdit['current'] = {}
    for (const key of ['headline', 'summary', 'nextStep'] as const) {
      const value = out.proposedEdit[key]?.trim()
      if (value && value !== currentWording[key]) {
        edit[key] = value
        current[key] = currentWording[key]
      }
    }

    if (Object.keys(edit).length > 0) {
      const blockedReasons: string[] = []

      // The revise route's own schema, applied here first so a proposal that
      // could never be saved is never offered as though it could.
      const parsed = RevisionEditSchema.safeParse(edit)
      if (!parsed.success) {
        blockedReasons.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
      }

      // The claim guard the approval validator will run. Checked now, so
      // Sales learns at the moment of drafting rather than at approval.
      for (const [field, text] of Object.entries(edit)) {
        for (const v of findUnsupportedClaims(text)) {
          blockedReasons.push(`${field}: [${v.pattern}] "${v.match}" — ${v.why}`)
        }
        // Against the facts only: the report states findings, never example values.
        const loose = ungroundedFigures(text, factText)
        if (loose.length) {
          blockedReasons.push(`${field}: states ${loose.map((n) => `"${n}"`).join(', ')}, which the audit does not contain.`)
        }
      }

      proposedEdit = {
        changeReason: out.proposedEdit.changeReason,
        edit,
        current,
        blocked: blockedReasons.length > 0,
        blockedReasons,
      }
    }
  }

  logger.info(
    {
      auditRunId: input.auditRunId,
      drafts: drafts.length,
      proposedEdit: Boolean(proposedEdit),
      proposedEditBlocked: proposedEdit?.blocked ?? null,
      warnings: warnings.length,
    },
    'report assistant answered',
  )

  return {
    reply: out.reply,
    drafts,
    proposedEdit,
    citations: out.citations,
    warnings,
    model: result.model,
  }
}
