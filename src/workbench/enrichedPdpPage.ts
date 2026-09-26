import type { EnrichedAttribute, PdpEnrichment } from '../websiteaudit/pdpEnrichment.js'
import type { ThemeProfile } from './types.js'
import type { WebsiteShell } from './websiteShell.js'
import type { LogoTone } from './logoTone.js'

// THE ENRICHED PRODUCT PAGE — "AFTER".
//
// One renderer, used everywhere the After page appears: the Workbench's After
// view, the photograph on the report's "Enriched Result" page, and anything
// else that shows the enriched record. One structure means the customer sees
// the same page in the report as in the demo.
//
// The structure is the approved enriched-PDP layout, top to bottom:
//
//   header + category navigation
//   breadcrumb
//   title bar — product title · availability · price
//   gallery | manufacturer name & part number · description & feature bullets ·
//             quantity / add to cart / buy now / wishlist · payment options
//   Specifications — technical specification matrix in two columns, N attributes
//   Attachments — technical documents
//   Installation Videos
//   Reviews and Ratings
//
// Everything is escaped. Values proposed by enrichment (not found on the
// customer's page or a manufacturer page) carry a small marker and a legend,
// so the page demonstrates the finished record without passing a proposal off
// as a verified fact. Price and availability are only ever the customer's own.

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const safeUrl = (u: string | null | undefined): string | null => {
  if (!u) return null
  // A picture already read from the page, carried as bytes.
  if (u.startsWith('data:image/')) return u
  try {
    const p = new URL(u)
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null
  } catch {
    return null
  }
}

const SYMBOL: Record<string, string> = { EUR: '€', GBP: '£', USD: '$', AUD: 'A$', CAD: 'C$', INR: '₹', AED: 'AED ' }

export function formatPrice(price: string | null, currency: string | null): string | null {
  if (!price) return null
  const n = Number(String(price).replace(/[^0-9.]/g, ''))
  const symbol = currency ? (SYMBOL[currency.toUpperCase()] ?? `${currency.toUpperCase()} `) : ''
  if (Number.isFinite(n) && n <= 0) return null
  if (!Number.isFinite(n)) return `${symbol}${price}`.trim()
  return `${symbol}${n.toFixed(2)}`
}

function valueCell(a: EnrichedAttribute): string {
  const marker = a.source === 'enriched' ? '<span class="mk" title="AI-enriched value">●</span>' : ''
  return `${esc(a.value)}${marker}`
}

function specTable(rows: EnrichedAttribute[]): string {
  return `<table class="spec">${rows
    .map((a) => `<tr><th>${esc(a.name)}</th><td>${valueCell(a)}</td></tr>`)
    .join('')}</table>`
}

export interface EnrichedPdpOptions {
  /** Shown in the header wordmark. */
  platformName?: string
  /** Emit the provenance legend under the specification matrix. */
  showLegend?: boolean
  /**
   * THE CUSTOMER'S OWN BRANDING, for the Workbench "After" view.
   *
   * When given, the page wears the company's website — its logo or name, its
   * navigation labels, its colours and fonts, its footer — around OUR enriched
   * product-page structure, so the After reads as "your site, done properly".
   * When absent the page renders exactly as before (the report's capture).
   */
  brand?: { shell: WebsiteShell | null; theme: ThemeProfile | null } | null
  /**
   * Pictures already read from the customer's page, as data: URIs keyed by the
   * URL they replace. A shop whose image host refuses outside requests — or
   * whose theme embeds its pictures instead of publishing them — is the reason
   * this exists: without it the enriched page shows broken image boxes.
   */
  inlineImages?: Record<string, string> | null
  /**
   * Draw only pictures we actually hold.
   *
   * Set when the page is about to be PHOTOGRAPHED. A picture the browser
   * cannot load leaves a broken-image box in the photograph forever, whereas a
   * live page can simply fetch it a moment later. So a capture shows the
   * honest placeholder instead, and the screen keeps the link.
   */
  onlyResolvedImages?: boolean
  /**
   * Whether the customer's logo is a light mark.
   *
   * A white logo — the kind a shop publishes because its own masthead is a
   * dark bar — vanishes on our white header. Told that it is light, the page
   * gives it the dark plate its own site gives it.
   */
  logoTone?: LogoTone | null
}

