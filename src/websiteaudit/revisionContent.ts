import { z } from 'zod'
import type { SalesCollateral } from './collateral.js'

// TASK #980 — the editable surface.
//
// This file is the boundary between what a reviewer may rewrite and what only a
// new audit may change. It is drawn as narrowly as the requirement allows,
// because the moment a reviewer can edit a number, the number stops being
// evidence and becomes an opinion with a citation attached.
//
// EDITABLE: prose. Headline, summary, next step, impact statements, recommended
// improvement areas, and the impact/recommendation wording on a key finding.
// These are how the report READS.
//
// NOT EDITABLE, by construction rather than by convention: every count, every
// metric string, every sample size, every source URL, every evidence reference,
// the scope note, and the company/website/date identity. Those fields are not
// present in the schema below, so a payload carrying them is rejected before
// anything is merged — a reviewer cannot change "3 of 12" to "5 of 12", because
// there is no field in which to send it.

/**
 * The revision payload. `.strict()` is load bearing: an unknown key is a hard
 * error rather than a silently ignored one, so an attempt to submit
 * `metrics`, `evidence` or `pagesInspected` fails loudly instead of appearing
 * to succeed.
 */
export const RevisionEditSchema = z
  .object({
    headline: z.string().min(3).max(200).optional(),
    summary: z.string().min(10).max(4000).optional(),
    nextStep: z.string().min(10).max(2000).optional(),
    businessImpact: z.array(z.string().min(5).max(1000)).max(12).optional(),
    recommendedImprovementAreas: z.array(z.string().min(5).max(1000)).max(12).optional(),
    /**
     * Per-finding wording, addressed by position in the existing key-finding
     * list. Only the two prose fields are reachable; title, metric, priority,
     * sourceUrls and evidenceCount are not.
     */
    keyFindingEdits: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            impact: z.string().min(5).max(1000).optional(),
            recommendation: z.string().min(5).max(1000).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict()

export type RevisionEdit = z.infer<typeof RevisionEditSchema>

/** Fields a caller might expect to edit, with the reason they cannot. */
export const IMMUTABLE_FIELDS: Record<string, string> = {
  metrics: 'Metrics are computed from stored observations. Changing one would detach it from its evidence.',
  keyFindings: 'Use keyFindingEdits to reword impact and recommendation. Titles, metrics and evidence are source-controlled.',
  scopeNote: 'The scope note states which crawl limits bound the sample. It is a fact about the audit run.',
  pagesInspected: 'Counts come from the crawl and can only change by re-auditing.',
  productPagesInspected: 'Counts come from the crawl and can only change by re-auditing.',
  categoryPagesInspected: 'Counts come from the crawl and can only change by re-auditing.',
  companyName: 'Identity fields come from the CRM record and the audit run.',
  website: 'Identity fields come from the CRM record and the audit run.',
  auditDate: 'The audit date is when the crawl ran.',
  status: 'Status is controlled by the approval state machine, not by a revision payload.',
  evidence: 'Evidence is written by the audit and is immutable.',
  observations: 'Observations are written by the audit and are immutable.',
}

/**
 * Applies reviewer edits to a collateral document.
 *
 * Everything not named in the edit is carried through untouched. The function
 * never invents a field and never drops one — the output is the source document
 * with prose replaced, which is what makes the diff between two revisions
 * readable.
 */
export function applyEdits(source: SalesCollateral, edit: RevisionEdit): SalesCollateral {
  const next: SalesCollateral = {
    ...source,
    // Arrays are copied so the source object is never mutated in place; two
    // revisions sharing an array reference would silently rewrite history.
    metrics: source.metrics.map((m) => ({ ...m })),
    keyFindings: source.keyFindings.map((f) => ({ ...f, sourceUrls: [...f.sourceUrls] })),
    businessImpact: [...source.businessImpact],
    recommendedImprovementAreas: [...source.recommendedImprovementAreas],
  }

  if (edit.headline !== undefined) next.headline = edit.headline
  if (edit.summary !== undefined) next.summary = edit.summary
  if (edit.nextStep !== undefined) next.nextStep = edit.nextStep
  if (edit.businessImpact !== undefined) next.businessImpact = [...edit.businessImpact]
  if (edit.recommendedImprovementAreas !== undefined) {
    next.recommendedImprovementAreas = [...edit.recommendedImprovementAreas]
  }

  for (const fe of edit.keyFindingEdits ?? []) {
    const target = next.keyFindings[fe.index]
    if (!target) continue
    if (fe.impact !== undefined) target.impact = fe.impact
    if (fe.recommendation !== undefined) target.recommendation = fe.recommendation
  }

  return next
}

/** The prose fields a validator must check. Kept next to the edit surface so the two cannot drift. */
export function editableProse(c: SalesCollateral): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [
    { field: 'headline', text: c.headline },
    { field: 'summary', text: c.summary },
    { field: 'nextStep', text: c.nextStep },
  ]
  c.businessImpact.forEach((t, i) => out.push({ field: `businessImpact[${i}]`, text: t }))
  c.recommendedImprovementAreas.forEach((t, i) => out.push({ field: `recommendedImprovementAreas[${i}]`, text: t }))
  c.keyFindings.forEach((f, i) => {
    out.push({ field: `keyFindings[${i}].impact`, text: f.impact })
    out.push({ field: `keyFindings[${i}].recommendation`, text: f.recommendation })
  })
  return out
}

/**
 * Reports which immutable parts of a document differ from its source.
 *
 * Belt and braces. The schema already makes these unreachable through the API;
 * this catches a future code path that assembles a revision some other way, and
 * turns "someone edited the evidence" from a silent corruption into a blocked
 * approval.
 */
export function immutableDrift(source: SalesCollateral, candidate: SalesCollateral): string[] {
  const drift: string[] = []

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

  if (source.companyName !== candidate.companyName) drift.push('companyName')
  if (source.website !== candidate.website) drift.push('website')
  if (source.auditDate !== candidate.auditDate) drift.push('auditDate')
  if (source.pagesInspected !== candidate.pagesInspected) drift.push('pagesInspected')
  if (source.productPagesInspected !== candidate.productPagesInspected) drift.push('productPagesInspected')
  if (source.categoryPagesInspected !== candidate.categoryPagesInspected) drift.push('categoryPagesInspected')
  if (source.scopeNote !== candidate.scopeNote) drift.push('scopeNote')
  if (!same(source.metrics, candidate.metrics)) drift.push('metrics')

  if (source.keyFindings.length !== candidate.keyFindings.length) {
    drift.push('keyFindings.length')
  } else {
    source.keyFindings.forEach((f, i) => {
      const c = candidate.keyFindings[i]!
      if (f.title !== c.title) drift.push(`keyFindings[${i}].title`)
      if (f.metric !== c.metric) drift.push(`keyFindings[${i}].metric`)
      if (f.priority !== c.priority) drift.push(`keyFindings[${i}].priority`)
      if (f.evidenceCount !== c.evidenceCount) drift.push(`keyFindings[${i}].evidenceCount`)
      if (!same(f.sourceUrls, c.sourceUrls)) drift.push(`keyFindings[${i}].sourceUrls`)
    })
  }

  return drift
}
