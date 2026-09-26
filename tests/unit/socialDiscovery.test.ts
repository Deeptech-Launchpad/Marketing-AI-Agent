import { describe, expect, it } from 'vitest'
import {
  discoverSocialProfiles,
  discoverSocialProfilesInText,
  firstPartyAssetUrls,
  looksLikeAppShell,
  readProfileUrl,
} from '../../src/intent/socialProfiles.js'
import { resolveCompanySource } from '../../src/crm/companySource.js'
import type { CrmCompany } from '../../src/crm/types.js'

// INTENT SIGNALS MUST NOT DEPEND ON THE WEBSITE LOADING.
//
// Social discovery and website availability are two different things, and
// conflating them produced two separate false results on real companies:
//
//   1. A company whose website is unreachable, or which has no website at all,
//      still has the social profiles its NXT Sales record holds. Those must be
//      read. DANUC Hardware Store has no website — its CRM website column
//      holds "facebook.com" — and its real Facebook page is on the record.
//
//   2. A company whose website renders itself in the browser serves an empty
//      shell, so there are no anchors to read. ultratapsmt.com serves 640
//      bytes: one <div id="root"> and a script. Link discovery found nothing
//      and the company was reported as publishing no social presence at all —
//      while its Facebook page sat inside the bundle its own shell loads.
//
// WHAT MUST STILL NEVER HAPPEN. No platform is searched by company name. Only
// URLs the company itself published — on its own pages, in its own first-party
// assets, or on its own CRM record — are ever followed. A platform root, a
// share link, a login page and a platform script identify nobody and are
// rejected wherever they are found.

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'co_1',
    name: 'Acme Supplies',
    email: null,
    emails: [],
    phone: null,
    domain: 'acme.test',
    industry: null,
    country: null,
    cms: null,
    leadStatus: null,
    status: null,
    remarks: null,
    notes: null,
    endPdpUrl: null,
    contactPersons: [],
    linkedProfiles: [],
    ownerId: null,
    ownerName: null,
    dealCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as CrmCompany

const page = (body: string) => `<html><body>${body}</body></html>`
const urls = (found: Array<{ url: string }>) => found.map((f) => f.url)

// ── 1-3. A reachable website that publishes its profiles ──────────────────

describe('links published on the company own website', () => {
  it('finds a Facebook page in the footer', () => {
    const found = discoverSocialProfiles({
      html: page('<footer><a href="https://www.facebook.com/acmesupplies/">Follow us</a></footer>'),
      pageUrl: 'https://acme.test/',
    })
    expect(urls(found)).toEqual(['https://facebook.com/acmesupplies'])
    expect(found[0]!.platformLabel).toBe('Facebook')
    expect(found[0]!.anchorText).toBe('Follow us')
  })

  it('finds a LinkedIn company page in the footer', () => {
    const found = discoverSocialProfiles({
      html: page('<footer><a href="https://www.linkedin.com/company/acme-supplies/">LinkedIn</a></footer>'),
      pageUrl: 'https://acme.test/',
    })
    expect(urls(found)).toEqual(['https://linkedin.com/company/acme-supplies'])
    expect(found[0]!.handle).toBe('acme-supplies')
  })

  it('finds an Instagram business profile', () => {
    const found = discoverSocialProfiles({
      html: page('<nav><a href="https://instagram.com/acmesupplies">Instagram</a></nav>'),
      pageUrl: 'https://acme.test/contact',
    })
    expect(urls(found)).toEqual(['https://instagram.com/acmesupplies'])
  })

  it('finds X and YouTube in the same header', () => {
    const found = discoverSocialProfiles({
      html: page(
        '<header><a href="https://x.com/acmesupplies">X</a>' +
          '<a href="https://www.youtube.com/@acmesupplies">YouTube</a></header>',
      ),
      pageUrl: 'https://acme.test/',
    })
    expect(urls(found).sort()).toEqual(['https://x.com/acmesupplies', 'https://youtube.com/@acmesupplies'])
  })

  it('cites the page the link was found on', () => {
    const found = discoverSocialProfiles({
      html: page('<a href="https://facebook.com/acme">f</a>'),
      pageUrl: 'https://acme.test/about-us',
    })
    expect(found[0]!.discoveredOn).toBe('https://acme.test/about-us')
  })
})

// ── 4-5. No usable website ────────────────────────────────────────────────

