import { htmlToText } from '../research/htmlToText.js'
import { extractJsonLd, extractLinks, jsonLdNodes } from '../websiteaudit/htmlStructure.js'
import { resolveLink } from '../websiteaudit/urls.js'

// WHERE A COMPANY IS — FROM ITS OWN WORDS.
//
// A map search shows each business with its address. Prospects does the same,
// but only from what a page states: the address a company's own website
// declares (its structured data, or an address written on the page), or the
// location a directory listing prints beside its name. Nothing is inferred
// from a domain, a phone prefix or a company name, and a company whose pages
// state no address is shown without one.
//
// When the salesperson's objective names a US state ("… in Ohio"), a company
// whose own website places it somewhere else — and never mentions that state
// — is outside the search and is set aside, as a map search would.

export interface CompanyLocation {
  /** As the page writes it: "1234 Main St, Akron, OH 44301". */
  text: string
  city: string | null
  /** Two-letter state code for a US address; the page's own region otherwise. */
  region: string | null
  postalCode: string | null
  country: string | null
  /** Where it was read. */
  source: 'company website (structured data)' | 'company website (address on page)' | 'listing page'
  sourceUrl: string
}

export const US_STATES: Array<[code: string, name: string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'],
  ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
]
const CODE_OF = new Map(US_STATES.map(([c, n]) => [n.toLowerCase(), c]))
const NAME_OF = new Map(US_STATES.map(([c, n]) => [c, n]))
const STATE_CODES = US_STATES.map(([c]) => c).join('|')
const STATE_NAMES = US_STATES.map(([, n]) => n.replace(/ /g, '\\s+')).join('|')

/**
 * Each state's largest cities, so a state-wide search can be run city by city
 * the way a map search covers a region. Plain geography, not a model's list.
 */
export const STATE_CITIES: Record<string, string[]> = {
  AL: ['Birmingham', 'Huntsville', 'Montgomery', 'Mobile'], AK: ['Anchorage', 'Fairbanks'], AZ: ['Phoenix', 'Tucson', 'Mesa', 'Chandler'],
  AR: ['Little Rock', 'Fort Smith', 'Fayetteville'], CA: ['Los Angeles', 'San Diego', 'San Jose', 'San Francisco', 'Sacramento', 'Fresno'],
  CO: ['Denver', 'Colorado Springs', 'Aurora', 'Fort Collins'], CT: ['Hartford', 'New Haven', 'Bridgeport', 'Stamford'],
  DE: ['Wilmington', 'Dover', 'Newark'], DC: ['Washington'], FL: ['Jacksonville', 'Miami', 'Tampa', 'Orlando'],
  GA: ['Atlanta', 'Augusta', 'Savannah', 'Columbus'], HI: ['Honolulu'], ID: ['Boise', 'Idaho Falls', 'Nampa'],
  IL: ['Chicago', 'Rockford', 'Peoria', 'Springfield'], IN: ['Indianapolis', 'Fort Wayne', 'Evansville', 'South Bend'],
  IA: ['Des Moines', 'Cedar Rapids', 'Davenport'], KS: ['Wichita', 'Kansas City', 'Topeka', 'Overland Park'],
  KY: ['Louisville', 'Lexington', 'Bowling Green'], LA: ['New Orleans', 'Baton Rouge', 'Shreveport', 'Lafayette'],
  ME: ['Portland', 'Bangor', 'Lewiston'], MD: ['Baltimore', 'Frederick', 'Rockville'], MA: ['Boston', 'Worcester', 'Springfield', 'Lowell'],
  MI: ['Detroit', 'Grand Rapids', 'Lansing', 'Ann Arbor'], MN: ['Minneapolis', 'Saint Paul', 'Rochester', 'Duluth'],
  MS: ['Jackson', 'Gulfport', 'Hattiesburg'], MO: ['Kansas City', 'St. Louis', 'Springfield', 'Columbia'],
  MT: ['Billings', 'Missoula', 'Great Falls'], NE: ['Omaha', 'Lincoln'], NV: ['Las Vegas', 'Reno', 'Henderson'],
  NH: ['Manchester', 'Nashua', 'Concord'], NJ: ['Newark', 'Jersey City', 'Paterson', 'Edison'], NM: ['Albuquerque', 'Las Cruces', 'Santa Fe'],
  NY: ['New York City', 'Buffalo', 'Rochester', 'Syracuse', 'Albany'], NC: ['Charlotte', 'Raleigh', 'Greensboro', 'Durham'],
  ND: ['Fargo', 'Bismarck', 'Grand Forks'], OH: ['Columbus', 'Cleveland', 'Cincinnati', 'Toledo', 'Akron', 'Dayton'],
  OK: ['Oklahoma City', 'Tulsa', 'Norman'], OR: ['Portland', 'Salem', 'Eugene'], PA: ['Philadelphia', 'Pittsburgh', 'Allentown', 'Harrisburg'],
  RI: ['Providence', 'Warwick', 'Cranston'], SC: ['Columbia', 'Charleston', 'Greenville'], SD: ['Sioux Falls', 'Rapid City'],
  TN: ['Nashville', 'Memphis', 'Knoxville', 'Chattanooga'], TX: ['Houston', 'Dallas', 'San Antonio', 'Austin', 'Fort Worth'],
  UT: ['Salt Lake City', 'West Valley City', 'Provo'], VT: ['Burlington', 'Rutland'], VA: ['Virginia Beach', 'Richmond', 'Norfolk', 'Chesapeake'],
  WA: ['Seattle', 'Spokane', 'Tacoma', 'Vancouver'], WV: ['Charleston', 'Huntington', 'Morgantown'], WI: ['Milwaukee', 'Madison', 'Green Bay'],
  WY: ['Cheyenne', 'Casper'],
}

