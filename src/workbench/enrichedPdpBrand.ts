import { prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { captureAvailable, inlineImagesFromPage } from '../research/pageCapture.js'
import { fetchAsset, fetchPageRaw } from '../research/pageFetch.js'
import type { PdpEnrichment } from '../websiteaudit/pdpEnrichment.js'
import { resolveLink } from '../websiteaudit/urls.js'
import { renderEnrichedPdpHtml } from './enrichedPdpPage.js'
import { sampleTheme } from './themeExtractor.js'
import { NEUTRAL_THEME, type ThemeProfile } from './types.js'
import { sampleWebsiteShell, type WebsiteShell } from './websiteShell.js'
import { logoToneOf } from './logoTone.js'

// THE WORKBENCH "AFTER" PAGE, IN THE CUSTOMER'S OWN BRANDING.
//
// Before: the customer's website as it is.
// After:  the same company's website — its logo, navigation, colours, fonts and
//         footer — around our enriched product-page structure.
//
// The shell (logo, name, navigation, footer) is the capture the audit run
// already caches for the Before view. The colour needs one more step: most
// shops keep their palette in stylesheets rather than in the page, so a page
// that names no brand colour inline has its linked stylesheets read — through
// the same guarded fetcher, a few at most, as text — and the most repeated
// saturated colour is taken. The result is cached on the enriched record so a
// page view never re-fetches anything, and nothing here changes the Before
// view's own theme. A site whose colour cannot be read gets a neutral palette
// with the company's name — never AltiusNxt's branding.

const MAX_STYLESHEETS = 3

interface CachedBrand {
  primary: string | null
  checkedAt: string
}

/**
 * Pictures read from the customer's page, kept with the run.
 *
 * Resolved once, because reading them opens a browser. A shop whose image host
 * refuses outside requests, or whose theme embeds its pictures rather than
 * publishing them, is exactly the case this carries: without it the enriched
 * page shows broken image boxes in the Workbench and in the report.
 */
interface CachedImages {
  map: Record<string, string>
  readAt: string
}

/** Hue saturation of a hex colour, 0 (grey) to 1. */
function saturation(hex: string): number {
  const h = hex.slice(1)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return 0
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
}

function lightness(hex: string): number {
  const h = hex.slice(1)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
}

/**
 * The most repeated saturated colour in a body of CSS or markup.
 *
 * Greys, near-white and near-black are skipped: they are every site's text
 * and background, and say nothing about the brand.
 */
export function brandColourFrom(text: string): string | null {
  const counts = new Map<string, number>()
  const add = (hex: string, weight: number) => {
    const c = hex.toLowerCase()
    if (saturation(c) < 0.35) return
    const l = lightness(c)
    if (l < 0.18 || l > 0.8) return
    counts.set(c, (counts.get(c) ?? 0) + weight)
  }
  const coloursIn = (body: string, weight: number) => {
    for (const m of body.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
      const v = m[1]!
      add(`#${v.length === 3 ? v.split('').map((x) => x + x).join('') : v}`, weight)
    }
    for (const m of body.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) {
      add(`#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`, weight)
    }
  }

  // Weighted by WHERE a colour is used. Buttons, the header, navigation, links
  // and brand/primary tokens carry the brand; error, warning and sale styles
  // are a site's red and amber and say nothing about it.
  const BRAND = /btn|button|primary|accent|brand|theme|header|nav|menu|link|\ba\b|cta|logo|highlight/i
  const NOT_BRAND = /error|danger|alert|warn|invalid|required|success|sale|discount|badge|notice|toast|validation/i
  for (const rule of text.matchAll(/([^{}]{1,300})\{([^{}]{0,2000})\}/g)) {
    const selector = rule[1]!
    const body = rule[2]!
    if (NOT_BRAND.test(selector) || NOT_BRAND.test(body.slice(0, 80))) continue
    coloursIn(body, BRAND.test(selector) ? 4 : 1)
  }
  // Brand custom properties, wherever they are declared.
  for (const m of text.matchAll(/--[\w-]*(?:primary|brand|accent|theme)[\w-]*\s*:\s*([^;}]+)/gi)) coloursIn(m[1]!, 6)

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

async function readBrandColour(pageUrl: string): Promise<string | null> {
  const page = await fetchPageRaw(pageUrl)
  if (!page.ok || !page.html) return null
  const base = page.finalUrl ?? pageUrl
  const inline = brandColourFrom(page.html)
  const hrefs = [...page.html.matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => m[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1])
    .filter((h): h is string => Boolean(h))
    .map((h) => resolveLink(h, base))
    // Shared platform and library CSS is the same for every shop on that
    // platform; the site's own stylesheet is the one that carries its colours.
    .filter(
      (h): h is string =>
        Boolean(h) &&
        !/fonts\.googleapis|font-?awesome|bootstrap(\.min)?\.css|\/universal\/|component-definition|wp-includes|jquery|swiper|slick/i.test(h!),
    )
    .map((h) => {
      let score = 0
      try {
        if (new URL(h).hostname.replace(/^www\./, '') === new URL(base).hostname.replace(/^www\./, '')) score += 2
      } catch {
        /* resolved above */
      }
      if (/site|theme|custom|style|main|brand|global/i.test(h)) score += 3
      return { h, score }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.h)
    .slice(0, MAX_STYLESHEETS)
  let css = ''
  for (const href of hrefs) {
    const res = await fetchPageRaw(href, { as: 'asset' }).catch(() => null)
    if (res?.ok && res.html) css += `\n${res.html.slice(0, 400_000)}`
  }
  return brandColourFrom(`${css}\n${page.html}`) ?? inline
}

/** Image types a page can display and a PDF can carry. */
const PICTURE_TYPES = /^image\/(jpeg|jpg|png|gif|webp)$/
/** A single picture's byte ceiling before it is left as a link. */
const MAX_PICTURE_BYTES = 2_500_000

/**
 * The pictures the enriched page needs, as bytes.
 *
 * Two ways, cheapest first:
 *   1. fetch each one ourselves, through the guarded transport — this is what
 *      works for most sites, including image hosts on another domain;
 *   2. for whatever is left, open the customer's page in a browser and read
 *      the pictures from it — the rescue for a host that refuses outside
 *      requests, or a theme that embeds its pictures instead of publishing them.
 *
 * Anything still unresolved keeps its URL: on screen the browser will simply
 * ask for it, and a capture draws the honest placeholder instead.
 */
async function resolvePictures(pageUrl: string, urls: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const url of urls.slice(0, 8)) {
    const asset = await fetchAsset(url, { allowedTypes: PICTURE_TYPES, maxBytes: MAX_PICTURE_BYTES }).catch(() => null)
    if (asset?.ok && asset.bytes && asset.contentType) {
      out[url] = `data:${asset.contentType};base64,${asset.bytes.toString('base64')}`
    }
  }

  const missing = urls.filter((u) => !out[u])
  if (missing.length && captureAvailable().ok) {
    const fromPage = await inlineImagesFromPage(pageUrl, missing).catch(() => ({}))
    Object.assign(out, fromPage)
  }
  return out
}

/** Words that mark an image as furniture rather than a company's mark. */
const NOT_A_LOGO = /sprite|placeholder|spacer|pixel|blank|banner|badge|payment|flag|avatar|star|arrow|ie_warning|browser/i

/**
 * The company's own logo, found on their page.
 *
 * The header capture names a logo when the markup makes it obvious. Plenty of
 * sites do not: the file is called `0019099.png`, there is no <header> element,
 * and the only thing identifying it is the alt text — the company's own name —
 * or the fact that it is the picture inside the link back to the home page.
 * Both of those are read here, which is what makes a real logo appear instead
 * of the company's name set in type.
 *
 * A product picture is never accepted, however it is described.
 */
export function findLogoOnPage(
  html: string,
  pageUrl: string,
  companyName: string | null,
  productImages: string[] = [],
): string | null {
  const products = new Set(productImages)
  const nameWords = String(companyName ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^(ltd|limited|inc|corp|corporation|company|group|the|and|llc|plc|gmbh|srl|bv)$/.test(w))

  const candidates: Array<{ url: string; score: number; at: number }> = []
  const add = (raw: string | undefined, score: number, at: number) => {
    if (!raw) return
    const abs = resolveLink(raw.trim(), pageUrl)
    if (!abs || abs.startsWith('data:') || NOT_A_LOGO.test(abs)) return
    // A picture the page reader listed among the product photos is normally not
    // a logo — except when the markup puts it inside the link home, which is
    // the masthead and settles it. Some readers pick the masthead up as a
    // product photo precisely because the file is named like one.
    if (products.has(abs) && score < 6) return
    candidates.push({ url: abs, score, at })
  }

  // The picture inside the link home — the masthead logo on most templates.
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["'](?:\/|[^"']*:\/\/[^/"']+\/?)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const img = m[1]?.match(/<img\b[^>]*>/i)?.[0]
    if (img && !NOT_A_LOGO.test(img)) add(srcOf(img), 6, m.index ?? 0)
  }

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const at = m.index ?? 0
    if (NOT_A_LOGO.test(tag)) continue
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase() ?? ''
    // Its alt text IS the company's name.
    if (nameWords.length && nameWords.every((w) => alt.includes(w))) add(srcOf(tag), 5, at)
    // Or it says so itself.
    if (/logo|brand|wordmark|masthead/i.test(tag)) add(srcOf(tag), 4, at)
  }

  if (!candidates.length) return null
  // Best evidence first; among equals, the one nearest the top of the page.
  candidates.sort((a, b) => b.score - a.score || a.at - b.at)
  return candidates[0]!.url
}