// ── Brand values come from another website, so every one is sanitised ─────

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function safeColour(c: string | null | undefined): string | null {
  const v = String(c ?? '').trim()
  return HEX.test(v) ? v : null
}

function safeFont(f: string | null | undefined): string | null {
  const v = String(f ?? '')
    .replace(/[^a-zA-Z0-9 ,"'-]/g, '')
    .trim()
  return v.length >= 3 ? `${v}, Arial, Helvetica, sans-serif` : null
}

function safeRadius(r: string | null | undefined): string {
  const m = String(r ?? '').match(/^(\d{1,2})(px)?$/)
  return m ? `${Math.min(Number(m[1]), 16)}px` : '4px'
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  let h = hex.slice(1)
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

export interface BrandKit {
  css: string
  header: string
  footer: string
}

/**
 * The company's own masthead, navigation, palette and footer.
 *
 * A theme sampled from a site that published no usable colour falls back to a
 * neutral palette rather than borrowing ours: the page must look like theirs,
 * never like AltiusNxt's.
 */
export function brandKit(
  shell: WebsiteShell | null,
  theme: ThemeProfile | null,
  host: string | null,
  inlineImages?: Record<string, string> | null,
  onlyResolvedImages?: boolean,
  /** This product's own pictures, which must never stand in as the logo. */
  productImages: string[] = [],
  /** Whether that logo is a light mark, which needs a dark plate behind it. */
  logoTone: LogoTone | null = null,
): BrandKit {
  const live = theme?.source === 'live_sample'
  const ink = safeColour(live ? theme?.ink : null) ?? '#1f2937'
  const primary = safeColour(live ? theme?.primary : null) ?? '#1f2937'
  // A very light primary (a white header, a pale tint) cannot carry white text
  // or stand as a button colour, so the site's ink takes its place there.
  const strong = luminance(primary) > 0.6 ? ink : primary
  const onStrong = luminance(strong) > 0.45 ? '#111827' : '#ffffff'
  const font = safeFont(live ? theme?.fontFamily : null) ?? 'Arial, Helvetica, sans-serif'
  const heading = safeFont(live ? theme?.headingFamily : null) ?? font
  const radius = safeRadius(live ? theme?.radius : null)

  const name = (shell?.siteName ?? shell?.logoAlt ?? host ?? 'Our store').slice(0, 60)
  // THE LOGO IS THE SITE'S OWN MARK, OR NOTHING.
  //
  // The header capture names the logo when it finds one. The theme's picture is
  // only a fallback, and on a product page it is usually the social-share
  // image — which is the PRODUCT. A product photo in the masthead reads as a
  // broken page, so the fallback is taken only when it is plainly a logo and is
  // not one of this product's own pictures; otherwise the name is set in type.
  const themeLogo = live ? safeUrl(theme?.logoUrl) : null
  const productPictures = new Set(productImages.map((u) => safeUrl(u)).filter(Boolean) as string[])
  const usableThemeLogo =
    themeLogo && !productPictures.has(themeLogo) && /(^|[/_-])(logo|brand|wordmark|masthead)/i.test(themeLogo)
      ? themeLogo
      : null
  const logoUrl = safeUrl(shell?.logoUrl) ?? usableThemeLogo
  // A logo the browser cannot load would be photographed as a broken box, so a
  // capture falls back to the company's name in type.
  const logo = logoUrl ? (inlineImages?.[logoUrl] ?? (onlyResolvedImages ? null : logoUrl)) : null
  const nav = (shell?.nav ?? []).map((l) => l.label.trim()).filter((l) => l && l.length <= 24).slice(0, 5)
  const utility = (shell?.utility ?? []).map((l) => l.label.trim()).filter((l) => l && l.length <= 20).slice(0, 3)
  const footerLinks = (shell?.footerLinks ?? []).map((l) => l.label.trim()).filter((l) => l && l.length <= 40).slice(0, 10)
  const social = (shell?.social ?? []).map((x) => x.platform).slice(0, 5)

  const css = [
    `body{font-family:${font}}`,
    `.titlebar h1,.spechead h3{font-family:${heading}}`,
    `.logo{display:flex;align-items:center;gap:10px;color:${ink};font-size:22px}`,
    `.logo img{max-height:48px;max-width:230px;display:block;object-fit:contain}`,
    // A white mark on our white header is no mark at all, so it gets the dark
    // plate its own masthead gives it.
    ...(logoTone === 'light'
      ? [`.logo img{background:${strong};padding:8px 12px;border-radius:${radius}}`]
      : []),
    `.search{border-color:${strong};border-radius:${radius}}`,
    `.nav{background:${strong}}`,
    `.nav .cat{background:rgba(0,0,0,.16);color:${onStrong}}`,
    `.nav span{color:${onStrong};font-weight:600;letter-spacing:0;white-space:nowrap;padding:14px 16px}`,
    `.nav .in{overflow:hidden}.nav .cat{white-space:nowrap}`,
    `.crumbs a{color:${strong}}`,
    `.price{color:${strong}}`,
    `.thumbs .t{border-color:${strong}}`,
    `.desc h3:after{color:${strong}}`,
    `.cart{background:${strong};color:${onStrong};border-radius:${radius}}`,
    `.qty,.now,.wish{border-radius:${radius}}`,
    `.card,.sec{border-radius:${radius}}`,
    `.sec>h2{color:${strong};border-left-color:${strong}}`,
    `.pdf{color:${strong};background:#f3f4f6}`,
    `.open{background:${strong};color:${onStrong};border-radius:${radius}}`,
    `.foot{background:${ink};color:#e5e7eb;margin-top:28px}`,
    `.foot .in{max-width:1180px;margin:0 auto;padding:26px 20px;display:grid;grid-template-columns:220px 1fr;gap:24px}`,
    `.foot .fname{font-weight:700;font-size:17px;color:#fff}`,
    `.foot ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:13px}`,
    `.foot .fline{grid-column:1/-1;border-top:1px solid rgba(255,255,255,.15);padding-top:12px;font-size:12px;color:#cbd5e1;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}`,
    `@media (max-width:640px){.foot .in{grid-template-columns:1fr}}`,
  ].join('\n')

  const logoHtml = logo ? `<img src="${esc(logo)}" alt="${esc(name)}">` : `<span>${esc(name)}</span>`
  const icons = (utility.length ? utility : ['Account', 'Cart']).map((u) => `<span>${esc(u)}</span>`).join('')
  const navHtml = (nav.length ? nav : ['Home', 'Products', 'Contact']).map((n) => `<span>${esc(n)}</span>`).join('')
  const header =
    `<div class="top"><div class="in"><div class="logo">${logoHtml}</div>` +
    `<div class="search">Search ${esc(name)}…</div><div class="icons">${icons}</div></div></div>` +
    `<div class="nav"><div class="in"><div class="cat">☰ All categories</div>${navHtml}</div></div>`

  const footer =
    `<footer class="foot"><div class="in"><div class="fname">${esc(name)}</div>` +
    `<ul>${footerLinks.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` +
    `<div class="fline"><span>${esc(shell?.footerText ?? `© ${name}`)}</span><span>${social.map((x) => esc(x)).join(' · ')}</span></div>` +
    `</div></footer>`

  return { css, header, footer }
}

export function renderEnrichedPdpHtml(enrichment: PdpEnrichment, opts: EnrichedPdpOptions = {}): string {
  const e = enrichment.enriched
  if (!e) {
    return `<!doctype html><html><body style="font-family:Arial,sans-serif;padding:40px;color:#374151">${esc(
      enrichment.reason ?? 'No enriched record is available.',
    )}</body></html>`
  }

  const platform = opts.platformName ?? 'AltiusNxt'
  const inline = opts.inlineImages ?? null
  const asShown = (u: string | null): string | null => {
    if (!u) return null
    const held = inline?.[u]
    if (held) return held
    return opts.onlyResolvedImages ? null : u
  }
  const kit = opts.brand
    ? brandKit(
        opts.brand.shell,
        opts.brand.theme,
        enrichment.source.host ?? null,
        inline,
        opts.onlyResolvedImages,
        [...(enrichment.enriched?.images ?? []), ...(enrichment.source.images ?? [])],
        opts.logoTone ?? null,
      )
    : null
  const platformHeader = `<div class="top"><div class="in"><div class="logo">${esc(platform.replace(/Nxt$/, ''))}<b>${
    platform.endsWith('Nxt') ? 'Nxt' : ''
  }</b></div><div class="search">Search products, brands, part numbers…</div><div class="icons"><span>Account</span><span>Wishlist</span><span>Cart</span></div></div></div>
<div class="nav"><div class="in"><div class="cat">☰ ALL CATEGORIES</div><span>HOME</span><span>PRODUCTS</span><span>CONTACT US</span></div></div>`
  const price = formatPrice(e.price, e.currency)
  const availability = e.availability
  const images = e.images.map((u) => asShown(safeUrl(u))).filter((u): u is string => Boolean(u))
  const main = images[0] ?? null
  const mfrName = e.brand
  const mpn = e.manufacturerPartNumber ?? enrichment.source.mpn ?? enrichment.source.sku
  const half = Math.ceil(e.attributes.length / 2)
  const left = e.attributes.slice(0, half)
  const right = e.attributes.slice(half)
  const enrichedCount = e.attributes.filter((a) => a.source === 'enriched').length

  const docs = e.documents.length
    ? e.documents
        .map((d) => {
          const url = safeUrl(d.url)
          return `<div class="doc"><div class="pdf">PDF</div><div class="docmeta"><strong>${esc(d.title)}</strong><span>${
            url ? 'PDF file' : 'To be sourced from the manufacturer'
          }</span></div>${
            url
              ? `<a class="open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">OPEN</a>`
              : '<span class="open muted">PENDING</span>'
          }</div>`
        })
        .join('')
    : '<p class="empty">Technical documents will be attached here.</p>'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(e.enrichedTitle)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f3f3;font-family:Roboto,Arial,Helvetica,sans-serif;color:#222;font-size:14px}
a{color:inherit}
.top{background:#fff;border-bottom:1px solid #e5e5e5}
.top .in{max-width:1180px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:24px}
.logo{font-weight:800;font-size:20px;letter-spacing:-.3px}.logo b{color:#d10a11}
.search{flex:1;border:2px solid #d10a11;border-radius:4px;padding:9px 12px;color:#999;font-size:13px}
.icons{display:flex;gap:18px;font-size:12px;color:#555}
.nav{background:#2b2b2b}.nav .in{max-width:1180px;margin:0 auto;display:flex;align-items:stretch;padding:0 20px}
.nav .cat{background:#d10a11;color:#fff;font-weight:700;padding:14px 22px;letter-spacing:.5px;font-size:13px}
.nav span{color:#fff;font-weight:700;padding:14px 20px;font-size:13px;letter-spacing:.5px}
.wrap{max-width:1180px;margin:0 auto;padding:16px 20px 40px}
.crumbs{font-size:13px;color:#555;margin:6px 0 12px}.crumbs a{color:#2563eb;text-decoration:none}.crumbs i{font-style:normal;color:#999;margin:0 6px}
.card{background:#fff;border:1px solid #e2e2e2;border-radius:2px}
.titlebar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 18px;border-bottom:1px solid #e8e8e8}
.titlebar h1{margin:0;font-size:20px;font-weight:700;font-family:'Roboto Condensed',Arial Narrow,Arial,sans-serif}
.pricebox{display:flex;align-items:center;gap:18px;white-space:nowrap}
.stock{color:#1a7f37;font-weight:700;font-size:13px}.stock:before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;margin-right:6px}
.stock.unknown{color:#6b7280}.stock.unknown:before{background:#9ca3af}
.price{color:#d10a11;font-size:26px;font-weight:700}.price.req{font-size:15px}
.main{display:grid;grid-template-columns:42% 58%}
.gallery{padding:16px;border-right:1px solid #eee}
.hero{border:1px solid #e5e5e5;height:420px;display:flex;align-items:center;justify-content:center;background:#fff}
.hero img{max-width:92%;max-height:92%;object-fit:contain}
.noimg{color:#9ca3af;font-size:13px;text-align:center}
.thumbs{display:flex;gap:10px;margin-top:12px;align-items:center}
.thumbs .t{width:62px;height:62px;border:2px solid #d10a11;display:flex;align-items:center;justify-content:center;background:#fff}
.thumbs .t img{max-width:90%;max-height:90%}
.thumbs .arrow{width:34px;height:34px;border:1px solid #ddd;display:flex;align-items:center;justify-content:center;color:#555}
.info{padding:18px 20px}
.meta p{margin:0 0 12px;font-size:15px}.meta{border-bottom:1px solid #eee;margin-bottom:12px}
.desc h3{font-size:14px;margin:6px 0 8px;display:flex;justify-content:space-between}.desc h3:after{content:'—';color:#d10a11}
.desc p{line-height:1.6;margin:0 0 10px;color:#333}.desc ul{margin:0;padding-left:20px}.desc li{margin:6px 0;line-height:1.5}
.buy{display:flex;gap:12px;margin-top:18px;border-top:1px solid #eee;padding-top:14px}
.qty{display:flex;border:1px solid #ddd}.qty span{width:40px;display:flex;align-items:center;justify-content:center;font-size:18px}
.qty span.n{border-left:1px solid #ddd;border-right:1px solid #ddd;font-weight:700;font-size:15px}
.cart{flex:1;background:#d10a11;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;padding:14px;font-size:15px}
.now{border:1px solid #ddd;padding:14px 38px;font-weight:700;background:#f7f7f7}
.wish{border:1px solid #ddd;width:50px;display:flex;align-items:center;justify-content:center;font-size:20px;color:#555}
.pay{margin-top:16px;display:flex;align-items:center;gap:14px;font-size:15px}
.pay .badges{display:flex;gap:10px;background:#f5f5f5;padding:6px 10px;font-weight:800;font-size:13px;color:#1a1f71}
.sec{background:#fff;border:1px solid #e2e2e2;margin-top:14px}
.sec>h2{margin:0;font-size:15px;color:#d10a11;padding:14px 18px;border-left:4px solid #d10a11;border-bottom:1px solid #eee;display:flex;justify-content:space-between}
.sec>h2:after{content:'×';color:#555;font-weight:400}
.secbody{padding:16px 22px}
.spechead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px}
.spechead h3{margin:0;font-size:19px;font-family:'Roboto Condensed',Arial Narrow,Arial,sans-serif}
.spechead span{font-size:12px;font-weight:700;letter-spacing:.8px;color:#555}
.specs{display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:start}
table.spec{width:100%;border-collapse:collapse;border:1px solid #e4e4e4;border-radius:6px}
table.spec th{width:42%;text-align:left;font-weight:700;font-size:13.5px;background:#f7f7f7;padding:12px 14px;border-bottom:1px solid #e8e8e8;border-right:1px solid #e8e8e8;vertical-align:top}
table.spec td{padding:12px 14px;border-bottom:1px solid #e8e8e8;font-size:14px;color:#444;line-height:1.45;vertical-align:top}
.mk{color:#7c3aed;font-size:8px;margin-left:5px;vertical-align:super}
.legend{margin-top:12px;font-size:12px;color:#6b7280}.legend .mk{font-size:10px;margin:0 4px 0 0;vertical-align:baseline}
.docs{display:flex;flex-wrap:wrap;gap:14px}
.doc{display:flex;align-items:center;gap:14px;background:#f5f5f5;border:1px solid #e3e3e3;padding:16px 18px;min-width:340px}
.pdf{width:46px;height:46px;background:#fde8e8;color:#d10a11;font-weight:800;font-size:11px;display:flex;align-items:center;justify-content:center}
.docmeta{display:flex;flex-direction:column;gap:4px;flex:1}.docmeta span{font-size:12px;color:#666}
.open{background:#d10a11;color:#fff;font-weight:700;padding:8px 16px;text-decoration:none;font-size:13px}.open.muted{background:#9ca3af}
.empty{color:#666;margin:0}
@media (max-width:1000px){.buy{flex-wrap:wrap}.cart{flex:1 1 100%;order:3}.qty{order:1}.now{order:2;flex:1;text-align:center}.wish{order:2}.titlebar{flex-wrap:wrap}.specs{grid-template-columns:1fr}.doc{min-width:0;flex:1 1 100%}}
@media (max-width:640px){.main{grid-template-columns:1fr}.gallery{border-right:0}.nav span{padding:14px 10px}}
</style>${kit ? `<style>${kit.css}</style>` : ""}</head><body>
${kit ? kit.header : platformHeader}
<div class="wrap">
<div class="crumbs">${['Products', ...e.categoryPath]
    .map((c) => `<a>${esc(c)}</a>`)
    .join('<i>›</i>')}<i>›</i>${esc(e.enrichedTitle)}</div>
<div class="card">
<div class="titlebar"><h1>${esc(e.enrichedTitle)}</h1><div class="pricebox">${
    availability ? `<span class="stock">${esc(availability)}</span>` : '<span class="stock unknown">Availability on request</span>'
  }${price ? `<span class="price">${esc(price)}</span>` : '<span class="price req">Price on request</span>'}</div></div>
<div class="main">
<div class="gallery"><div class="hero">${
    main ? `<img src="${esc(main)}" alt="${esc(e.enrichedTitle)}">` : '<div class="noimg">Product image</div>'
  }</div><div class="thumbs"><div class="arrow">‹</div>${images
    .slice(0, 4)
    .map((u) => `<div class="t"><img src="${esc(u)}" alt=""></div>`)
    .join('')}<div class="arrow" style="margin-left:auto">›</div></div></div>
<div class="info">
<div class="meta">${mfrName ? `<p>Mfr. Name: ${esc(mfrName)}</p>` : ''}${mpn ? `<p>Mfr. Part Number: ${esc(mpn)}</p>` : ''}${
    e.unspsc ? `<p>UNSPSC: ${esc(e.unspsc)}</p>` : ''
  }</div>
<div class="desc"><h3>Product Description</h3><p>${esc(e.description.intro)}</p><ul>${e.description.bullets
    .map((b) => `<li>${esc(b)}</li>`)
    .join('')}</ul></div>
<div class="buy"><div class="qty"><span>−</span><span class="n">1</span><span>+</span></div><div class="cart">🛒&nbsp; ADD TO CART</div><div class="now">Buy Now →</div><div class="wish">♡</div></div>
<div class="pay">Payment Options: <div class="badges"><span>VISA</span><span style="color:#eb001b">MC</span><span style="color:#444">G Pay</span><span style="color:#000">Apple Pay</span></div></div>
</div></div></div>
<div class="sec"><h2>Specifications</h2><div class="secbody"><div class="spechead"><h3>Technical Specifications</h3><span>${
    e.attributes.length
  } ATTRIBUTES</span></div><div class="specs">${specTable(left)}${specTable(right)}</div>${
    opts.showLegend !== false && enrichedCount
      ? `<div class="legend"><span class="mk">●</span>AI-enriched value (${enrichedCount} of ${e.attributes.length}) — to be confirmed against manufacturer data before publishing.</div>`
      : ''
  }</div></div>
<div class="sec"><h2>Attachments</h2><div class="secbody"><div class="docs">${docs}</div></div></div>
<div class="sec"><h2>Installation Videos</h2><div class="secbody"><p class="empty">Installation video content coming soon.</p></div></div>
<div class="sec"><h2>Reviews and Ratings</h2><div class="secbody"><p class="empty">No reviews yet. Be the first to review this product.</p></div></div>
</div>${kit ? kit.footer : ""}</body></html>`
}
