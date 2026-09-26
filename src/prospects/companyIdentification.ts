import { z } from 'zod'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'
import { fetchPageRaw } from '../research/pageFetch.js'
import { htmlToText } from '../research/htmlToText.js'
import { looksLikeLoginWall, type PublicSource } from '../research/publicResearch.js'
import { extractLinks } from '../websiteaudit/htmlStructure.js'
import { resolveLink } from '../websiteaudit/urls.js'
import { squash } from './productReader.js'
import { listingLocation, type CompanyLocation } from './companyLocation.js'

// WHICH COMPANIES DOES THIS PAGE NAME?
//
// A search result is often not a company's own site but a list — a supplier
// directory, a "top manufacturers" article, an association's member page. One
// such page can name ten real prospects, each with a link to its website.
// Reading only one company per page is why a search found a handful.
//
// Evidence rules, the same as everywhere in discovery:
//   · a company counts only if its name is written on the page we fetched;
//   · its website counts only if THIS page states it — in its text or as one
//     of its links. A domain is never guessed from a name here.

const MIN_TEXT = 200
const MAX_COMPANIES_PER_PAGE = 10

/**
 * Hosts that are never a company's own website. Extended 2026-09-26 with the
 * job boards, map apps, data vendors and content hosts a wider, map-style
 * search began to surface ("monster.com", "waze.com", "craft.co" were being
 * listed as companies); and no government, university or military host is a
 * prospect.
 */
const NOT_A_COMPANY_SITE =
  /(^|\.)(wikipedia\.org|wikimedia\.org|facebook\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|instagram\.com|pinterest\.com|tiktok\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|alibaba\.com|walmart\.com|thomasnet\.com|yelp\.com|bbb\.org|bloomberg\.com|crunchbase\.com|zoominfo\.com|dnb\.com|google\.[a-z.]+|apple\.com|reddit\.com|medium\.com|forbes\.com|reuters\.com|prnewswire\.com|businesswire\.com|globenewswire\.com|glassdoor\.com|indeed\.com|mapquest\.com|manta\.com|opencorporates\.com|monster\.com|ziprecruiter\.com|careerbuilder\.com|simplyhired\.com|waze\.com|craft\.co|pitchbook\.com|owler\.com|rocketreach\.co|apollo\.io|signalhire\.com|bizapedia\.com|buzzfile\.com|yellowpages\.com|superpages\.com|chamberofcommerce\.com|globalspec\.com|archiexpo\.com|hubspotusercontent[a-z0-9-]*\.net|[a-z0-9-]+\.(gov|edu|mil)|gov|edu|mil)$/i

export interface CandidatePage {
  finalUrl: string
  host: string | null
  text: string
  /** Links to OTHER sites, with their anchor text — how a list names each company's website. */
  links: Array<{ host: string; text: string }>
  reason: string | null
}

/** Fetches one search result, keeping its outbound links as well as its text. Never throws. */
export async function readCandidatePage(ref: PublicSource): Promise<CandidatePage> {
  const empty = { finalUrl: ref.url, host: hostOf(ref.url), text: '', links: [] }
  try {
    const res = await fetchPageRaw(ref.url)
    // Where the search's redirect actually led, even when that page could not
    // be read — the caller may still recognise it as a company's own site.
    const finalUrl = res.finalUrl ?? ref.url
    if (!res.ok) return { ...empty, finalUrl, host: hostOf(finalUrl), reason: res.reason ?? 'The page could not be fetched.' }
    const text = htmlToText(res.html).trim()
    if (looksLikeLoginWall(text)) {
      return { ...empty, finalUrl, host: hostOf(finalUrl), reason: 'This page served a sign-in wall to a logged-out reader, so no content was read from it.' }
    }
    if (text.length < MIN_TEXT) {
      return { ...empty, finalUrl, host: hostOf(finalUrl), reason: 'The page carried too little readable text to use.' }
    }

    const here = hostOf(finalUrl)
    const links: CandidatePage['links'] = []
    const seen = new Set<string>()
    for (const l of extractLinks(res.html, 1500)) {
      const abs = resolveLink(l.href, finalUrl)
      const host = abs ? hostOf(abs) : null
      if (!host || host === here || NOT_A_COMPANY_SITE.test(host)) continue
      const k = `${host}\u0000${l.text.toLowerCase().trim()}`
      if (seen.has(k)) continue
      seen.add(k)
      links.push({ host, text: l.text.replace(/\s+/g, ' ').trim().slice(0, 80) })
      if (links.length >= 200) break
    }
    return { finalUrl, host: here, text, links, reason: null }
  } catch (err) {
    // A blocked destination throws out of the SSRF guard.
    return { ...empty, reason: (err as Error).message }
  }
}

