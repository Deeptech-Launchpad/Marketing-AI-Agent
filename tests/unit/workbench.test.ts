import { describe, expect, it } from 'vitest'
import {
  buildComparison,
  buildStructuredData,
  categoryFromBreadcrumbs,
  type ObservationInput,
} from '../../src/workbench/improve.js'
import { extractTheme, safeColor, safeFontStack, safeImageUrl } from '../../src/workbench/themeExtractor.js'
import { esc, PUBLIC_CSP, renderNoProduct, renderRegistration, renderWorkbench } from '../../src/workbench/render.js'
import { hashSession, readCookie, sessionCookieValue, tokensMatch, workbenchUrl } from '../../src/workbench/links.js'
import { DISPLAY_FIELDS, EMPTY_STATE, NEUTRAL_THEME } from '../../src/workbench/types.js'

// TASK #981 — the Workbench's deterministic core and its security boundary.
//
// The assertions that matter most are the refusals: no invented specification,
// no unvalidated colour reaching CSS, no executable content reaching the page.
// A customer-facing artifact built from a prospect's own website is the one
// place in this platform where a mistake is visible to the person being sold to.

let n = 0
function obs(over: Partial<ObservationInput> = {}): ObservationInput {
  n++
  return {
    id: `obs_${n}`,
    field: 'product.name',
    status: 'observed',
    value: 'Pull Down (Center Pull) Towels - Multiple Options',
    sourcePath: 'itemprop="name"',
    fragment: '<h1 itemprop="name"> Pull Down (Center Pull) Towels - Multiple Options </h1>',
    ...over,
  }
}

/** The real 1st Ayd page: what was observed, and what was not. */
function realPageObservations(): ObservationInput[] {
  const observed: Array<[string, string, string]> = [
    ['product.name', 'Pull Down (Center Pull) Towels - Multiple Options', 'itemprop="name"'],
    ['product.sku', '1028', 'itemprop="sku"'],
    ['product.price', 'TBD', 'itemprop="price"'],
    ['product.imageCount', '24', '<img> elements'],
    ['page.breadcrumbs', 'Home > RAGS, WIPERS & PAPER > Paper Towels', 'breadcrumb container'],
    ['page.title', '1st Ayd Corporation. Pull Down (Center Pull) Towels', '<title>'],
  ]
  const absent = [
    'product.brand',
    'product.category',
    'product.description',
    'product.specifications',
    'product.attributes',
    'product.dimensions',
    'product.weight',
    'product.units',
    'product.availability',
    'product.currency',
    'product.gtin',
    'product.mpn',
    'product.documents',
  ]
  return [
    ...observed.map(([field, value, sourcePath]) =>
      obs({ field, value, sourcePath, fragment: `${sourcePath}: ${value}` }),
    ),
    ...absent.map((field) => obs({ field, status: 'not_observed', value: null, sourcePath: null, fragment: null })),
  ]
}

// ── DERIVE ─────────────────────────────────────────────────────────────────

describe('category derivation from breadcrumbs', () => {
  it('takes the last meaningful crumb', () => {
    expect(categoryFromBreadcrumbs('Home > RAGS, WIPERS & PAPER > Paper Towels', null)).toBe('Paper Towels')
  })

  it('title-cases a SHOUTED crumb', () => {
    expect(categoryFromBreadcrumbs('Home > RAGS, WIPERS & PAPER', null)).toBe('Rags, Wipers & Paper')
  })

  it('does not make a product its own category', () => {
    expect(categoryFromBreadcrumbs('Home > Fasteners > M12 Hex Bolt', 'M12 Hex Bolt')).toBe('Fasteners')
  })

  it('ignores the Home crumb', () => {
    expect(categoryFromBreadcrumbs('Home', null)).toBeNull()
  })

  it('returns null rather than guessing from an empty trail', () => {
    expect(categoryFromBreadcrumbs('', null)).toBeNull()
    expect(categoryFromBreadcrumbs('   >   ', null)).toBeNull()
  })
})

// ── RESTRUCTURE ────────────────────────────────────────────────────────────

