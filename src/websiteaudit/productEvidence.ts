import { prisma } from '../platform/db.js'
import type { CatalogEntry, CatalogEntryStrength } from './catalogEvidence.js'

// FOUR STATES, AND WHY THERE HAVE TO BE FOUR.
//
// Every surface used to reduce a run to one bit: is there a product record, or
// is there not. Everything that was not a product record printed the same
// sentence — "No product page carried enough published data" — which covered
// four completely different situations with four completely different answers:
//
//   A  WEBSITE NOT READ          we never saw the site. Nothing is known about
//                                their catalogue, and saying "no products" is a
//                                claim we have no evidence for.
//   B  READ, NO PRODUCT EVIDENCE we read their pages and they name nothing they
//                                sell. THIS is the finding worth selling on.
//   C  PRODUCT CANDIDATE         they name products — in a grid, an ItemList,
//                                image alt text — but publish no page a machine
//                                can read as a product record.
//   D  PRODUCT PAGE              a dedicated product page was read.
//
// A and B are opposites and were being printed identically. C was being printed
// as B, which is the error that made a real customer's audit say zero products
// for a site with a full catalogue.
//
// THE TIERS ARE WHAT THE WORKBENCH CAN HONESTLY SHOW
//
//   Tier 1  their own product page, before and after
//   Tier 2  a catalogue listing they published, with its link and image
//   Tier 3  a catalogue entry assembled from evidence observed on their pages
//           — labelled as exactly that, never dressed up as a product page
//   none    nothing to show, and the reason said plainly
//
// A tier NEVER invents. Tier 3 is the weakest evidence this system will act on
// and it is still the company's own words, read off the company's own markup.

export const PRODUCT_EVIDENCE_STATES = [
  'website_not_read',
  'no_product_evidence',
  'product_candidate',
  'product_page',
] as const
export type ProductEvidenceState = (typeof PRODUCT_EVIDENCE_STATES)[number]

/** 0 means there is nothing to build from, and the reason is carried instead. */
export type WorkbenchTier = 0 | 1 | 2 | 3

export interface ProductEvidence {
  state: ProductEvidenceState
  /** The state letter from the specification, so screens and the PDF agree. */
  stateCode: 'A' | 'B' | 'C' | 'D'
  tier: WorkbenchTier
  /** What the Workbench is showing, in the words it should show it in. */
  tierLabel: string
  /** One sentence, suitable as a panel heading. */
  headline: string
  /** The full account, including what WAS found. Never a generic fallback. */
  detail: string
  /** Catalogue entries observed across the run, strongest first. */
  entries: CatalogEntry[]
  counts: Record<CatalogEntryStrength, number>
}

export interface ProductEvidenceInput {
  companyName: string
  /** The URL actually crawled, or null when none was resolved. */
  websiteUrl: string | null
  /** Why no site was read. Required whenever websiteUrl is null or nothing was fetched. */
  notReadReason: string | null
  pagesFetched: number
  /** Pages classified `product` that published a product name. */
  productPagesWithName: number
  /** Pages classified `product`, whatever they published. */
  productPages: number
  categoryPages: number
  entries: CatalogEntry[]
}

function countByStrength(entries: CatalogEntry[]): Record<CatalogEntryStrength, number> {
  const counts: Record<CatalogEntryStrength, number> = { linked: 0, named: 0, image_alt: 0 }
  entries.forEach((e) => counts[e.strength]++)
  return counts
}

/** "GRAB RAIL, GRAB RAIL LOOPED and 12 others" — evidence, not a summary. */
function nameList(entries: CatalogEntry[]): string {
  const names = entries.slice(0, 3).map((e) => `"${e.name}"`)
  const rest = entries.length - names.length
  if (rest > 0) names.push(`${rest} other${rest === 1 ? '' : 's'}`)
  return names.join(', ')
}

/**
 * Decides which of the four states a run is in, and what may honestly be built.
 *
 * Pure: it is given what the run observed and returns a reading of it. The
 * order of the tests is the order of the evidence's strength, and each one
 * carries its own explanation rather than falling through to a shared default.
 */
