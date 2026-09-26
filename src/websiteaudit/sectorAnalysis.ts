import { prisma } from '../platform/db.js'
import { RECORD_FIELDS } from './enrichedRecord.js'

// WHAT THIS COMPANY ACTUALLY SELLS — read from its own site, never assumed.
//
// The customer report's category page must describe THIS customer. A bathroom
// merchant and a laboratory supplier need different fields discussed, and the
// only honest source for which is what their own catalogue says.
//
// So the sectors below come from three real signals, in order of how strongly
// the site is asserting them:
//
//   category.name        a category page naming itself
//   page.breadcrumbs     the site's own navigation path
//   product.category     a product declaring where it belongs
//
// Nothing is inferred from the domain, the company name, or an industry list.
// A site that publishes no categories yields none, and the report says so
// rather than reaching for generic sector copy.

export interface SectorGap {
  field: string
  label: string
  /** How many inspected product pages published this field. */
  published: number
  /** How many were inspected. */
  sample: number
}

export interface Sector {
  /** The category as the site writes it. Never re-worded. */
  name: string
  /** How many inspected pages placed themselves here. */
  pageCount: number
  /** Where the name was read from, so a reader can check it. */
  evidenceUrls: string[]
  /** Which structured fields are missing across this customer's product pages. */
  gaps: SectorGap[]
}

export interface SectorAnalysis {
  sectors: Sector[]
  /** Product pages inspected across the whole run — the denominator for gaps. */
  productPagesInspected: number
  /** Field coverage across the whole catalogue sample, worst first. */
  catalogueGaps: SectorGap[]
  /** Said plainly when the site published nothing to categorise by. */
  note: string
}

/**
 * Trims a breadcrumb or category string to the part that names a category.
 *
 * `onProductPage` matters: on a product page the LAST crumb is the product
 * itself, so taking it would list "HIRE OF ECG MACHINE 100L" as a category.
 * The crumb before it is the category the product sits in.
 */
function cleanName(raw: string, onProductPage: boolean): string | null {
  const parts = raw
    .split(/\s*(?:›|»|>|\/|\||→)\s*/)
    .map((p) => p.trim())
    .filter(Boolean)

  const candidates = parts.filter((p) => !/^(home|shop|products?|catalogue|catalog)$/i.test(p))
  if (candidates.length === 0) return null

  // On a product page the last crumb is the product. If it is the ONLY crumb
  // left, the trail named no category at all — "Home > Shop > <product>" — and
  // the honest answer is none, not the product's own name.
  if (onProductPage && candidates.length < 2) return null
  const pick = onProductPage
    ? candidates[candidates.length - 2]!
    : candidates[candidates.length - 1]!

  // Category pages are frequently titled "<Category> Archives - <Site name>"
  // or "<Category> | <Site name>". The suffix is the site's, not a category.
  const name = pick
    .replace(/[\s\u00a0]*Archives\b.*$/i, '')
    .replace(/\s+[-–—|]\s+[^-–—|]{3,}$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (name.length < 2 || name.length > 60) return null
  // A long identifier is a product code, not a category name.
  if (/\d{4,}/.test(name)) return null
  return name
}

/** Two names for the same thing: "Services" and "SERVICES", or one inside the other. */
function sameSector(a: string, b: string): boolean {
  const x = a.toLowerCase().trim()
  const y = b.toLowerCase().trim()
  return x === y || x.startsWith(y) || y.startsWith(x)
}

/**
 * Reads this company's sectors and field gaps from ONE audit run.
 *
 * Scoped to the run, so a report can never describe another company's
 * catalogue — the run belongs to exactly one company.
 */
export async function analyseSectors(auditRunId: string, maxSectors = 5): Promise<SectorAnalysis> {
  const pages = await prisma.auditedPage.findMany({
    where: { auditRunId, outcome: 'fetched' },
    select: { id: true, pageType: true, requestedUrl: true, finalUrl: true },
  })
  const urlOf = new Map(pages.map((p) => [p.id, p.finalUrl ?? p.requestedUrl]))
  const productPageIds = pages.filter((p) => p.pageType === 'product').map((p) => p.id)

  const observations = await prisma.pageObservation.findMany({
    where: {
      auditRunId,
      status: 'observed',
      field: { in: ['category.name', 'page.breadcrumbs', 'product.category'] },
    },
    select: { pageId: true, field: true, value: true },
  })

  // ── Sectors, as the site names them ────────────────────────────────────
  const typeOf = new Map(pages.map((p) => [p.id, p.pageType]))
  const byName = new Map<string, { pages: Set<string>; urls: Set<string> }>()
  for (const o of observations) {
    if (!o.value) continue
    const name = cleanName(o.value, typeOf.get(o.pageId) === 'product')
    if (!name) continue
    // Fold variants of the same category together, keeping the SHORTER name:
    // "SERVICES" and "SERVICES Archives" are one category, and the shorter form
    // is what the site actually calls it.
    const existing = [...byName.keys()].find((k) => sameSector(k, name))
    let key = existing ?? name
    if (existing && name.length < existing.length) {
      byName.set(name, byName.get(existing)!)
      byName.delete(existing)
      key = name
    }
    const entry = byName.get(key) ?? { pages: new Set<string>(), urls: new Set<string>() }
    entry.pages.add(o.pageId)
    const url = urlOf.get(o.pageId)
    if (url) entry.urls.add(url)
    byName.set(key, entry)
  }

  // ── Field coverage across the product sample ───────────────────────────
  const productObservations = productPageIds.length
    ? await prisma.pageObservation.findMany({
        where: { pageId: { in: productPageIds } },
        select: { pageId: true, field: true, status: true, value: true },
      })
    : []

  const publishedByField = new Map<string, Set<string>>()
  for (const o of productObservations) {
    if (o.status !== 'observed' || !o.value?.trim()) continue
    const set = publishedByField.get(o.field) ?? new Set<string>()
    set.add(o.pageId)
    publishedByField.set(o.field, set)
  }

  const sample = productPageIds.length
  const catalogueGaps: SectorGap[] = RECORD_FIELDS.map(({ field, label }) => ({
    field,
    label,
    published: publishedByField.get(field)?.size ?? 0,
    sample,
  }))
    // Worst coverage first: those are the ones worth a customer's attention.
    .sort((a, b) => a.published - b.published || a.label.localeCompare(b.label))

  // Gaps are catalogue-wide; a per-sector split would need more product pages
  // per sector than a bounded crawl provides, and inventing one would be a
  // number the audit cannot defend.
  const sectors: Sector[] = [...byName.entries()]
    .map(([name, e]) => ({
      name,
      pageCount: e.pages.size,
      evidenceUrls: [...e.urls].slice(0, 3),
      gaps: catalogueGaps.filter((g) => g.published < g.sample).slice(0, 5),
    }))
    .sort((a, b) => b.pageCount - a.pageCount)
    .slice(0, maxSectors)

  const note =
    sectors.length === 0
      ? 'The inspected pages published no category names or breadcrumb navigation, so no sector breakdown could be read from this website.'
      : `${sectors.length} category area(s) were read from this website's own navigation and category pages.`

  return { sectors, productPagesInspected: sample, catalogueGaps, note }
}