describe('structured data assembly', () => {
  const fields = (pairs: Array<[string, string]>) =>
    new Map(pairs.map(([f, v]) => [f, obs({ field: f, value: v })]))

  it('includes only fields that were observed', () => {
    const r = buildStructuredData(fields([['product.name', 'Bolt'], ['product.sku', 'B-1']]), null)!
    expect(r.json).toEqual({ '@context': 'https://schema.org', '@type': 'Product', name: 'Bolt', sku: 'B-1' })
    expect(r.json).not.toHaveProperty('brand')
    expect(r.json).not.toHaveProperty('weight')
  })

  it('adds a derived category and records it as derived', () => {
    const r = buildStructuredData(fields([['product.name', 'Towels'], ['product.sku', '1028']]), 'Paper Towels')!
    expect(r.json.category).toBe('Paper Towels')
    expect(r.usedFields).toContain('product.category(derived)')
  })

  it('REFUSES to publish "TBD" as a machine-readable price', () => {
    // The audit correctly observed it — the page really does say TBD — but
    // emitting it as schema.org `price` would publish a machine-readable
    // falsehood to search engines.
    const r = buildStructuredData(fields([['product.name', 'Towels'], ['product.sku', '1028'], ['product.price', 'TBD']]), null)!
    expect(JSON.stringify(r.json)).not.toMatch(/TBD/)
    expect(r.json).not.toHaveProperty('offers')
  })

  it('publishes a genuine numeric price', () => {
    const r = buildStructuredData(fields([['product.name', 'Bolt'], ['product.price', '1.45']]), null)!
    expect((r.json.offers as Record<string, unknown>).price).toBe('1.45')
  })

  it('returns null when there is not enough to be worth showing', () => {
    expect(buildStructuredData(fields([['product.name', 'Bolt']]), null)).toBeNull()
  })
})

// ── THE COMPARISON, on the real page ───────────────────────────────────────

describe('BEFORE and AFTER built from the real 1st Ayd observations', () => {
  const result = buildComparison({
    pageUrl: 'https://1stayd.com/pull-down-center-pull-towels-multiple-options',
    observations: realPageObservations(),
  })
  const byField = new Map(result.fields.map((f) => [f.field, f]))

  it('carries every observed field into BEFORE', () => {
    expect(byField.get('product.name')!.before).toMatch(/Pull Down/)
    expect(byField.get('product.sku')!.before).toBe('1028')
    expect(byField.get('product.price')!.before).toBe('TBD')
  })

  it('derives the category the page never published as a field', () => {
    const c = byField.get('product.category')!
    expect(c.before).toBeNull()
    expect(c.after).toBe('Paper Towels')
    expect(c.delta).toBe('added')
    expect(c.provenance.kind).toBe('derived')
    expect(c.provenance.sourceField).toBe('page.breadcrumbs')
    expect(c.provenance.rule).toMatch(/breadcrumb trail published on this page/)
  })

  it('NEVER invents a value for an absent field', () => {
    for (const field of ['product.weight', 'product.dimensions', 'product.brand', 'product.specifications']) {
      const f = byField.get(field)!
      expect(f.before, field).toBeNull()
      expect(f.after, field).toBeNull()
      expect(f.delta, field).toBe('still_absent')
      expect(f.provenance.kind, field).toBe('not_present')
    }
  })

  it('marks restructured fields so the strongest improvement is visible', () => {
    expect(byField.get('product.sku')!.delta).toBe('restructured')
    expect(byField.get('product.sku')!.provenance.rule).toMatch(/machine-readable schema.org/)
  })

  it('every field carries provenance', () => {
    result.fields.forEach((f) => {
      expect(f.provenance.rule.length, f.field).toBeGreaterThan(10)
      if (f.before !== null) expect(f.provenance.sourceObservationId, f.field).toBeTruthy()
    })
  })

  it('counts the sample honestly and never as a percentage', () => {
    expect(result.totalCount).toBe(DISPLAY_FIELDS.length)
    expect(result.observedCount).toBe(4)
    expect(result.improvedCount).toBeGreaterThan(0)
  })

  it('produces business-language value points with no financial claim', () => {
    expect(result.valuePoints.length).toBeGreaterThan(0)
    expect(result.valuePoints.length).toBeLessThanOrEqual(4)
    const prose = result.valuePoints.map((v) => `${v.title} ${v.why}`).join(' ')
    expect(prose).not.toMatch(/%|revenue|ROI|\$|£|€/i)
  })

  it('produces nothing at all from an empty observation set', () => {
    const empty = buildComparison({ pageUrl: 'u', observations: [] })
    expect(empty.observedCount).toBe(0)
    expect(empty.structuredData).toBeNull()
    expect(empty.fields.every((f) => f.delta === 'still_absent')).toBe(true)
  })
})

// ── THEME SAFETY ───────────────────────────────────────────────────────────