const Identified = z.object({
  companies: z
    .array(
      z.object({
        companyName: z.string().min(1),
        website: z.string().nullable().optional(),
        summary: z.string().default(''),
        fitVerdict: z.enum(['likely_fit', 'possible_fit', 'unlikely_fit']),
        reasons: z.array(z.string()).max(6).default([]),
        location: z.string().nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
})

export interface IdentifiedCompany {
  companyName: string
  /** Stated by this page for this company, verified against its text or links. Null when it states none. */
  website: string | null
  summary: string
  fitVerdict: 'likely_fit' | 'possible_fit' | 'unlikely_fit'
  reasons: string[]
  /** The city and state this page prints for the company, verified as written on it. Null when it prints none. */
  location: CompanyLocation | null
}

/**
 * Keeps only what the page supports: the name must be written on it, and a
 * website must appear in its text or among its links — or be the page's own
 * host, when the page is the company's own site.
 */
export function verifyIdentified(raw: z.infer<typeof Identified>, page: CandidatePage): IdentifiedCompany[] {
  const text = squash(page.text)
  const linkHosts = new Set(page.links.map((l) => bare(l.host)))
  const out: IdentifiedCompany[] = []
  const names = new Set<string>()

  for (const c of raw.companies) {
    const name = c.companyName.trim()
    const n = squash(name)
    if (n.length < 2 || !text.includes(n) || names.has(n)) continue
    names.add(n)

    let website: string | null = null
    const claimed = c.website ? hostOf(c.website) : null
    if (claimed && !NOT_A_COMPANY_SITE.test(claimed)) {
      const b = bare(claimed)
      const onPage = linkHosts.has(b) || text.includes(squash(b)) || (page.host !== null && bare(page.host) === b)
      if (onPage) website = b
    }

    out.push({
      companyName: name.slice(0, 200),
      website,
      summary: (c.summary ?? '').trim().slice(0, 600),
      fitVerdict: c.fitVerdict,
      reasons: (c.reasons ?? []).map((r) => r.trim()).filter(Boolean).slice(0, 3),
      location: listingLocation(c.location, page.text, page.finalUrl),
    })
    if (out.length >= MAX_COMPANIES_PER_PAGE) break
  }
  return out
}

/** One model call per page. Never throws: a failure is "nothing identified", reported by the caller. */
export async function identifyCompanies(input: {
  tenantId: string
  objective: string
  page: CandidatePage
}): Promise<{ companies: IdentifiedCompany[]; costUsd: number }> {
  const { page } = input
  try {
    const result = await getLlm().generate({
      promptKey: 'prospect.identify_companies',
      variables: {
        objective: input.objective,
        sourceUrl: page.finalUrl,
        pageText: page.text.slice(0, 14_000),
        links: page.links.map((l) => `${l.text || '(no text)'} → ${l.host}`).join('\n') || '(none)',
      },
      schema: Identified,
      feature: 'prospect.identify_companies',
      tenantId: input.tenantId,
    })
    const parsed = Identified.safeParse(result.data)
    return { companies: parsed.success ? verifyIdentified(parsed.data, page) : [], costUsd: result.costUsd }
  } catch (err) {
    logger.info({ err: (err as Error).message, url: page.finalUrl }, 'company identification failed')
    return { companies: [], costUsd: 0 }
  }
}

/**
 * Whether an unreadable search result landed on what is plainly a company's
 * own site: a real host, not the search engine's redirect, and not a site
 * that is never a company's own (encyclopedias, social networks, marketplaces).
 */
export function looksLikeCompanySite(host: string | null): boolean {
  if (!host) return false
  if (/(^|\.)(vertexaisearch\.cloud\.google\.com|googleusercontent\.com)$/i.test(host)) return false
  return !NOT_A_COMPANY_SITE.test(host)
}

function hostOf(value: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

function bare(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}