/**
 * Site furniture a page reader collects along with the product photographs.
 *
 * A reader takes every <img> the page carries, so a shop whose markup puts the
 * search, sign-in and basket icons in the product area hands us those too —
 * and the gallery then opens on a 32-pixel magnifying glass instead of the
 * product. Whole words only, and only words no shop sells: `cart.png` goes,
 * `button-head-screw.jpg` stays, because a fastener supplier sells those. What
 * the names miss, the size rule below catches.
 */
const NOT_A_PRODUCT =
  /(^|[/_-])(search|sign-?in|log-?in|register|account|cart|basket|wishlist|compare|document|pdf|icons?|sprite|spacer|blank|pixel|placeholder|loader|loading|spinner|arrow|chevron|rating|payment|visa|mastercard|paypal|social|facebook|twitter|instagram|linkedin|youtube|pinterest|whatsapp|logo|wordmark|banner|menu|burger)([/_.-]|$)/i

/** Bytes below which a picture is an interface icon, not a product photograph. */
const TINY_PICTURE = 3_000

/**
 * The product's own photographs, out of everything the page reader collected.
 *
 * Two readings, both generic: what the file is called, and — once we hold the
 * bytes — how big it actually is. Neither is allowed to empty the gallery: if
 * a rule would leave nothing, the pictures are left as they were, because a
 * page with the wrong picture still beats a page with none.
 */