/**
 * The US state an objective names, by its full name ("… distributors in
 * Ohio"). Two-letter codes are not read: "in", "or", "me" and "oh" are words.
 */
export function stateInObjective(objective: string): { code: string; name: string } | null {
  const text = ` ${objective.toLowerCase().replace(/[^a-z]+/g, ' ')} `
  // Longest names first, so "West Virginia" is not read as "Virginia".
  const names = [...US_STATES].sort((a, b) => b[1].length - a[1].length)
  for (const [code, name] of names) {
    if (code === 'WA' && /\bwashington\s+dc\b|\bdc\b/.test(text)) continue
    if (text.includes(` ${name.toLowerCase()} `)) return { code, name }
  }
  return null
}

function clean(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const t = s.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 120) : null
}

function stateCode(region: string | null): string | null {
  if (!region) return null
  const r = region.trim()
  if (/^[A-Z]{2}$/.test(r) && NAME_OF.has(r)) return r
  return CODE_OF.get(r.toLowerCase()) ?? null
}

function fromPostalAddress(a: Record<string, unknown>, sourceUrl: string): CompanyLocation | null {
  const street = clean(a.streetAddress)
  const city = clean(a.addressLocality)
  const regionRaw = clean(a.addressRegion)
  const postalCode = clean(a.postalCode)
  const countryRaw = a.addressCountry
  const country = clean(typeof countryRaw === 'object' && countryRaw ? (countryRaw as Record<string, unknown>).name : countryRaw)
  if (!city && !regionRaw) return null
  const region = stateCode(regionRaw) ?? regionRaw
  const text = [street, city, [region, postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return { text, city, region, postalCode, country, source: 'company website (structured data)', sourceUrl }
}

// "123 Main St, Akron, OH 44301" · "Akron, Ohio 44301" · "Akron, OH 44301-1234"
// A city's words sit on one line; a line break ends the street before it.
const WRITTEN_ADDRESS = new RegExp(
  `(?:(\\d{1,6}[A-Za-z]?[ \\t]+[A-Za-z0-9 .'#-]{2,40}?)[,\\s]+)?([A-Z][A-Za-z.'-]+(?:[ \\t]+[A-Z][A-Za-z.'-]+){0,3}),[ \\t]*(${STATE_CODES}|${STATE_NAMES})\\.?[ \\t]+(\\d{5})(?:-\\d{4})?\\b`,
  'g',
)

/** Street-type words: in "Exchange St. Akron" or "Rausch Dr. Plain City" the city starts after the last one. */
const STREET_WORD = /^(st|street|rd|road|dr|drive|blvd|boulevard|ave|avenue|ct|court|ln|lane|way|pkwy|parkway|hwy|highway|pike|pl|place|cir|circle|ter|terrace|trl|trail|tpke|turnpike|sq|square)\.?$/i

/** The city part of "Rausch Dr. Plain City" — "Plain City". */
export function cityAfterStreet(raw: string): string {
  const tokens = raw.trim().split(/\s+/)
  let last = -1
  tokens.forEach((t, i) => {
    if (STREET_WORD.test(t)) last = i
  })
  return tokens.slice(last + 1).join(' ')
}

const CITY_LABEL =
  /^(?:(?:Corporate|Main|Head|Mailing|Physical|Our|Branch|Sales|Store)\s+)?(?:Headquarters|HQ|Office|Offices|Address|Location|Locations|Visit|Us|Warehouse|Showroom|Branch|Store|Street|Contact)\b\s*/i

/** Every address a page states, structured data first. */
export function locationsOnPage(html: string, pageUrl: string): CompanyLocation[] {
  const out: CompanyLocation[] = []
  const seen = new Set<string>()
  const push = (l: CompanyLocation | null) => {
    if (!l) return
    const k = `${(l.city ?? '').toLowerCase()}|${(l.region ?? '').toLowerCase()}|${l.postalCode ?? ''}`
    if (seen.has(k) || out.length >= 12) return
    seen.add(k)
    out.push(l)
  }

  for (const { node } of jsonLdNodes(extractJsonLd(html))) {
    const addr = node.address
    for (const a of Array.isArray(addr) ? addr : [addr]) {
      if (a && typeof a === 'object') push(fromPostalAddress(a as Record<string, unknown>, pageUrl))
    }
  }

  // Microdata PostalAddress.
  const micro = (prop: string) => html.match(new RegExp(`itemprop=["']${prop}["'][^>]*>([^<]{1,120})<`, 'i'))?.[1] ?? null
  const mLocality = micro('addressLocality')
  if (mLocality) {
    push(fromPostalAddress({ streetAddress: micro('streetAddress'), addressLocality: mLocality, addressRegion: micro('addressRegion'), postalCode: micro('postalCode') }, pageUrl))
  }

  const text = htmlToText(html).replace(/[ \t]+/g, ' ')
  for (const m of text.matchAll(WRITTEN_ADDRESS)) {
    const street = m[1]?.trim() ?? null
    // "Headquarters Akron, OH" — the label before a city is not part of it.
    const city = cityAfterStreet(m[2]!.trim().replace(CITY_LABEL, '').trim())
    if (!city) continue
    const region = stateCode(m[3]!.replace(/\s+/g, ' ')) ?? m[3]!
    const postalCode = m[4]!
    // "Suite 100, Akron" — the street part must look like a street, not a sentence.
    const streetOk = street && /\d/.test(street) && street.split(' ').length <= 7 ? street : null
    push({
      text: [streetOk, city, `${region} ${postalCode}`].filter(Boolean).join(', '),
      city,
      region,
      postalCode,
      country: 'US',
      source: 'company website (address on page)',
      sourceUrl: pageUrl,
    })
  }
  return out
}

/** A page on the same site likely to carry the address: contact, locations, about. */
export function addressPageLink(html: string, pageUrl: string): string | null {
  let best: { url: string; score: number } | null = null
  let host = ''
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
  for (const l of extractLinks(html, 600)) {
    const abs = resolveLink(l.href, pageUrl)
    if (!abs) continue
    try {
      if (new URL(abs).hostname.replace(/^www\./, '') !== host) continue
    } catch {
      continue
    }
    const hay = `${l.text} ${abs}`.toLowerCase()
    const score = /contact/.test(hay) ? 3 : /locations?|branches|find a (store|branch)/.test(hay) ? 2 : /about/.test(hay) ? 1 : 0
    if (score && (!best || score > best.score)) best = { url: abs, score }
  }
  return best?.url ?? null
}

/**
 * The company's location to show, and whether it is inside the area the
 * objective names. With several addresses (branches), one inside the area
 * wins; a company is only "outside" when every address it states is.
 */
export function placeCompany(
  locations: CompanyLocation[],
  area: { code: string; name: string } | null,
  pageText: string,
): { location: CompanyLocation | null; outsideArea: boolean } {
  if (!locations.length) return { location: null, outsideArea: false }
  if (!area) return { location: locations[0]!, outsideArea: false }
  const inside = locations.find((l) => stateCode(l.region) === area.code)
  if (inside) return { location: inside, outsideArea: false }
  const usStated = locations.filter((l) => stateCode(l.region))
  // Only a US address in another state, and no word of the searched state
  // anywhere on the page, puts a company outside the search.
  const mentionsArea = new RegExp(`\\b${area.name.replace(/ /g, '\\s+')}\\b`, 'i').test(pageText)
  return { location: locations[0]!, outsideArea: usStated.length > 0 && usStated.length === locations.length && !mentionsArea }
}

/**
 * A location a listing page prints beside a company ("Akron, OH", "Columbus,
 * Ohio 43215"), kept only when it is written on that page.
 */
export function listingLocation(stated: string | null | undefined, pageText: string, sourceUrl: string): CompanyLocation | null {
  const text = stated?.replace(/\s+/g, ' ').trim()
  if (!text || text.length < 3 || text.length > 160) return null
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!flat(pageText).includes(flat(text))) return null
  const m = text.match(new RegExp(`([A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+){0,3}),\\s*(${STATE_CODES}|${STATE_NAMES})\\b\\.?(?:\\s+(\\d{5}))?`))
  return {
    text,
    city: m ? cityAfterStreet(m[1]!) || null : null,
    region: m ? (stateCode(m[2]!.replace(/\s+/g, ' ')) ?? m[2]!) : null,
    postalCode: m?.[3] ?? null,
    country: m ? 'US' : null,
    source: 'listing page',
    sourceUrl,
  }
}

/** "Akron, OH" — the short form for a list. */
export function shortLocation(l: CompanyLocation): string {
  return [l.city, l.region].filter(Boolean).join(', ') || l.text
}