describe('a company whose website cannot be used', () => {
  // DANUC Hardware Store, verbatim: the website column holds a platform.
  const danuc = company({
    name: 'DANUC Hardware Store',
    domain: 'facebook.com',
    endPdpUrl: 'https://www.facebook.com/danucstore/',
  })

  it('still yields the social profile the CRM holds', () => {
    const source = resolveCompanySource(danuc)
    expect(source.websiteUrl).toBeNull()
    expect(source.socialSources.map((s) => s.url)).toEqual(['https://facebook.com/danucstore'])
  })

  it('reads that profile URL as a real profile', () => {
    const read = readProfileUrl(resolveCompanySource(danuc).socialSources[0]!.url)
    expect(read).toMatchObject({ platform: 'facebook', handle: 'danucstore' })
  })

  it('keeps CRM profiles regardless of whether a website exists', () => {
    // An unreachable website cannot remove what the record already holds: the
    // record is read before any page is fetched.
    const withSite = company({
      domain: 'acme.test',
      linkedProfiles: ['https://www.linkedin.com/company/acme-supplies/'],
    })
    const source = resolveCompanySource(withSite)
    expect(source.websiteUrl).toContain('acme.test')
    expect(source.socialSources.map((s) => s.platform)).toEqual(['linkedin'])
  })

  it('says plainly when the record holds neither', () => {
    const source = resolveCompanySource(company({ domain: null }))
    expect(source.kind).toBe('none')
    expect(source.socialSources).toEqual([])
    expect(source.reason).toContain('no website and no social profile')
  })
})

// ── 14-15. What identifies nobody ─────────────────────────────────────────

describe('a URL that identifies no company is never a profile', () => {
  it('rejects every platform root', () => {
    for (const root of [
      'https://facebook.com/',
      'https://www.linkedin.com',
      'https://instagram.com/',
      'https://x.com',
      'https://www.youtube.com/',
    ]) {
      expect(readProfileUrl(root), root).toBeNull()
    }
  })

  it('rejects share, login and intent URLs', () => {
    for (const url of [
      'https://www.facebook.com/sharer/sharer.php?u=https://acme.test',
      'https://www.facebook.com/share.php?u=x',
      'https://twitter.com/intent/tweet?url=https://acme.test',
      'https://www.linkedin.com/login',
      'https://www.linkedin.com/uas/login',
      'https://www.instagram.com/accounts/login/',
      'https://www.facebook.com/dialog/share',
    ]) {
      expect(readProfileUrl(url), url).toBeNull()
    }
  })

  it('rejects a platform script that merely looks like a handle', () => {
    // Found in a real company's own bundle beside its genuine page. The
    // "/<handle>" shape matches it, so it needs its own refusal.
    expect(readProfileUrl('https://www.facebook.com/photo.php')).toBeNull()
    expect(readProfileUrl('https://www.facebook.com/permalink.php?story_fbid=1')).toBeNull()
    // …but a real numeric-id profile still works.
    expect(readProfileUrl('https://www.facebook.com/profile.php?id=100064')).toMatchObject({
      platform: 'facebook',
    })
  })

  it('rejects a LinkedIn personal profile — this module collects companies', () => {
    expect(readProfileUrl('https://www.linkedin.com/in/lloyd-robertson-01759296')).toBeNull()
  })

  it('collects none of it from a page full of share buttons', () => {
    const found = discoverSocialProfiles({
      html: page(
        '<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>' +
          '<a href="https://twitter.com/intent/tweet">Tweet</a>' +
          '<a href="https://facebook.com/">Facebook</a>',
      ),
      pageUrl: 'https://acme.test/',
    })
    expect(found).toEqual([])
  })
})

// ── A site that renders itself in the browser ─────────────────────────────

