import { prisma } from '../platform/db.js'
import type { EnrichedRecord } from './enrichedRecord.js'
import type { ScorecardInput } from './discoverabilityScore.js'

// GATHERING WHAT THE SCORECARD IS ALLOWED TO SEE.
//
// Scoped to one run and one page throughout, which is what makes the company
// isolation structural rather than a convention: the scorecard cannot read a
// fact about another company because it is never handed one.
//
// Separate from discoverabilityScore.ts on purpose. That file is pure and
// testable without a database; this one is the only place that touches Prisma,
// so a change to the rules can never quietly become a change to the query.

/** The page-level observations the scorecard reads, for ONE audited page. */
export async function loadScorecardInput(
  auditRunId: string,
  record: EnrichedRecord,
  productPagesInspected: number,
): Promise<ScorecardInput> {
  const page = await prisma.auditedPage.findUnique({
    where: { id: record.pageId },
    select: {
      httpStatus: true,
      finalUrl: true,
      canonicalUrl: true,
      wordCount: true,
      outcome: true,
      auditRunId: true,
    },
  })

  // A page from another run would be a lineage break, not a missing value.
  if (page && page.auditRunId !== auditRunId) {
    throw new Error(
      `Scorecard lineage: page ${record.pageId} belongs to run ${page.auditRunId}, not ${auditRunId}.`,
    )
  }

  const pageObs = await prisma.pageObservation.findMany({
    where: { auditRunId, pageId: record.pageId, status: 'observed' },
    select: { field: true, value: true },
  })
  const obs = (field: string): string | null => pageObs.find((o) => o.field === field)?.value ?? null

  const structuredRaw = obs('page.structuredDataTypes')
  const structuredDataTypes = structuredRaw
    ? structuredRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : []

  // How many OTHER product pages this run reached from the same site. Used as
  // the variant/relation signal: a product page that connects to nothing is a
  // dead end for a crawler following a range.
  const siblingProductLinks = Math.max(0, productPagesInspected - 1)

  return {
    page: {
      httpStatus: page?.httpStatus ?? null,
      finalUrl: page?.finalUrl ?? record.sourceUrl,
      canonicalUrl: page?.canonicalUrl ?? obs('page.canonical'),
      wordCount: page?.wordCount ?? 0,
      outcome: page?.outcome ?? 'unknown',
    },
    structuredDataTypes,
    breadcrumbs: obs('page.breadcrumbs') ?? record.pageContext?.breadcrumbs ?? null,
    record,
    productPagesInspected,
    siblingProductLinks,
  }
}