export function assessProductEvidence(input: ProductEvidenceInput): ProductEvidence {
  const entries = [...input.entries].sort((a, b) => {
    const rank: Record<CatalogEntryStrength, number> = { linked: 0, named: 1, image_alt: 2 }
    return rank[a.strength] - rank[b.strength]
  })
  const counts = countByStrength(entries)
  const site = input.websiteUrl ?? 'this company'

  // ── A. We never read the website ────────────────────────────────────────
  if (!input.websiteUrl || input.pagesFetched === 0) {
    const why =
      input.notReadReason ??
      'No page of this website was fetched, and no reason was recorded — which is itself a defect in the run.'
    return {
      state: 'website_not_read',
      stateCode: 'A',
      tier: 0,
      tierLabel: 'Nothing can be shown: this website was not read',
      headline: `${input.companyName}'s website was not read, so nothing is known about their catalogue`,
      detail:
        `${why} Because no page was inspected, this run makes no claim about what ${input.companyName} publishes. ` +
        'It is not a finding that they have no products — it is an absence of evidence either way.',
      entries: [],
      counts,
    }
  }

  // ── D. A real product page ──────────────────────────────────────────────
  if (input.productPagesWithName > 0) {
    return {
      state: 'product_page',
      stateCode: 'D',
      tier: 1,
      tierLabel: 'Their own product page',
      headline: `${input.productPagesWithName} product page(s) on ${site} were read in full`,
      detail:
        `The audit read ${input.pagesFetched} page(s) on this website and found ${input.productPagesWithName} ` +
        'dedicated product page(s) publishing a product name. The before-and-after below is built from one of ' +
        "those pages — the company's own product, on the company's own page.",
      entries,
      counts,
    }
  }

  // ── C. Named products, but no page a machine can read as a product ──────
  if (entries.length > 0) {
    const linked = counts.linked + counts.named
    const tier: WorkbenchTier = linked > 0 ? 2 : 3
    const tierLabel =
      tier === 2
        ? 'A catalogue listing published on their website'
        : 'Built from observed catalogue evidence — not a dedicated product page'

    // Where the evidence came from, so the reader can go and look at it.
    const how =
      counts.linked > 0
        ? 'their catalogue pages link to them by name'
        : counts.named > 0
          ? 'their catalogue pages name them in a product grid'
          : 'their pages carry the names only in image alt text, which is the sole machine-readable trace of them'

    return {
      state: 'product_candidate',
      stateCode: 'C',
      tier,
      tierLabel,
      headline: `${site} names ${entries.length} product(s) but publishes no product page a machine can read`,
      detail:
        `The audit read ${input.pagesFetched} page(s), including ${input.categoryPages} catalogue page(s), and ` +
        `found no dedicated product page. It did find ${entries.length} product(s) named on this website — ` +
        `${nameList(entries)} — because ${how}. ` +
        'That is the finding: the products exist and the pages that would let a search engine, a marketplace or ' +
        'an answer engine read them do not. Nothing below has been invented; every name, image and file name ' +
        "shown was read from this company's own pages.",
      entries,
      counts,
    }
  }

  // ── B. Read, and genuinely nothing named ────────────────────────────────
  return {
    state: 'no_product_evidence',
    stateCode: 'B',
    tier: 0,
    tierLabel: 'Nothing can be shown: this website names no product',
    headline: `${input.pagesFetched} page(s) on ${site} were read and none names a product`,
    detail:
      `The audit read ${input.pagesFetched} page(s) on this website${
        input.categoryPages > 0 ? `, including ${input.categoryPages} catalogue page(s),` : ''
      } and found no product page, no product listing, and no product named anywhere a machine can read it. ` +
      'That is the finding, and it is a strong one: a buyer searching for what this company sells cannot be ' +
      'shown a single item of theirs, because there is nothing published to show. No example has been invented ' +
      'in its place.',
    entries: [],
    counts,
  }
}

/** Reassembles the indexed `catalog.entry.N.*` observation rows into entries. */
export function entriesFromObservations(
  rows: Array<{ pageId: string; field: string; value: string | null; method: string | null; sourcePath: string | null; fragment: string | null }>,
): CatalogEntry[] {
  const byKey = new Map<string, Partial<CatalogEntry> & { name?: string }>()

  for (const row of rows) {
    const m = row.field.match(/^catalog\.entry\.(\d+)\.(name|strength|url|image|imageFileName)$/)
    if (!m || !row.value) continue
    const key = `${row.pageId}#${m[1]}`
    const entry = byKey.get(key) ?? {}
    switch (m[2]) {
      case 'name':
        entry.name = row.value
        entry.method = (row.method as CatalogEntry['method']) ?? 'dom_heuristic'
        entry.sourcePath = row.sourcePath ?? ''
        entry.fragment = row.fragment ?? ''
        break
      case 'strength':
        entry.strength = row.value as CatalogEntryStrength
        break
      case 'url':
        entry.detailUrl = row.value
        break
      case 'image':
        entry.imageUrl = row.value
        break
      case 'imageFileName':
        entry.imageFileName = row.value
        break
    }
    byKey.set(key, entry)
  }

  const out: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const e of byKey.values()) {
    if (!e.name) continue
    const key = e.name.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: e.name,
      detailUrl: e.detailUrl ?? null,
      imageUrl: e.imageUrl ?? null,
      imageFileName: e.imageFileName ?? null,
      strength: e.strength ?? 'image_alt',
      method: e.method ?? 'dom_heuristic',
      sourcePath: e.sourcePath ?? '',
      fragment: e.fragment ?? '',
    })
  }
  return out
}

/**
 * The stored reading of one run.
 *
 * Scoped to the run like everything else in the audit: a product name, image or
 * file name shown to a customer can only have come from that customer's own
 * pages, because no other run's rows are ever loaded.
 */
export async function loadProductEvidence(auditRunId: string): Promise<ProductEvidence> {
  const run = await prisma.websiteAuditRun.findUnique({ where: { id: auditRunId } })
  if (!run) {
    return assessProductEvidence({
      companyName: '(company not recorded)',
      websiteUrl: null,
      notReadReason: 'That audit run does not exist, so nothing was read.',
      pagesFetched: 0,
      productPagesWithName: 0,
      productPages: 0,
      categoryPages: 0,
      entries: [],
    })
  }

  const rows = await prisma.pageObservation.findMany({
    where: { auditRunId, status: 'observed', field: { startsWith: 'catalog.entry.' } },
    select: { pageId: true, field: true, value: true, method: true, sourcePath: true, fragment: true },
    take: 2000,
  })

  const productNamePages = await prisma.pageObservation.findMany({
    where: { auditRunId, status: 'observed', field: 'product.name', page: { pageType: 'product' } },
    select: { pageId: true },
  })

  return assessProductEvidence({
    companyName: run.companyName ?? '(company not recorded)',
    websiteUrl: run.startUrl,
    notReadReason: run.failureReason ?? (run.startUrl ? null : 'No website was resolved for this company.'),
    pagesFetched: run.pagesFetched,
    productPagesWithName: new Set(productNamePages.map((p) => p.pageId)).size,
    productPages: run.productPages,
    categoryPages: run.categoryPages,
    entries: entriesFromObservations(rows),
  })
}
