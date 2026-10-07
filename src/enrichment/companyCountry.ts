import { addressPageLink, locationsOnPage, US_STATES, type CompanyLocation } from '../prospects/companyLocation.js'
import { htmlToText } from '../research/htmlToText.js'
import { fetchPageRaw, type RawPageResult } from '../research/pageFetch.js'
import { hostnameOf, sameRegistrableSite } from './siteIdentity.js'

// THE COUNTRY A COMPANY IS IN — ONLY WHERE A SOURCE STATES IT.
//
// Enrichment used to show a country only when NXT Sales held one, so a company
// found by "Find New Company" was always "country unknown" — even when
// Prospects had already read "Indianapolis, IN 46278" off its own website
// (2026-10-07). The country is now taken, in this order, from:
//
//   1. the NXT Sales record (the company's own, or the one a discovered
//      company is linked to);
//   2. an address the company's OWN website states — its structured data, or
//      an address written on the homepage or its contact page;
//   3. the location a listing page printed beside the company's name, as
//      Prospects verified it on that page.
//
// Nothing is inferred from a domain ending, a phone prefix, a language or the
// company's name, and when a site's addresses name more than one country none
// is chosen. "Not stated" is a real answer and is reported as one.

export interface CountryFinding {
  /** Display name: "United States", "Malta". */
  country: string
  /** Where it was read, in words. */
  source: string
  sourceUrl: string | null
  /** The address or value as the source wrote it. */
  statedAs: string
}

export type CountrySourceLabel =
  | 'NXT Sales record'
  | 'company website (structured data)'
  | 'company website (address on page)'
  | 'listing page that named the company'

const US_CODES = new Set(US_STATES.map(([c]) => c))
const US_NAMES = /^(u\.?s\.?a?\.?|united states( of america)?|america)$/i

let regionNames: Intl.DisplayNames | null = null
function regionName(code: string): string | null {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' })
    const name = regionNames.of(code.toUpperCase())
    return name && name.toUpperCase() !== code.toUpperCase() ? name : null
  } catch {
    return null
  }
}

/** A country as a person reads it. Unknown spellings are kept as written, never replaced by a guess. */
export function countryName(raw: string | null | undefined): string | null {
  const t = raw?.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 60) return null
  if (US_NAMES.test(t)) return 'United States'
  if (/^[A-Za-z]{2}$/.test(t)) return regionName(t)
  return t
}

/** The country one stated address names, or null. A US state with a 5-digit ZIP is a US address. */
export function countryOfLocation(l: CompanyLocation): string | null {
  const stated = countryName(l.country)
  if (stated) return stated
  if (l.region && US_CODES.has(l.region) && l.postalCode && /^\d{5}(-\d{4})?$/.test(l.postalCode)) return 'United States'
  return null
}

/**
 * The one country a set of addresses agrees on. Addresses in several
 * countries (a distributor with branches abroad) give no answer — the
 * company's own country is not something to pick from a list.
 */
export function countryOfLocations(
  locations: CompanyLocation[],
): { finding: CountryFinding } | { several: string[] } | null {
  const named = locations.map((l) => ({ l, country: countryOfLocation(l) })).filter((x) => x.country)
  if (!named.length) return null
  const countries = [...new Set(named.map((x) => x.country!))]
  if (countries.length > 1) return { several: countries }
  const first = named[0]!
  return {
    finding: {
      country: first.country!,
      source: first.l.source === 'listing page' ? 'listing page that named the company' : first.l.source,
      sourceUrl: first.l.sourceUrl,
      statedAs: first.l.text,
    },
  }
}

// ── Addresses written on a page ────────────────────────────────────────────
//
// The address reader Prospects uses knows structured data and the US form
// "Akron, OH 44301". Two more forms are common on a company's own pages, and
// were read as "no address" (2026-10-07):
//
//   "Memphis TN 38141"                                — a US address without the comma
//   "Via Croazia, 2 - Z.A.U. 33100 UDINE - ITALY"     — an address that ends in its country
//
// The second is accepted only when the country closes the address line (after
// a comma or a dash, or alone on the line after it), when the address carries a
// number (a street number or a postcode), and never from a copyright line —
// so "we ship to Italy", a country drop-down or "© 2024 … Malta" state nothing.

/** Names that are also something else on an address line ("Atlanta, Georgia"). */
const AMBIGUOUS = new Set(['Georgia', 'Jersey'])
const ALIASES: Record<string, string> = {
  usa: 'United States', 'u.s.a': 'United States', 'u.s.a.': 'United States', 'united states of america': 'United States',
  uk: 'United Kingdom', 'u.k.': 'United Kingdom', england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom',
  'northern ireland': 'United Kingdom', 'great britain': 'United Kingdom',
  deutschland: 'Germany', italia: 'Italy', 'españa': 'Spain', espana: 'Spain', nederland: 'Netherlands', 'the netherlands': 'Netherlands',
  schweiz: 'Switzerland', suisse: 'Switzerland', 'österreich': 'Austria', polska: 'Poland', sverige: 'Sweden', danmark: 'Denmark',
  norge: 'Norway', suomi: 'Finland', brasil: 'Brazil', 'méxico': 'Mexico', 'uae': 'United Arab Emirates',
}

