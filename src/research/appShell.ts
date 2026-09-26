// A SITE THAT RENDERS ITSELF IN THE BROWSER.
//
// Some real company sites serve this, in full, to every visitor and every
// crawler:
//
//   <head>… <script type="module" src="/assets/index-9v7InpYE.js"></script> …
//   <body><div id="root"></div></body>
//
// Six hundred and forty bytes. There are no anchors to follow and no text to
// read, so every engine that reads server HTML sees nothing — and reports
// nothing, about a company with a full catalogue and a published Facebook page.
//
// The links are not missing. They are in the JavaScript the shell loads, and
// that JavaScript is served by the company's own host. So when a page turns
// out to be a shell, the assets it references are read AS TEXT and searched
// for the addresses the application publishes.
//
// THE RULES THIS KEEPS, and they are the reason it is allowed at all:
//
//   · FIRST-PARTY ONLY. Same-origin assets, nothing else. A CDN bundle, an
//     analytics tag or a third-party widget is not the company speaking.
//   · NOTHING IS EXECUTED. The bytes are scanned. No JavaScript runs, no
//     headless browser is started, no DOM is built.
//   · THE SAME GUARDED TRANSPORT. Callers fetch through fetchPageRaw, so the
//     SSRF revalidation, redirect cap, timeout and byte ceiling all still
//     apply.
//   · BOUNDED. A caller passes a maximum and gets at most that many.
//
// This module is shared: Intent Signals uses it to find the company's social
// profiles, and the Website Audit uses it to find the company's product pages.
// One implementation, so the two cannot drift about what a shell is.

/**
 * Does this page render itself in the browser rather than on the server?
 *
 * Judged on what a reader would actually get: almost no text, effectively no
 * links, and at least one script to run. All three matter — a short page with
 * real anchors is a small site, not a shell, and must not be treated as one.
 */
export function looksLikeAppShell(html: string): boolean {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html
  const text = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const anchors = (body.match(/<a\b[^>]*href/gi) ?? []).length
  const scripts = (html.match(/<script\b[^>]*\bsrc\s*=/gi) ?? []).length
  return text.length < 200 && anchors <= 1 && scripts >= 1
}

/**
 * The company's OWN asset URLs referenced by this page, same-origin only.
 *
 * Same-origin is the whole safety property: a CDN bundle, an analytics tag or
 * a third-party widget is not the company speaking, and is not fetched.
 */
export function firstPartyAssetUrls(html: string, pageUrl: string, max = 3): string[] {
  let origin: string
  try {
    origin = new URL(pageUrl).origin
  } catch {
    return []
  }

  const out: string[] = []
  const re = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < max) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!raw) continue
    let abs: URL
    try {
      abs = new URL(raw, pageUrl)
    } catch {
      continue
    }
    if (abs.origin !== origin) continue
    if (!/\.(?:js|mjs|json)$/i.test(abs.pathname)) continue
    const url = abs.toString()
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** Paths that are the application's plumbing rather than a page a buyer reads. */
const NOT_A_PAGE =
  /^\/(?:api|graphql|_next|__|static|assets?|dist|build|node_modules|cdn-cgi|wp-json|wp-admin|wp-content|admin|cart|checkout|account|login|logout|signin|signup|register|search)\b/i

/** File extensions that are an asset, never a page. */
const ASSET_EXTENSION =
  /\.(?:js|mjs|cjs|json|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|pdf|zip|xml|txt)$/i

/**
 * Route paths the application publishes, read out of its own asset text.
 *
 * A client-rendered site declares its routes as string literals — "/products",
 * "/products/p/bath-board-steel" — and those strings are the only statement
 * the server ever makes about which pages exist. They are CANDIDATES: each one
 * is still fetched and classified on its own content, exactly like a URL found
 * in an anchor. Nothing here decides that a path is a product.
 *
 * Deliberately narrow. A bundle is full of strings that begin with a slash and
 * are not routes at all, so a candidate must look like a path a person could
 * be shown: no asset extension, no API or build plumbing, no template
 * placeholder, and short enough to be a real URL.
 */
export function extractRouteUrls(assetText: string, pageUrl: string, max = 120): string[] {
  let origin: string
  try {
    origin = new URL(pageUrl).origin
  } catch {
    return []
  }

  const found: string[] = []
  const add = (path: string) => {
    if (found.length >= max) return
    if (!path.startsWith('/') || path.startsWith('//')) return
    if (path.length > 160) return
    // A placeholder is a route TEMPLATE, not a page: "/products/:slug" and
    // "/products/${id}" are instructions for building a URL, and following one
    // would be requesting a page that does not exist.
    if (/[:*${}<>\[\]()\\^|`"'\s]/.test(path)) return
    if (NOT_A_PAGE.test(path)) return
    if (ASSET_EXTENSION.test(path)) return
    // A bare "/" is the page we are already on.
    const clean = path.replace(/[?#].*$/, '').replace(/\/+$/, '')
    if (!clean || clean === '') return
    const url = `${origin}${clean}`
    if (!found.includes(url)) found.push(url)
  }

  // Quoted string literals: how a router declares its paths.
  for (const m of assetText.matchAll(/["'`](\/[A-Za-z0-9._~\-/]{1,150})["'`]/g)) add(m[1]!)

  // Absolute URLs on this same origin, which a bundle carries for canonical
  // links, share buttons and preloads.
  for (const m of assetText.matchAll(/https?:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\-/]{1,150})/g)) {
    const whole = m[0]
    try {
      if (new URL(whole).origin === origin) add(m[1]!)
    } catch {
      /* not a URL we can read */
    }
  }

  return found
}
