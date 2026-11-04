// WARM LEADS — reading a company's website can fail for reasons that say
// NOTHING about the company (2026-10-31). Pure: no I/O.
//
// The first 10-company test reported eight websites as "could not be reached"
// and filed them under "not enough data". They were never unreachable: this
// office network's content filter reset the HTTPS connection and answered plain
// HTTP with a "Web Site Blocked" page. A connection reset, a firewall block
// page, a timeout, a bot wall (403/429) or a DNS hiccup describes the NETWORK
// the evaluation ran on. Filing it as "not enough data" (or worse, "cold") hides
// a company that was never looked at.
//
// So an evaluation whose website could not be read for such a reason is FAILED,
// to be retried — from a network that can read the site — never classified.
// The only access answers that ARE statements about the site are "no website on
// the record" (decided before any request) and the site itself saying the page
// does not exist (HTTP 404 / 410).

export type AccessKind =
  | 'connection_reset'
  | 'block_page'
  | 'access_denied'
  | 'rate_limited'
  | 'timeout'
  | 'dns'
  | 'refused'
  | 'tls'
  | 'server_error'
  | 'other'
  | 'not_found'

export interface AccessFailure {
  kind: AccessKind
  /** True for everything except the site itself saying the page does not exist. */
  retryable: boolean
  /** A sentence for the person reading the result. */
  message: string
}

const LABEL: Record<AccessKind, string> = {
  connection_reset: 'the connection was reset',
  block_page: 'a security or firewall block page was returned',
  access_denied: 'access was denied (HTTP 401/403/451)',
  rate_limited: 'the site rate-limited the request (HTTP 429)',
  timeout: 'the site did not respond in time',
  dns: 'the domain name could not be resolved',
  refused: 'the connection was refused',
  tls: 'the TLS certificate could not be verified',
  server_error: 'the site returned a server error (HTTP 5xx)',
  other: 'the site could not be reached',
  not_found: 'the site answered that the page does not exist (HTTP 404/410)',
}

/** The fetcher's own sentences (research/pageFetch.ts) and HTTP statuses, as one of the kinds above. */
export function interpretWebsiteFailure(reason: string | null | undefined): AccessFailure {
  const r = (reason ?? '').trim()
  const kind = ((): AccessKind => {
    if (/\bHTTP (404|410)\b/i.test(r)) return 'not_found'
    if (/\bHTTP 429\b/i.test(r)) return 'rate_limited'
    if (/\bHTTP (401|403|407|451)\b/i.test(r)) return 'access_denied'
    if (/\bHTTP 5\d\d\b/i.test(r)) return 'server_error'
    if (/reset the connection|ECONNRESET/i.test(r)) return 'connection_reset'
    if (/took too long|timed out|timeout/i.test(r)) return 'timeout'
    if (/could not be resolved|DNS lookup|ENOTFOUND|EAI_AGAIN/i.test(r)) return 'dns'
    if (/refused the connection|ECONNREFUSED/i.test(r)) return 'refused'
    if (/TLS certificate|certificate/i.test(r)) return 'tls'
    return 'other'
  })()
  const retryable = kind !== 'not_found'
  const message = retryable
    ? `The website could not be read: ${LABEL[kind]}${r ? ` (${r.replace(/\.$/, '')})` : ''}. This says nothing about the company; retry from a network that can open the site.`
    : `The website answered that its page does not exist (${r.replace(/\.$/, '')}).`
  return { kind, retryable, message }
}

/**
 * Whether a page's TITLE (or meta description) is a block, challenge or error
 * page rather than the company's own page. Titles only, and specific phrases —
 * a real company may well sell "firewall" systems — and a miss is not unsafe:
 * the page would then simply be read as thin evidence, never as a warm lead.
 */