describe('theme token validation', () => {
  it('accepts only hex literals as colours', () => {
    expect(safeColor('#1d4ed8')).toBe('#1d4ed8')
    expect(safeColor('#FFF')).toBe('#fff')
  })

  const hostileColors = [
    'red',
    'rgb(255,0,0)',
    'var(--x)',
    'expression(alert(1))',
    'url(javascript:alert(1))',
    '#fff;}body{display:none',
    '</style><script>alert(1)</script>',
  ]
  hostileColors.forEach((c) => {
    it(`REJECTS colour ${JSON.stringify(c.slice(0, 30))}`, () => {
      expect(safeColor(c)).toBeNull()
    })
  })

  it('emits only allowlisted font families', () => {
    expect(safeFontStack('"Open Sans", Helvetica, sans-serif')).toBe("'open sans', helvetica, sans-serif")
  })

  it('REJECTS a font declaration carrying a CSS escape', () => {
    // Not escaped — discarded. No character from the prospect page reaches CSS.
    expect(safeFontStack('Comic Sans;}body{display:none')).toBeNull()
    expect(safeFontStack('</style><script>alert(1)</script>')).toBeNull()
  })

  it('accepts only absolute http(s) image URLs with an image extension', () => {
    expect(safeImageUrl('/img/logo.png', 'https://acme.example/p/x')).toBe('https://acme.example/img/logo.png')
    expect(safeImageUrl('javascript:alert(1)', 'https://acme.example/')).toBeNull()
    expect(safeImageUrl('data:image/svg+xml,<svg onload=alert(1)>', 'https://acme.example/')).toBeNull()
    expect(safeImageUrl('https://acme.example/page.html', 'https://acme.example/')).toBeNull()
  })

  it('extracts a usable palette from real storefront markup', () => {
    const html = `<html><head><meta name="theme-color" content="#0b5394">
      <style>body{font-family:"Open Sans",Arial,sans-serif}</style></head>
      <body class="product-details-page"><img class="logo" src="/logo.png"></body></html>`
    const t = extractTheme(html, 'https://1stayd.example/p/x')
    expect(t.source).toBe('live_sample')
    expect(t.primary).toBe('#0b5394')
    expect(t.fontFamily).toMatch(/open sans/)
    expect(t.logoUrl).toBe('https://1stayd.example/logo.png')
    expect(t.layoutFamily).toBe('storefront-grid')
  })

  it('falls back to neutral values when a page offers nothing usable', () => {
    const t = extractTheme('<html><body>hello</body></html>', 'https://x.example/')
    expect(t.primary).toBe(NEUTRAL_THEME.primary)
    expect(t.fontFamily).toBe(NEUTRAL_THEME.fontFamily)
    expect(t.logoUrl).toBeNull()
  })

  it('rejects near-white and near-black as brand colours', () => {
    const t = extractTheme('<meta name="theme-color" content="#ffffff">', 'https://x.example/')
    expect(t.primary).toBe(NEUTRAL_THEME.primary)
  })
})

// ── RENDERING SAFETY ───────────────────────────────────────────────────────

