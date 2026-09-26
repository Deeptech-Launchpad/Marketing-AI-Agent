// Whether two URLs belong to the same site.
//
// Enrichment follows redirects, and a redirect can leave the company's site
// entirely: a brand acquired by another business often forwards its domain to
// the parent's homepage. What is read there is the OTHER company's site, so it
// must not be recorded as this company's.
//
// "Same site" means the same registrable domain, so apex -> www, http -> https
// and shop.example.com -> example.com are all the same site. There is no
// public-suffix list dependency in this project, so the registrable domain is
// computed with a generic rule that covers the common two-level suffixes
// (example.co.uk, example.com.au) — good enough for a yes/no comparison, and
// it errs toward "same site" only when both hosts share the same last three
// labels.

/** Second-level labels that, under a two-letter country code, form a public suffix. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'ltd', 'plc', 'or', 'ne', 'go', 'gob', 'nic', 'mil', 'info', 'biz', 'nom', 'sch'])

export function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
    return new URL(withScheme).hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  // IP literals have no registrable domain; compare them whole.
  if (/^\d+(?:\.\d+){3}$/.test(h) || h.includes(':')) return h
  const labels = h.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const tld = labels[labels.length - 1]!
  const sld = labels[labels.length - 2]!
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2
  return labels.slice(-take).join('.')
}

/** True when both URLs parse and sit on the same registrable domain. */
export function sameRegistrableSite(a: string | null | undefined, b: string | null | undefined): boolean {
  const ha = hostnameOf(a)
  const hb = hostnameOf(b)
  if (!ha || !hb) return true // nothing to compare is not evidence of a different site
  return registrableDomain(ha) === registrableDomain(hb)
}