export function productPicturesOnly(images: string[], inlined: Record<string, string> = {}): string[] {
  const path = (u: string) => {
    try {
      return new URL(u).pathname
    } catch {
      return u
    }
  }
  const named = images.filter((u) => !NOT_A_PRODUCT.test(path(u)))
  const kept = named.length ? named : images
  const big = kept.filter((u) => {
    const held = inlined[u]
    if (!held) return true
    const bytes = Math.floor(((held.length - held.indexOf(',') - 1) * 3) / 4)
    return bytes >= TINY_PICTURE
  })
  return big.length ? big : kept
}

/** The address an <img> tag actually loads, lazy-loading attributes included. */
function srcOf(tag: string): string | undefined {
  for (const attr of ['data-original', 'data-src', 'data-lazy-src', 'src', 'srcset']) {
    const v = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]
    if (v && !v.startsWith('data:')) return v.split(',')[0]!.trim().split(/\s+/)[0]
  }
  return undefined
}

/**
 * How the After page is drawn today.
 *
 * A run photographed under an older recipe still holds that photograph, and
 * the report would then show a page the Workbench no longer renders. Raising
 * this number retakes every stored picture once, on the next report.
 *
 *   1 — the first branded page
 *   2 — the company's own logo in the masthead, and out of the gallery
 *   3 — the gallery holds product photographs only, and a light logo gets the
 *       dark plate its own site gives it
 */
export const AFTER_PAGE_RECIPE = 3

