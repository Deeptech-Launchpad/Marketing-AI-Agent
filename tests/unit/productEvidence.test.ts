import { describe, expect, it } from 'vitest'
import {
  assessProductEvidence,
  entriesFromObservations,
  type ProductEvidenceInput,
} from '../../src/websiteaudit/productEvidence.js'
import type { CatalogEntry } from '../../src/websiteaudit/catalogEvidence.js'

// FOUR SITUATIONS THAT WERE PRINTING ONE SENTENCE.
//
// Every surface reduced a run to "is there a product record". Everything that
// was not one printed "No product page carried enough published data", which
// covered:
//
//   A  we never read the site           — nothing is known
//   B  we read it, it names nothing     — the finding worth selling on
//   C  it names products, no product page — a real customer with a catalogue
//   D  a product page was read
//
// A and B are OPPOSITES: one is an absence of evidence, the other is evidence
// of an absence. Saying the same thing for both is not a wording problem, it
// is a claim we have no grounds for. These tests hold the four apart.

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name: 'GRAB RAIL',
  detailUrl: null,
  imageUrl: 'https://unicaremalta.com/media/RS972XX.jpg',
  imageFileName: 'RS972XX.jpg',
  strength: 'image_alt',
  method: 'dom_heuristic',
  sourcePath: 'img[alt]',
  fragment: '<img alt="GRAB RAIL">',
  ...over,
})

const input = (over: Partial<ProductEvidenceInput> = {}): ProductEvidenceInput => ({
  companyName: 'Unicare Malta',
  websiteUrl: 'https://www.unicaremalta.com',
  notReadReason: null,
  pagesFetched: 15,
  productPagesWithName: 0,
  productPages: 0,
  categoryPages: 5,
  entries: [],
  ...over,
})

// ── A. Never read ─────────────────────────────────────────────────────────

describe('A — the website was not read', () => {
  const a = assessProductEvidence(
    input({ websiteUrl: null, pagesFetched: 0, categoryPages: 0, notReadReason: 'No website is recorded for this company.' }),
  )

  it('is state A, and offers no tier', () => {
    expect(a.stateCode).toBe('A')
    expect(a.state).toBe('website_not_read')
    expect(a.tier).toBe(0)
  })

  it('carries the reason it was not read', () => {
    expect(a.detail).toContain('No website is recorded for this company.')
  })

  it('refuses to claim the company has no products', () => {
    // The distinction the whole module exists for.
    expect(a.detail).toMatch(/absence of evidence/i)
    expect(a.headline).not.toMatch(/no product/i)
  })

  it('is state A even when a URL exists but nothing was fetched', () => {
    expect(assessProductEvidence(input({ pagesFetched: 0, notReadReason: 'The homepage could not be fetched.' })).stateCode).toBe('A')
  })
})

// ── B. Read, and genuinely empty ──────────────────────────────────────────

describe('B — read, and the site names nothing it sells', () => {
  const b = assessProductEvidence(input({ entries: [] }))

  it('is state B, and offers no tier', () => {
    expect(b.stateCode).toBe('B')
    expect(b.tier).toBe(0)
  })

  it('says how much was read, so the claim is grounded', () => {
    expect(b.detail).toContain('15 page(s)')
    expect(b.detail).toContain('5 catalogue page(s)')
  })

  it('states it as a finding rather than as a shortfall of ours', () => {
    expect(b.detail).toMatch(/nothing published to show/i)
    expect(b.detail).toMatch(/No example has been invented/i)
  })

  it('does not read like A', () => {
    const a = assessProductEvidence(input({ websiteUrl: null, pagesFetched: 0, notReadReason: 'x' }))
    expect(b.headline).not.toBe(a.headline)
    expect(b.detail).not.toBe(a.detail)
  })
})

// ── C. The Unicare case ───────────────────────────────────────────────────