describe('a JavaScript-rendered site still publishes its links', () => {
  // ultratapsmt.com's entire server response, reduced.
  const SHELL =
    '<!doctype html><html lang="en"><head><meta name="description" content="Premium taps." />' +
    '<title>UltraTaps</title><script type="module" crossorigin src="/assets/index-9v7InpYE.js"></script>' +
    '<link rel="stylesheet" href="/assets/index-BD3XAT6Z.css"></head><body><div id="root"></div></body></html>'

  it('recognises the shell for what it is', () => {
    expect(looksLikeAppShell(SHELL)).toBe(true)
  })

  it('does not mistake a small real page for a shell', () => {
    const small = page(
      '<h1>Acme Supplies</h1><p>We have supplied fasteners since 1974 across the south west.</p>' +
        '<a href="/contact">Contact</a><a href="/about">About</a><a href="/products">Products</a>' +
        '<script src="/app.js"></script>',
    )
    expect(looksLikeAppShell(small)).toBe(false)
  })

  it('takes only the company own same-origin assets', () => {
    const mixed =
      '<script src="/assets/index.js"></script>' +
      '<script src="https://cdn.other.test/analytics.js"></script>' +
      '<script src="https://www.googletagmanager.com/gtag/js"></script>'
    expect(firstPartyAssetUrls(mixed, 'https://acme.test/')).toEqual(['https://acme.test/assets/index.js'])
  })

  it('is bounded, so a page of scripts cannot become a crawl', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<script src="/a${i}.js"></script>`).join('')
    expect(firstPartyAssetUrls(many, 'https://acme.test/', 3)).toHaveLength(3)
  })

  it('finds the profile the bundle publishes, and rejects the platform script beside it', () => {
    // Both of these were in one real bundle, in this order.
    const bundle =
      'const S={fb:"https://www.facebook.com/Ultrataps/",img:"https://www.facebook.com/photo.php"};' +
      'e.href="https://www.instagram.com/ultratapsmalta/";'
    const found = discoverSocialProfilesInText({ text: bundle, discoveredOn: 'https://ultratapsmt.com/' })
    expect(urls(found).sort()).toEqual([
      'https://facebook.com/Ultrataps',
      'https://instagram.com/ultratapsmalta',
    ])
    expect(urls(found)).not.toContain('https://facebook.com/photo.php')
  })

  it('trims the punctuation a minifier leaves on a URL', () => {
    const found = discoverSocialProfilesInText({
      text: 'a("https://facebook.com/acme"),b("https://x.com/acme");',
      discoveredOn: 'https://acme.test/',
    })
    expect(urls(found).sort()).toEqual(['https://facebook.com/acme', 'https://x.com/acme'])
  })

  it('attributes a bundle link to the page that loaded it', () => {
    const found = discoverSocialProfilesInText({
      text: '"https://facebook.com/acme"',
      discoveredOn: 'https://acme.test/',
    })
    expect(found[0]!.discoveredOn).toBe('https://acme.test/')
  })

  it('finds nothing in a bundle that publishes nothing', () => {
    const found = discoverSocialProfilesInText({
      text: 'const x=1;function y(){return "https://acme.test/api/products"}',
      discoveredOn: 'https://acme.test/',
    })
    expect(found).toEqual([])
  })
})

// ── 16. One company at a time ─────────────────────────────────────────────

describe('no cross-company leakage', () => {
  it('attributes every profile to the page it was read from', () => {
    const a = discoverSocialProfiles({
      html: page('<a href="https://facebook.com/alpha">a</a>'),
      pageUrl: 'https://alpha.test/',
    })
    const b = discoverSocialProfiles({
      html: page('<a href="https://facebook.com/beta">b</a>'),
      pageUrl: 'https://beta.test/',
    })
    expect(a[0]!.discoveredOn).toBe('https://alpha.test/')
    expect(b[0]!.discoveredOn).toBe('https://beta.test/')
    expect(urls(a)).not.toEqual(urls(b))
  })

  it('reads only the record it was given', () => {
    const alpha = resolveCompanySource(company({ id: 'co_a', linkedProfiles: ['https://facebook.com/alpha'] }))
    const beta = resolveCompanySource(company({ id: 'co_b', linkedProfiles: ['https://facebook.com/beta'] }))
    expect(alpha.socialSources[0]!.url).toBe('https://facebook.com/alpha')
    expect(beta.socialSources[0]!.url).toBe('https://facebook.com/beta')
  })
})

// ── 17-18. Nothing is invented ────────────────────────────────────────────

describe('nothing is constructed', () => {
  it('builds no profile URL from a company name', () => {
    const found = discoverSocialProfiles({
      html: page('<h1>Acme Supplies</h1><p>Find us on Facebook and LinkedIn!</p>'),
      pageUrl: 'https://acme.test/',
    })
    // The page NAMES the platforms and links to neither. That is nothing.
    expect(found).toEqual([])
  })

  it('returns only URLs that were in the input', () => {
    const html = page('<a href="https://facebook.com/acmesupplies/">f</a>')
    const found = discoverSocialProfiles({ html, pageUrl: 'https://acme.test/' })
    expect(html).toContain(found[0]!.handle)
  })

  it('yields a profile and never a person or a contact field', () => {
    const found = discoverSocialProfiles({
      html: page('<a href="https://facebook.com/acme">Email us at info@acme.test — ask for Dana</a>'),
      pageUrl: 'https://acme.test/',
    })
    // The anchor text is kept VERBATIM, because it is the company's own
    // published wording and it is evidence for the link. What must never
    // happen is that any of it becomes an identity or a contact detail: a
    // profile carries a platform, a URL and a handle, and nothing else.
    expect(found[0]!.anchorText).toContain('info@acme.test')
    expect(found[0]!.url).toBe('https://facebook.com/acme')
    expect(found[0]!.handle).toBe('acme')
    expect(Object.keys(found[0]!).sort()).toEqual([
      'anchorText',
      'discoveredOn',
      'handle',
      'platform',
      'platformLabel',
      'url',
    ])
  })
})