const BLOCK_PAGE = new RegExp(
  [
    'web\\s?site (has been )?blocked',
    'site (has been )?blocked',
    '^\\s*access (denied|blocked|restricted)\\b',
    'blocked by (your )?(network|administrator|firewall|security)',
    'network security appliance',
    'content (filter|filtering)',
    'request (blocked|rejected)',
    'you (have been|are) blocked',
    '^\\s*403\\b',
    '\\b403 forbidden\\b',
    '^\\s*forbidden\\s*$',
    '^\\s*attention required\\b',
    '^\\s*just a moment\\W*(\\|.*)?$',
    '^\\s*checking your browser',
    'are you (a )?(human|robot)',
    'verify you are (a )?human',
    '^\\s*security check\\b',
    'error 1020',
    'this (web)?site (can.t|cannot) be reached',
  ].join('|'),
  'i',
)

export function looksLikeBlockPage(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => typeof t === 'string' && t.length < 300 && BLOCK_PAGE.test(t))
}

/**
 * A hosting placeholder - "Account Suspended", a parked or for-sale domain, "Coming soon", a 404 on the home
 * page - is the SITE telling us there is nothing there (falzons.com showed "Account Suspended"). Unlike a
 * block page this is a statement about the site, not the network: nothing to read, so "not enough data",
 * with the reason said. Titles only, and specific phrases ("Suspended Ceilings Ltd" is a real company).
 */
const PLACEHOLDER_SITE = new RegExp(
  [
    '^\\s*account (has been )?suspended',
    '^\\s*(this )?(web)?site (has been )?suspended',
    '^\\s*(this )?domain (is )?(parked|for sale|expired)',
    '^\\s*parked\\b',
    'default web ?site page',
    'future home of',
    '^\\s*(coming soon|under construction|site under construction)\\W*$',
    '^\\s*(website|domain) (has )?expired',
    '^\\s*(site|page|website) not found',
    '^\\s*404\\b',
    '\\bpage not found\\b',
  ].join('|'),
  'i',
)

export function looksLikePlaceholderSite(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => typeof t === 'string' && t.length < 200 && PLACEHOLDER_SITE.test(t))
}

/**
 * A page that is only a placeholder - "Redirect", "Loading", "Please wait" - is a
 * redirect or script stub: the company's own page was never loaded, so nothing
 * was read (BENCO's page title was "Redirect"). Not a block page, but the same
 * conclusion: retry, never "cold".
 */
const STUB_PAGE = /^\s*(redirect(ing)?|loading|please wait|one moment|just a sec(ond)?|moved|document moved|object moved|index of \/?)\W*$/i

export function looksLikeStubPage(title: string | null | undefined): boolean {
  return typeof title === 'string' && title.length < 60 && STUB_PAGE.test(title)
}

/**
 * The web research (Intent Signals) found pages but could read none of them —
 * the same environment problem one step later (on the first test the search
 * result links could not even be opened). No finding then means NOTHING was
 * read, not that nothing is there.
 *
 * `providerResults` is IntentDetectionRun.providerResults: each provider may
 * carry metadata.pagesRead as objects { ok, url, reason }. Providers that list
 * pages as plain strings (the company's own site) are not counted.
 */
export function researchUnreadable(providerResults: unknown): string | null {
  if (!Array.isArray(providerResults)) return null
  let attempted = 0
  let read = 0
  const reasons: string[] = []
  for (const p of providerResults) {
    const pages = (p as { metadata?: { pagesRead?: unknown } } | null)?.metadata?.pagesRead
    if (!Array.isArray(pages)) continue
    for (const page of pages) {
      if (!page || typeof page !== 'object') continue
      const { ok, reason } = page as { ok?: unknown; reason?: unknown }
      attempted++
      if (ok === true) read++
      else if (typeof reason === 'string' && reason && !reasons.includes(reason)) reasons.push(reason)
    }
  }
  if (attempted === 0 || read > 0) return null
  return `The web research found ${attempted} page(s) but could read none of them${reasons.length ? ` (${reasons.slice(0, 2).join('; ')})` : ''}.`
}
