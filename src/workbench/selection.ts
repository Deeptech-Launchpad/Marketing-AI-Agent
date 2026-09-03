import { prisma } from '../platform/db.js'

// TASK #981 — choosing which product to demonstrate.
//
// Deterministic, so the same audit always produces the same demo. That matters
// more than it sounds: a salesperson who sends a link, then reopens it to
// rehearse, must see the same page the prospect will see.
//
// Nothing here fetches anything. The choice is made from stored Task #979 rows.

export interface CandidatePage {
  pageId: string
  url: string
  observedFields: number
  wordCount: number
  depth: number
}

export interface SelectionResult {
  page: CandidatePage | null
  /** Everything considered, best first — kept so the choice can be explained. */
  candidates: CandidatePage[]
  reason: string
}

/**
 * Ranks product pages by how much of a product they actually show.
 *
 * The first key is the number of OBSERVED product fields, because a demo built
 * on a page with a name and nothing else is a weak demo — the BEFORE has to
 * look like a real product page before the AFTER means anything.
 */
export async function selectProductPage(auditRunId: string, explicitPageId?: string): Promise<SelectionResult> {
  const pages = await prisma.auditedPage.findMany({
    where: { auditRunId, pageType: 'product', outcome: 'fetched' },
    select: { id: true, requestedUrl: true, finalUrl: true, wordCount: true, depth: true },
  })

  if (!pages.length) {
    return {
      page: null,
      candidates: [],
      reason: 'The approved audit recorded no product page for this website.',
    }
  }

  const observed = await prisma.pageObservation.groupBy({
    by: ['pageId'],
    where: { pageId: { in: pages.map((p) => p.id) }, field: { startsWith: 'product.' }, status: 'observed' },
    _count: { _all: true },
  })
  const observedByPage = new Map(observed.map((o) => [o.pageId, o._count._all]))

  const candidates: CandidatePage[] = pages
    .map((p) => ({
      pageId: p.id,
      url: p.finalUrl ?? p.requestedUrl,
      observedFields: observedByPage.get(p.id) ?? 0,
      wordCount: p.wordCount,
      depth: p.depth,
    }))
    .sort(
      (a, b) =>
        b.observedFields - a.observedFields ||
        b.wordCount - a.wordCount ||
        a.depth - b.depth ||
        // Stable final key so ties never reorder between runs.
        a.url.localeCompare(b.url),
    )

  if (explicitPageId) {
    const chosen = candidates.find((c) => c.pageId === explicitPageId)
    if (!chosen) {
      return {
        page: null,
        candidates,
        // Named explicitly rather than silently falling back: a caller who
        // asked for a specific page wants that page or an error.
        reason: `Page ${explicitPageId} is not a fetched product page belonging to this audit run.`,
      }
    }
    return { page: chosen, candidates, reason: 'Explicitly selected by an authorised internal user.' }
  }

  const best = candidates[0]!
  return {
    page: best,
    candidates,
    reason:
      `Selected automatically: ${best.observedFields} observed product field(s), ${best.wordCount} words, depth ${best.depth}` +
      (candidates.length > 1 ? `, ahead of ${candidates.length - 1} other product page(s).` : '.'),
  }
}