let countryIndex: { pattern: RegExp; byName: Map<string, string> } | null = null
function countries(): { pattern: RegExp; byName: Map<string, string> } {
  if (countryIndex) return countryIndex
  const byName = new Map<string, string>()
  const A = 'A'.charCodeAt(0)
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j)
      const name = regionName(code)
      // Two-letter areas only (no "Europe", "World"), and none that is also a US state.
      if (name && !AMBIGUOUS.has(name) && !/^(European Union|Eurozone|United Nations|world|Outlying)/i.test(name)) byName.set(name.toLowerCase(), name)
    }
  }
  for (const [alias, name] of Object.entries(ALIASES)) byName.set(alias, name)
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
  countryIndex = { pattern: new RegExp(`(?:^|,|\\s[-–]\\s)\\s*(${names.join('|')})\\s*\\.?$`, 'i'), byName }
  return countryIndex
}

const US_CODE_LIST = [...US_CODES].join('|')
const US_NO_COMMA = new RegExp(`(?:^|[\\s,])[A-Z][A-Za-z.'-]+(?:\\s[A-Z][A-Za-z.'-]+){0,3}\\s+(${US_CODE_LIST})\\s+\\d{5}(?:-\\d{4})?\\s*$`)

/** Addresses a page writes out, with the country each one names. */
export function writtenAddressCountries(text: string, pageUrl: string): CountryFinding[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const out: CountryFinding[] = []
  const { pattern, byName } = countries()
  lines.forEach((line, i) => {
    if (line.length > 160 || /©|copyright|all rights reserved/i.test(line)) return
    if (US_NO_COMMA.test(line)) {
      out.push({ country: 'United States', source: 'company website (address on page)', sourceUrl: pageUrl, statedAs: line })
      return
    }
    const m = line.match(pattern)
    if (!m) return
    // The address the country closes: this line, or this line and the two
    // before it when the country stands on a line of its own.
    const before = line.slice(0, m.index ?? 0).trim()
    const window = before ? [line] : lines.slice(Math.max(0, i - 2), i + 1)
    const rest = window.join(', ').slice(0, Math.max(0, window.join(', ').length - m[1]!.length))
    if (window.some((l) => l.length > 160 || /©|copyright|all rights reserved/i.test(l))) return
    // A number with words beside it: a street number or a postcode, not a phone code.
    if (!window.some((l) => /\d/.test(l) && /[A-Za-z]{3,}/.test(l)) || !/\d/.test(rest)) return
    const name = byName.get(m[1]!.toLowerCase().replace(/\s+/g, ' '))
    if (!name) return
    out.push({ country: name, source: 'company website (address on page)', sourceUrl: pageUrl, statedAs: window.join(', ') })
  })
  return out
}

/** Every country one page states an address in: structured data, then written addresses. */
function pageCountries(html: string, pageUrl: string): { findings: CountryFinding[]; undated: CompanyLocation[] } {
  const locations = locationsOnPage(html, pageUrl)
  const findings: CountryFinding[] = []
  const undated: CompanyLocation[] = []
  for (const l of locations) {
    const country = countryOfLocation(l)
    if (country) findings.push({ country, source: l.source === 'listing page' ? 'listing page that named the company' : l.source, sourceUrl: l.sourceUrl, statedAs: l.text })
    else undated.push(l)
  }
  findings.push(...writtenAddressCountries(htmlToText(html), pageUrl))
  return { findings, undated }
}

type Fetcher = (url: string) => Promise<RawPageResult>

/**
 * Reads the company's own homepage — and, only when it states no address, the
 * contact or locations page it links to — for the addresses they state.
 * At most two requests, both through the guarded transport, both on the
 * company's own site. Never throws: a page that cannot be read is a note.
 */
export async function countryFromWebsite(
  siteUrl: string,
  fetcher: Fetcher = fetchPageRaw,
): Promise<{ finding: CountryFinding | null; note: string }> {
  const home = await fetcher(siteUrl).catch(() => null)
  if (!home?.ok || !home.html) {
    return { finding: null, note: `The homepage could not be read again for an address${home?.reason ? ` (${home.reason})` : ''}.` }
  }
  const homeUrl = home.finalUrl ?? siteUrl
  if (!sameRegistrableSite(siteUrl, homeUrl)) {
    return { finding: null, note: `The homepage redirected to ${hostnameOf(homeUrl) ?? homeUrl}, so no address there is attributed to the company.` }
  }

  let read = pageCountries(home.html, homeUrl)
  let where = 'the homepage'
  if (read.findings.length === 0) {
    const contact = addressPageLink(home.html, homeUrl)
    if (contact) {
      const page = await fetcher(contact).catch(() => null)
      const pageUrl = page?.finalUrl ?? contact
      if (page?.ok && page.html && sameRegistrableSite(siteUrl, pageUrl)) {
        const more = pageCountries(page.html, pageUrl)
        read = { findings: more.findings, undated: [...read.undated, ...more.undated] }
        where = `the homepage or its contact page (${pageUrl})`
      }
    }
  }

  const countries = [...new Set(read.findings.map((f) => f.country))]
  if (countries.length > 1) {
    return { finding: null, note: `The website states addresses in more than one country (${countries.join(', ')}), so none was chosen.` }
  }
  const finding = read.findings[0]
  if (!finding) {
    return {
      finding: null,
      note: read.undated.length
        ? `The website states an address (${read.undated[0]!.text}) but not which country it is in.`
        : `No address was stated on ${where}.`,
    }
  }
  return { finding, note: `Address stated on the company's website: ${finding.statedAs}.` }
}