describe('C — products are named, but no product page is published', () => {
  const c = assessProductEvidence(
    input({
      entries: [
        entry({ name: 'GRAB RAIL' }),
        entry({ name: 'GRAB RAIL LOOPED', imageFileName: 'H3301.jpg' }),
        entry({ name: 'GRAB RAIL SCREWS STAINLESS STEEL', imageFileName: 'GRS.jpeg' }),
        entry({ name: 'GRAB RAIL STAINLESS STEEL', imageFileName: '170XX.jpeg' }),
      ],
    }),
  )

  it('is state C', () => {
    expect(c.stateCode).toBe('C')
    expect(c.state).toBe('product_candidate')
  })

  it('falls to tier 3 when the only evidence is alt text, and says so', () => {
    expect(c.tier).toBe(3)
    expect(c.tierLabel).toBe('Built from observed catalogue evidence — not a dedicated product page')
  })

  it('names the products it found, as evidence a reader can check', () => {
    expect(c.detail).toContain('"GRAB RAIL"')
    expect(c.detail).toContain('1 other')
    expect(c.entries).toHaveLength(4)
  })

  it('explains where the names came from', () => {
    expect(c.detail).toMatch(/image alt text/i)
  })

  it('never says the company has no products', () => {
    expect(c.headline).toContain('names 4 product(s)')
    expect(c.detail).toMatch(/Nothing below has been invented/i)
  })

  it('rises to tier 2 when the catalogue page links the products by name', () => {
    const t2 = assessProductEvidence(
      input({ entries: [entry({ name: 'M8 Hex Bolt', strength: 'linked', detailUrl: 'https://acme.test/p/m8' })] }),
    )
    expect(t2.tier).toBe(2)
    expect(t2.tierLabel).toBe('A catalogue listing published on their website')
  })

  it('rises to tier 2 for a named grid entry with no link', () => {
    expect(assessProductEvidence(input({ entries: [entry({ strength: 'named' })] })).tier).toBe(2)
  })

  it('puts the strongest evidence first whatever order it arrives in', () => {
    const mixed = assessProductEvidence(
      input({ entries: [entry({ name: 'Weak' }), entry({ name: 'Strong', strength: 'linked' })] }),
    )
    expect(mixed.entries.map((e) => e.name)).toEqual(['Strong', 'Weak'])
  })
})

// ── D. A real product page ────────────────────────────────────────────────

describe('D — a dedicated product page was read', () => {
  const d = assessProductEvidence(input({ productPagesWithName: 3, productPages: 3 }))

  it('is state D at tier 1', () => {
    expect(d.stateCode).toBe('D')
    expect(d.tier).toBe(1)
    expect(d.tierLabel).toBe('Their own product page')
  })

  it('outranks catalogue evidence, which is weaker by definition', () => {
    const both = assessProductEvidence(input({ productPagesWithName: 1, entries: [entry()] }))
    expect(both.stateCode).toBe('D')
  })

  it('is not reached by a product page that published no name', () => {
    // pageType said product; the page published nothing to build a record on.
    expect(assessProductEvidence(input({ productPages: 4, productPagesWithName: 0 })).stateCode).toBe('B')
  })
})

// ── Reassembling the stored rows ──────────────────────────────────────────

describe('entries survive the round trip through observation rows', () => {
  const rows = [
    { pageId: 'p1', field: 'catalog.entry.0.name', value: 'GRAB RAIL', method: 'dom_heuristic', sourcePath: 'img[alt]', fragment: '<img>' },
    { pageId: 'p1', field: 'catalog.entry.0.strength', value: 'image_alt', method: 'dom_heuristic', sourcePath: 'img[alt]', fragment: 'x' },
    { pageId: 'p1', field: 'catalog.entry.0.image', value: 'https://u.test/RS972XX.jpg', method: 'dom_heuristic', sourcePath: 'img[alt]', fragment: 'x' },
    { pageId: 'p1', field: 'catalog.entry.0.imageFileName', value: 'RS972XX.jpg', method: 'dom_heuristic', sourcePath: 'img[alt]', fragment: 'x' },
    { pageId: 'p2', field: 'catalog.entry.0.name', value: 'GRAB RAIL LOOPED', method: 'dom_heuristic', sourcePath: 'img[alt]', fragment: '<img>' },
    { pageId: 'p2', field: 'catalog.entry.0.strength', value: 'image_alt', method: 'dom_heuristic', sourcePath: 'img[alt]', fragment: 'x' },
  ]

  it('keeps entries from different pages apart despite sharing an index', () => {
    const entries = entriesFromObservations(rows)
    expect(entries.map((e) => e.name)).toEqual(['GRAB RAIL', 'GRAB RAIL LOOPED'])
  })

  it('carries the image and the file name back', () => {
    const first = entriesFromObservations(rows)[0]!
    expect(first.imageUrl).toBe('https://u.test/RS972XX.jpg')
    expect(first.imageFileName).toBe('RS972XX.jpg')
    expect(first.strength).toBe('image_alt')
  })

  it('de-duplicates the same product seen on several pages', () => {
    const dup = [...rows, { ...rows[0]!, pageId: 'p3' }, { ...rows[1]!, pageId: 'p3' }]
    expect(entriesFromObservations(dup)).toHaveLength(2)
  })

  it('ignores rows that are not catalogue entries', () => {
    expect(
      entriesFromObservations([
        { pageId: 'p1', field: 'product.name', value: 'Something', method: null, sourcePath: null, fragment: null },
        { pageId: 'p1', field: 'catalog.entryish', value: 'no', method: null, sourcePath: null, fragment: null },
      ]),
    ).toEqual([])
  })
})