describe('rendering', () => {
  const hostile = '<script>alert(1)</script>"><img src=x onerror=alert(2)>'

  const base = {
    companyName: hostile,
    websiteUrl: 'https://acme.example',
    productName: hostile,
    productPageUrl: 'https://acme.example/p/x',
    theme: NEUTRAL_THEME,
    fields: [
      {
        field: 'product.name',
        label: 'Product name',
        before: hostile,
        after: hostile,
        delta: 'unchanged' as const,
        headline: true,
        provenance: {
          kind: 'unchanged' as const,
          sourceObservationId: 'obs_1',
          sourceField: 'product.name',
          sourceUrl: 'https://acme.example/p/x',
          sourcePath: hostile,
          sourceFragment: hostile,
          rule: 'Present on the audited page.',
        },
      },
    ],
    valuePoints: [{ title: hostile, why: hostile, fields: [] }],
    structuredData: { name: hostile },
    observedFieldCount: 1,
    totalFieldCount: 16,
    improvedFieldCount: 0,
    auditDate: '2026-08-27',
    showEvidence: true,
  }

  it('escapes every hostile value it is given', () => {
    const html = renderWorkbench(base)

    // The property that matters is that no injected TAG survives. The string
    // "onerror=alert(2)" does appear — inside "&lt;img src=x onerror=alert(2)&gt;",
    // where it is inert text — so asserting on that substring would be
    // asserting the wrong thing and would fail on correctly escaped output.
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img\s+src=x/i)
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    expect(html).toMatch(/&lt;img src=x onerror=alert\(2\)&gt;/)

    // No unescaped angle bracket from the payload reaches an attribute either.
    expect(html).not.toMatch(/"><img/)
  })

  it('ships a CSP that permits no script execution at all', () => {
    // Escaping is the second line. The first is that there is no script context.
    expect(PUBLIC_CSP).not.toMatch(/script-src/)
    expect(PUBLIC_CSP).toMatch(/default-src 'none'/)
    expect(PUBLIC_CSP).toMatch(/frame-ancestors 'none'/)
  })

  it('emits no <script> tag anywhere in any page', () => {
    const pages = [
      renderWorkbench(base),
      renderRegistration({ companyName: hostile, theme: NEUTRAL_THEME, token: 'abc', productName: hostile }),
      renderNoProduct({ companyName: hostile, theme: NEUTRAL_THEME, reason: hostile }),
    ]
    pages.forEach((p) => expect(p).not.toMatch(/<script/i))
  })

  it('marks every page noindex', () => {
    expect(renderWorkbench(base)).toMatch(/name="robots" content="noindex/)
  })

  it('shows the honest empty state for an absent field', () => {
    const html = renderWorkbench({
      ...base,
      fields: [
        {
          ...base.fields[0]!,
          field: 'product.weight',
          label: 'Weight',
          before: null,
          after: null,
          delta: 'still_absent' as const,
        },
      ],
    })
    expect(html).toContain(EMPTY_STATE)
  })

  it('states that the styling is an approximation, not a copy', () => {
    expect(renderWorkbench(base)).toMatch(/not a copy of the live website/)
  })

  it('carries the CTA', () => {
    expect(renderWorkbench(base)).toMatch(/walkthrough/i)
  })

  it('escapes correctly at the primitive level', () => {
    expect(esc('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
    expect(esc(null)).toBe('')
  })
})

// ── LINKS AND SESSIONS ─────────────────────────────────────────────────────

describe('links and sessions', () => {
  it('compares tokens in constant time and rejects a length mismatch', () => {
    expect(tokensMatch('abcdef', 'abcdef')).toBe(true)
    expect(tokensMatch('abcdef', 'abcdeg')).toBe(false)
    expect(tokensMatch('abc', 'abcdef')).toBe(false)
  })

  it('hashes a session token rather than storing it', () => {
    const h = hashSession('a-token')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain('a-token')
  })

  it('builds a public URL that carries no identifier but the token', () => {
    const url = workbenchUrl('TOKEN123')
    expect(url).toMatch(/\/workbench\/TOKEN123$/)
    expect(url).not.toMatch(/tenant|crm|run|report/i)
  })

  it('sets an HttpOnly, SameSite cookie scoped to the workbench path', () => {
    const c = sessionCookieValue('abc')
    expect(c).toMatch(/HttpOnly/)
    expect(c).toMatch(/SameSite=Lax/)
    expect(c).toMatch(/Path=\/workbench/)
  })

  it('reads one cookie out of a header without a parser', () => {
    expect(readCookie('a=1; wb_session=xyz; b=2', 'wb_session')).toBe('xyz')
    expect(readCookie('a=1', 'wb_session')).toBeNull()
    expect(readCookie(undefined, 'wb_session')).toBeNull()
  })
})

describe('customer-facing copy quality', () => {
  it('agrees the verb with a single-item list', () => {
    // "weight are not shown" appeared in the first real render. Customer-facing
    // copy is judged on whether a prospect trusts it, and a grammar slip in the
    // first paragraph costs more than a missing feature.
    const r = buildComparison({
      pageUrl: 'u',
      observations: [
        obs({ field: 'product.name', value: 'Gloves' }),
        obs({ field: 'product.sku', value: '1082S' }),
        obs({ field: 'product.specifications', value: 'Color: Orange' }),
        obs({ field: 'product.dimensions', value: '7 mil' }),
        obs({ field: 'product.attributes', value: 'Color: Orange' }),
        obs({ field: 'product.weight', status: 'not_observed', value: null }),
      ],
    })
    const specPoint = r.valuePoints.find((v) => v.title === 'Comparable specifications')
    if (specPoint) {
      expect(specPoint.why).toMatch(/weight is not shown/)
      expect(specPoint.why).not.toMatch(/weight are/)
    }
  })

  it('uses "and" rather than a bare comma join for the last item', () => {
    const r = buildComparison({
      pageUrl: 'u',
      observations: [
        obs({ field: 'product.name', value: 'Gloves' }),
        obs({ field: 'product.brand', status: 'not_observed', value: null }),
        obs({ field: 'product.mpn', status: 'not_observed', value: null }),
        obs({ field: 'product.gtin', status: 'not_observed', value: null }),
      ],
    })
    const point = r.valuePoints.find((v) => v.title === 'Findable by what buyers search for')!
    expect(point.why).toMatch(/ and /)
    expect(point.why).toMatch(/are not published/)
  })

  it('starts a generated title with a capital letter', () => {
    const r = buildComparison({
      pageUrl: 'u',
      observations: [
        obs({ field: 'product.name', value: 'Gloves' }),
        obs({ field: 'product.sku', value: '1082S' }),
        obs({ field: 'page.breadcrumbs', value: 'Home > Gloves > Nitrile Disposable Gloves' }),
        obs({ field: 'product.category', status: 'not_observed', value: null }),
      ],
    })
    r.valuePoints.forEach((v) => expect(v.title[0]).toBe(v.title[0]!.toUpperCase()))
  })
})