export async function brandedEnrichedPdpHtml(
  runId: string,
  opts: { forCapture?: boolean } = {},
): Promise<string | null> {
  const run = await prisma.websiteAuditRun.findUnique({
    where: { id: runId },
    select: { id: true, companyName: true, pdpEnrichment: true, websiteShell: true, pageTheme: true },
  })
  const companyName = run?.companyName ?? null
  const enrichment = run?.pdpEnrichment as unknown as (PdpEnrichment & { brand?: CachedBrand }) | null
  if (!run || !enrichment?.enriched) return null

  let shell = run.websiteShell as unknown as WebsiteShell | null
  let theme = run.pageTheme as unknown as ThemeProfile | null
  try {
    if (!shell || !theme) {
      ;[shell, theme] = await Promise.all([sampleWebsiteShell(enrichment.source.url), sampleTheme(enrichment.source.url)])
      await prisma.websiteAuditRun.update({
        where: { id: run.id },
        data: { websiteShell: shell as never, pageTheme: theme as never },
      })
    }

    // The page itself named no brand colour: read it from the stylesheets once.
    const themeFoundColour = theme?.source === 'live_sample' && theme.primary !== NEUTRAL_THEME.primary
    let brand = enrichment.brand
    if (!themeFoundColour && !brand) {
      brand = { primary: await readBrandColour(enrichment.source.url), checkedAt: new Date().toISOString() }
      await prisma.websiteAuditRun.update({
        where: { id: run.id },
        data: { pdpEnrichment: { ...enrichment, brand } as never },
      })
    }
    if (!themeFoundColour && brand?.primary) {
      theme = { ...(theme ?? NEUTRAL_THEME), source: 'live_sample', primary: brand.primary }
    }
  } catch (err) {
    logger.info({ runId, err: (err as Error).message }, 'branding not fully captured; the After page uses what was read')
  }

  // THE LOGO, when the header capture named none.
  // Only a logo that was actually found is remembered. A page that gave us
  // none today — markup we could not read, a host that refused us — is asked
  // again next time rather than remembered as having no logo, and nothing is
  // written onto the run that would make the next render skip the search.
  const marks = enrichment as { logo?: { url: string; foundAt: string } }
  if (!shell?.logoUrl && !marks.logo?.url) {
    try {
      const page = await fetchPageRaw(enrichment.source.url)
      const found = page.ok && page.html
        ? findLogoOnPage(page.html, page.finalUrl ?? enrichment.source.url, companyName, enrichment.enriched?.images ?? [])
        : null
      if (found) {
        marks.logo = { url: found, foundAt: new Date().toISOString() }
        await prisma.websiteAuditRun.update({
          where: { id: run.id },
          data: { pdpEnrichment: { ...enrichment, logo: marks.logo } as never },
        })
      } else {
        delete marks.logo
      }
    } catch (err) {
      logger.info({ runId, err: (err as Error).message }, 'no logo found on the page; the name is set in type')
      delete marks.logo
    }
  }
  if (!shell?.logoUrl && marks.logo?.url) {
    shell = { ...(shell ?? ({} as WebsiteShell)), logoUrl: marks.logo.url }
  }

  // The product pictures and the logo, as the customer's own page shows them.
  // Only what the gallery will actually draw is fetched, so a page whose icons
  // came along with the photographs costs no extra requests.
  let inlineImages = (enrichment as { inlineImages?: CachedImages }).inlineImages
  const collected = enrichment.enriched?.images ?? []
  const wanted = [shell?.logoUrl, ...productPicturesOnly(collected)].filter(
    (u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u),
  )
  // A cache filled before the logo was known holds the product pictures and
  // nothing else, so only what is still missing is fetched and merged in.
  const missing = wanted.filter((u) => !inlineImages?.map[u])
  if (!inlineImages || missing.length > 0) {
    try {
      const fresh = missing.length ? await resolvePictures(enrichment.source.url, missing) : {}
      const map = { ...(inlineImages?.map ?? {}), ...fresh }
      inlineImages = { map, readAt: new Date().toISOString() }
      // Only a result worth keeping is kept. A site that refused us today —
      // some hosts rate-limit, some block for a while — must be asked again
      // next time rather than remembered as having no pictures.
      if (Object.keys(fresh).length > 0 || wanted.length === 0) {
        await prisma.websiteAuditRun.update({
          where: { id: run.id },
          data: { pdpEnrichment: { ...enrichment, inlineImages } as never },
        })
      }
    } catch (err) {
      logger.info({ runId, err: (err as Error).message }, 'page pictures not read; the enriched page keeps its links')
    }
  }

  // The gallery shows this product, and nothing else: not the masthead, not
  // the interface icons the page reader collected along the way.
  const logoUrl = shell?.logoUrl
  const held = inlineImages?.map ?? {}
  const gallery = productPicturesOnly(collected, held).filter((u) => u !== logoUrl)
  const forRender =
    enrichment.enriched && gallery.length !== collected.length
      ? { ...enrichment, enriched: { ...enrichment.enriched, images: gallery } }
      : enrichment

  return renderEnrichedPdpHtml(forRender, {
    brand: { shell, theme },
    inlineImages: inlineImages?.map ?? null,
    onlyResolvedImages: opts.forCapture === true,
    // Read from the logo itself: a white mark needs a dark plate behind it.
    logoTone: logoUrl ? logoToneOf(held[logoUrl]) : null,
  })
}
