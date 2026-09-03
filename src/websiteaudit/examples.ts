import { prisma } from '../platform/db.js'
import type { ComparedField } from '../workbench/types.js'
import type { CollateralExample } from './collateral.js'

// PHASE 6 — before/after examples for the customer report.
//
// This is a LOADER, not a transformer. Task #981 already built the comparison
// engine and stored its output as WorkbenchField rows, each carrying the
// observation it came from and the rule that produced it. Building a second
// transformation here would create two answers to "what does the improved
// version look like", and the customer report is the wrong place to discover
// they disagree.
//
// So the only decisions this file makes are which stored rows to show and
// which to refuse:
//
//   REFUSED — an AFTER value with no provenance. The brief requires every
//   after value to resolve to a FieldProvenance, so a row that cannot be
//   traced is dropped rather than printed. That should never happen; it is
//   checked because a report that quietly showed an untraceable value would
//   be the single worst failure available to this feature.
//
//   EXCLUDED — fields where nothing changed. `unchanged` and `still_absent`
//   are true and useful internally, but a before/after example that shows no
//   difference demonstrates nothing to a customer. The count of what was
//   excluded is returned, so the omission stays visible.

export interface ExampleLoadResult {
  examples: CollateralExample[]
  /** Fields dropped because nothing changed. Reported, never hidden. */
  unchangedFields: number
  /** Fields dropped because an AFTER value had no provenance. Should be 0. */
  untraceableFields: number
  /** Why there are no examples, when there are none. */
  reason: string | null
}

/**
 * Decodes the HTML entities that survive extraction.
 *
 * Breadcrumb trails and titles are read out of markup, so a category filed
 * under "SAFETY &amp; PPE" is stored with the entity intact. That is correct
 * for a stored observation — it is what the page said — but it must not reach
 * a customer document, where "&amp;" reads as a fault in the report rather
 * than as a faithful quotation.
 *
 * Decoded here, at the boundary where stored data becomes customer-facing
 * prose, rather than in the renderer: the collateral object is also served to
 * the interface, and both should show the same clean text.
 */
function decodeEntities(value: string | null): string | null {
  if (value === null) return null
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    // Ampersand last, so "&amp;lt;" does not become a tag.
    .replace(/&amp;/g, '&')
}

export interface LoadExamplesOptions {
  /** Distinct product pages to show. */
  maxExamples?: number
  /** Field rows per product page — a PDF column has a finite length. */
  maxFieldsPerExample?: number
}

/**
 * Loads the stored Workbench comparison for an audit run.
 *
 * Returns an empty result with a stated reason when the Workbench found no
 * product page to demonstrate — which is a real and common outcome, not an
 * error, and one the report has to degrade into honestly.
 */
export async function loadBeforeAfterExamples(
  tenantId: string,
  auditRunId: string,
  options: LoadExamplesOptions = {},
): Promise<ExampleLoadResult> {
  const maxExamples = Math.max(1, options.maxExamples ?? 3)
  const maxFields = Math.max(1, options.maxFieldsPerExample ?? 5)

  const demo = await prisma.workbenchDemo.findFirst({
    where: { tenantId, auditRunId },
    include: { fields: { orderBy: [{ headline: 'desc' }, { position: 'asc' }] } },
  })

  if (!demo) {
    return {
      examples: [],
      unchangedFields: 0,
      untraceableFields: 0,
      reason: 'No Workbench comparison has been built for this audit, so there is no worked example to show.',
    }
  }
  if (demo.status !== 'ready') {
    return {
      examples: [],
      unchangedFields: 0,
      untraceableFields: 0,
      reason:
        demo.status === 'no_product_page'
          ? 'No product page could be identified on this site, so there is nothing to demonstrate a before and after on.'
          : `The Workbench comparison for this audit is "${demo.status}"${demo.statusReason ? `: ${demo.statusReason}` : ''}.`,
    }
  }

  let unchangedFields = 0
  let untraceableFields = 0
  const fields: ComparedField[] = []

  for (const row of demo.fields) {
    // Nothing to demonstrate.
    if (row.delta === 'unchanged' || row.delta === 'still_absent') {
      unchangedFields++
      continue
    }

    // The provenance gate. An AFTER value that cannot be traced to an
    // observation is not shown, whatever else is true about it.
    const hasAfter = row.afterValue !== null && row.afterValue !== ''
    if (hasAfter && row.transformKind !== 'not_present' && !row.sourceObservationId) {
      untraceableFields++
      continue
    }

    fields.push({
      field: row.field,
      label: row.label,
      before: decodeEntities(row.beforeValue),
      after: decodeEntities(row.afterValue),
      delta: row.delta as ComparedField['delta'],
      headline: row.headline,
      provenance: {
        kind: row.transformKind as ComparedField['provenance']['kind'],
        sourceObservationId: row.sourceObservationId,
        sourceField: row.sourceField,
        sourceUrl: row.sourceUrl,
        sourcePath: row.sourcePath,
        sourceFragment: row.sourceFragment,
        // The rule quotes the source value, so it carries entities too.
        rule: decodeEntities(row.transformRule) ?? row.transformRule,
      },
    })
  }

  if (!fields.length) {
    return {
      examples: [],
      unchangedFields,
      untraceableFields,
      reason:
        untraceableFields > 0
          ? `${untraceableFields} comparison field(s) could not be traced to an observation and were withheld. No traceable example remains.`
          : 'The comparison for this product changed nothing, so there is no before and after to show.',
    }
  }

  // One demo describes one product page, so today this yields a single
  // example. The shape is a list because the cap belongs on products, not on
  // fields — if the Workbench later demonstrates several pages, the customer
  // report already limits them without another change here.
  const examples: CollateralExample[] = [
    {
      productUrl: demo.productPageUrl ?? demo.websiteUrl ?? '',
      productName: demo.productName,
      fields: fields.slice(0, maxFields),
    },
  ].slice(0, maxExamples)

  return { examples, unchangedFields, untraceableFields, reason: null }
}
