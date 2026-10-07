import { env } from '../config/env.js'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'
import { htmlToText } from './htmlToText.js'
import { fetchPageRaw } from './pageFetch.js'
import { webSearch } from './webSearch.js'

// THE PUBLIC RESEARCH LAYER — ONE COMPANY-SEARCH IMPLEMENTATION, TWO ENGINES.
//
// Decision Makers and Intent Signals both need the same thing: given a company
// we already hold facts about, find PUBLIC PAGES about it and read them. Before
// this module each engine could only read pages it could guess the URL of —
// conventional /about and /team paths on the company's own domain — so a
// company whose site has no reachable team page produced nothing at all, even
// where the open web plainly had material.
//
// That is a recall gap, not a correctness bug, and the fix must not become one.
// So the layer is built around a single rule, which is the same rule the rest
// of Stage 4 already runs on:
//
//   A SEARCH ENGINE SAYS WHERE TO LOOK. IT NEVER SAYS WHAT IS TRUE.
//
// Everything here is therefore two separate steps that are never allowed to
// merge:
//
//   1. DISCOVER — ask the search index for URLs. The result is a list of
//      links and nothing else. No claim about the company survives this step,
//      because no claim is read out of it: URLs come from the provider's
//      retrieval metadata, never from a model's prose. See llmPort.searchWeb.
//
//   2. READ — fetch each URL OURSELVES, through the same SSRF-guarded,
//      redirect-capped, byte-capped transport the audit crawler uses, and hand
//      the bytes to whichever reader the calling engine already trusts. For
//      Decision Makers that is readPeopleFromPage, unchanged, which verifies
//      every returned character against those bytes.
//
// The consequence worth stating plainly: a person or an event discovered this
// way is evidenced by a page WE fetched, quoted verbatim, at a URL a reader can
// open. A search snippet is never the evidence — it is the reason we went and
// looked. That is what keeps "found via public web research" exactly as
// checkable as "found on the company's own about page", which is the only
// basis on which widening the net is safe at all.
//
// WHAT THIS MODULE WILL NOT DO
//   · It never sends a bare "who works at X" question. A query is composed
//     from facts the caller already holds, and the answer it wants is links.
//   · It never reads a platform that requires a login. A login wall is
//     recorded as a login wall (see LOGIN_WALL_MARKERS) and never summarised.
//   · It has no company-specific behaviour, no allowlist and no special case.
//     Every company goes through the identical query template.

/** A public page a search index pointed at, before anything has been read. */
export interface PublicSource {
  /** The URL as discovered. May be a provider redirect; fetching resolves it. */
  url: string
  /** The index's own title for it. Never a model paraphrase. */
  title: string | null
  /** Which search source pointed here. */
  discoveredVia: string
}

/** A public page after this layer has fetched it itself. */
export interface ReadPublicSource extends PublicSource {
  /** Where the fetch actually landed, after redirects. The citable URL. */
  finalUrl: string
  /** Plain text of the page, as WE fetched it. The only thing evidence may quote. */
  text: string
  /** True when the destination served a sign-in interstitial rather than content. */
  loginWall: boolean
  /** Why nothing was read, when nothing was. */
  reason: string | null
}

export interface PublicResearchResult {
  /**
   * `available` — the search ran (it may still have found nothing).
   * `unauthorized` — no search capability is configured.
   * `unavailable` — there was not enough company context to compose a query.
   * `error` — the search source failed.
   */
  status: 'available' | 'unauthorized' | 'unavailable' | 'error'
  provider: string
  queriesRun: string[]
  sources: PublicSource[]
  costUsd: number
  /** Required whenever status is not `available`. */
  reason: string | null
}

/**
 * Pages that are a sign-in form rather than content.
 *
 * Checked against text WE fetched, so this is an observation about what the
 * host served a logged-out reader — not a guess from the domain name. A page
 * matching this is reported as a login wall and its text is discarded: half a
 * sign-in form summarised as "company news" would be a fabrication, and the
 * honest record is that the platform showed us nothing.
 */
const LOGIN_WALL_MARKERS = [
  'sign in to continue',
  'log in to continue',
  'sign in to see',
  'log in to see',
  'join linkedin',
  'sign up to see',
  'create an account to',
  'please log in',
  'you must be logged in',
  'login to view',
  'log in or sign up to view',
]

/** Minimum readable text before a page counts as content at all. */
const MIN_CONTENT_CHARS = 200

export function looksLikeLoginWall(text: string): boolean {
  const t = text.toLowerCase()
  if (LOGIN_WALL_MARKERS.some((m) => t.includes(m))) return true
  // A very short page whose words are dominated by sign-in vocabulary is the
  // same thing wearing different words.
  if (t.length < MIN_CONTENT_CHARS && /\b(sign in|log in|login|sign up)\b/.test(t)) return true
  return false
}

/**
 * What kind of research a caller wants, expressed as query shapes.
 *
 * The templates are the ONLY place a query is composed, so neither engine
 * grows its own company-search logic — and so a change to how this platform
 * asks the open web about a company is one edit in one file.
 *
 * Every template takes the company's own name and domain and nothing else.
 * There is no branch on which company it is, because there is nothing to
 * branch on: the same three sentences are built for every company on earth.
 */
export type ResearchTopic =
  | 'people'
  | 'business_activity'
  | 'hiring'
  | 'product_specifications'
  | 'external_signals'
  | 'community_questions'
  | 'social_activity'

function queriesFor(topic: ResearchTopic, companyName: string, domain: string | null, accounts: string[] = []): string[] {
  const where = domain ? `${companyName} (${domain})` : companyName
  switch (topic) {
    case 'product_specifications':
      // For this topic `companyName` carries the PRODUCT descriptor the audited
      // page published (brand, name, part number) — never a guess. The answer
      // wanted is the manufacturer's own pages and data sheets, as links.
      return [
        `Find the manufacturer's official product page, technical data sheet or specification listing for the product "${companyName}". ` +
          `Prefer the brand or manufacturer's own website and authorised distributors that publish full technical specifications. ` +
          `Only report pages you actually retrieved.`,
      ]
    case 'people':
      // Asks for PAGES that name people, not for the names themselves. The
      // difference matters: the second has an answer whether or not one
      // exists, and this platform would rather have nothing than that.
      //
      // THREE SEARCHES, IN THE ORDER THEY ARE WORTH READING.
      //
      // One query found the team page of companies that have one and nothing
      // at all for the rest — a small distributor whose site is four pages of
      // catalogue, whose directors are on a registry, and whose managing
      // director is quoted in a trade article. Each of those is a different
      // search, and the page budget is spent on whatever comes back first, so
      // the most likely to name somebody goes first:
      //
      //   1. the company's own site — authoritative about its own staff;
      //   2. registry and directory listings — where a director is a matter
      //      of record rather than of marketing;
      //   3. the roles this platform actually approaches, named in the wild;
      //   4. org-chart and professional-directory pages (added 2026-09-29).
      //
      // Every one of them asks for RETRIEVED PAGES and says so twice. No name
      // is read from any of these answers: the pages come back as links, this
      // service fetches them, and the verifier reads the bytes. A model that
      // replies with a confident list of names and no page has contributed
      // nothing, by construction.
      return [
        domain
          ? `On the website ${domain}, find the pages that name people at ${companyName} together with their job ` +
            `titles — about, team, leadership, management, staff and contact pages. Only report pages you ` +
            `actually retrieved from that site.`
          : `Find the pages on the official website of ${companyName} that name its people together with their ` +
            `job titles. Only report pages you actually retrieved.`,
        `Find company-registry, company-filing or business-directory pages that list the directors, company ` +
          `officers or registered management of ${where}. Only report pages you actually retrieved.`,
        `Find public pages that name the managing director, owner, general manager, purchasing manager, ` +
          `procurement lead, product manager or e-commerce manager of ${where} — press releases, trade-press ` +
          `articles, interviews, conference listings or membership directories. Do not guess and do not name ` +
          `anyone in your answer: only report pages you actually retrieved.`,
        // 4. (2026-09-29) Public org-chart and professional-directory pages,
        //    which list a person WITH their title and employer in one line —
        //    the shape the verifier can tie to this company. Profiles behind a
        //    sign-in wall are recorded as such and read for nothing.
        `Find publicly viewable org-chart, leadership or professional-directory pages (for example The Org, ` +
          `Crunchbase people pages, trade-association member listings) that list e-commerce, digital, marketing, ` +
          `product, catalogue or purchasing staff or leaders of ${where}, each with their job title. Do not name ` +
          `anyone in your answer: only report pages you actually retrieved.`,
      ]
    case 'hiring':
      return [
        `Find publicly posted job openings at ${where}. ` +
          `Include the company's own careers pages and public job boards. ` +
          `Only report postings you actually retrieved.`,
      ]
    case 'external_signals':
      // What OTHER people publish about the company — never its own site,
      // which other sources already read. Four places, four searches, each
      // asking for pages and never for conclusions.
      return [
        `Find public discussions about ${where} or its products on Reddit, industry forums, Q&A sites and online ` +
          `communities — customer questions, complaints, product experiences, comparisons or recommendations. ` +
          `Prefer the most recent posts (the last 12 months). Only report pages you actually retrieved.`,
        `Find customer reviews of ${where} or its products on review platforms and marketplaces that publish ` +
          `reviews. Prefer the most recent reviews. Only report pages you actually retrieved.`,
        `Find recent news, trade-press articles and blog posts about ${where} — expansion, acquisitions, new ` +
          `locations, new product launches, leadership or business changes, and technology or platform changes ` +
          `such as a new website, e-commerce platform or ERP. Prefer the last 12 months. Only report pages you ` +
          `actually retrieved.`,
        `Find public LinkedIn posts, company updates or social media posts by or about ${where}. ` +
          `Only report pages you actually retrieved.`,
        // (2026-10-07) What OTHER businesses publish naming this company: a
        // software vendor's case study, a supplier's or partner's announcement,
        // a trade association's member news. That is where a change such as
        // "X partnered with Y to implement NetSuite" is written down — the
        // company's own site often never says it.
        `Find case studies, customer stories, testimonials, press releases or partner announcements published by ` +
          `software vendors, implementation partners, suppliers, distributors or trade associations that name ` +
          `${where} as a customer, partner or member. Only report pages you actually retrieved.`,
      ]
    case 'community_questions':
      // The communities of "Community Engagement & Trust-Building System"
      // (section 2) that can be read without signing in — forums and Reddit;
      // LinkedIn and Facebook groups are manual-only by that document's own
      // rule (section 4). Asked about THIS company and the topics of its six
      // phrase clusters (section 3.1). Pages only, never conclusions.
      return [
        `Find forum threads, Reddit posts and community questions posted by people at ${where}, or about ` +
          `${where}'s website, online catalogue or product data — on Reddit (r/ecommerce, r/TechSEO, r/SEO, ` +
          `r/bigseo, r/shopify, r/manufacturing, r/supplychain, r/Machinists, r/AskEngineers), Google Search ` +
          `Central Help Community, Shopify, BigCommerce, WooCommerce and Adobe Commerce (Magento) community forums, ` +
          `Moz Community, WebmasterWorld, Eng-Tips, CR4, Practical Machinist, element14 Community and Modern ` +
          `Distribution Management (MDM). Only report pages you actually retrieved.`,
        `Find public questions or discussions that mention ${where} together with product data, product ` +
          `information, structured data or schema markup, JSON-LD, Google Merchant Center feed errors, missing ` +
          `product attributes or GTINs, PIM, catalogue data clean-up, or products not showing up in ChatGPT, Google ` +
          `AI Overviews, Perplexity or Gemini. Only report pages you actually retrieved.`,
        `Find public forum or community posts in which ${where} is compared with Grainger, McMaster-Carr or Amazon ` +
          `Business on search visibility, or in which buyers say they cannot find its products or part numbers ` +
          `online. Only report pages you actually retrieved.`,
      ]
    case 'social_activity':
      // (2026-10-07) The company's OWN recent posts, on the accounts its own
      // website or NXT Sales record links to. Individual post pages, never the
      // profile: a profile's follower count or bio is not activity.
      // One search per account (up to four): one search across all of them
      // found a company's posts on one run and none on the next (2026-10-07).
      return (accounts.length ? accounts.slice(0, 4) : [null]).map(
        (account) =>
          `Find the most recent individual public posts, updates and videos published by ${where} on ` +
          `${account ? `its own social media account ${account}` : 'its own social media accounts'} — announcements, ` +
          `product launches and promotions, catalogue or website updates, events, partnerships and news. Prefer ` +
          `the last 12 months. Link to each individual post, not to the profile. Only report pages you actually ` +
          `retrieved.`,
      )
    case 'business_activity':
      return [
        `Find recent public announcements, press releases, news articles or company posts about ${where} — ` +
          `for example new product ranges, expansions, partnerships, site openings or catalogue changes. ` +
          `Only report pages you actually retrieved.`,
      ]
  }
}

/**
 * Step 1: ask the index where to look.
 *
 * Returns links. It cannot return a fact about the company, because it never
 * reads one: the caller gets URLs and goes and fetches them.
 */
export async function discoverPublicSources(input: {
  tenantId: string
  companyName: string
  domain: string | null
  topic: ResearchTopic
  /** For 'social_activity': the company's own account addresses. */
  accounts?: string[]
  maxSources?: number
  feature: string
}): Promise<PublicResearchResult> {
  const none = { queriesRun: [], sources: [], costUsd: 0 }

  if (!env.PUBLIC_RESEARCH_ENABLED) {
    return {
      status: 'unauthorized',
      provider: 'public_research',
      ...none,
      reason: 'PUBLIC_RESEARCH_ENABLED is off, so no public web research was attempted.',
    }
  }

  const companyName = input.companyName.trim()
  // A one-character company name produces a query that matches the whole web.
  // Refusing is better than researching the wrong company.
  if (companyName.length < 2) {
    return {
      status: 'unavailable',
      provider: 'public_research',
      ...none,
      reason: 'The company has no usable name on record, so no search query could be composed from facts.',
    }
  }

  const maxSources = Math.max(1, Math.min(input.maxSources ?? env.PUBLIC_RESEARCH_MAX_SOURCES, MAX_SOURCES_PER_SEARCH))
  const queries = queriesFor(input.topic, companyName, input.domain, input.accounts)
  const seen = new Set<string>()
  const sources: PublicSource[] = []
  const queriesRun: string[] = []
  let costUsd = 0
  const failures: string[] = []
  let provider = 'public_research'

  // EVERY QUERY GETS A SHARE OF THE BUDGET.
  //
  // Filling the list in query order sounds harmless and is not: a company's
  // own site has a dozen crawlable pages, so the first search returned six of
  // them - about, contact, faq, terms, shipping - and the searches that would
  // have found the registry listing naming the managing director never
  // contributed a single URL. The budget was spent before the useful question
  // was asked.
  //
  // So each query's results are kept separately and then interleaved: the
  // first hit of every query, then the second of every query, and so on. A
  // query that returns nothing costs the others nothing, and a single-query
  // topic behaves exactly as it did before.
  const perQuery: PublicSource[][] = []

  for (const query of queries) {
    const found: PublicSource[] = []
    // A configured search API takes precedence when one exists, because a
    // dedicated index is a better instrument than a model's search tool. It
    // is `none` in every environment so far, and says so.
    const api = await webSearch(query)
    if (api.ok && api.hits.length > 0) {
      provider = api.provider
      queriesRun.push(query)
      for (const hit of api.hits) {
        if (seen.has(hit.url)) continue
        seen.add(hit.url)
        found.push({ url: hit.url, title: hit.title || null, discoveredVia: api.provider })
      }
      perQuery.push(found)
      continue
    }

    const search = await getLlm().searchWeb({
      query,
      tenantId: input.tenantId,
      feature: input.feature,
      maxReferences: maxSources,
    })
    costUsd += search.costUsd
    provider = search.provider
    if (!search.ok) {
      failures.push(search.reason ?? 'The search source failed without a reason.')
      perQuery.push(found)
      continue
    }
    queriesRun.push(...(search.queriesRun.length ? search.queriesRun : [query]))
    for (const ref of search.references) {
      if (seen.has(ref.url)) continue
      seen.add(ref.url)
      found.push({ url: ref.url, title: ref.title, discoveredVia: search.provider })
    }
    perQuery.push(found)
  }

  for (let depth = 0; sources.length < maxSources; depth++) {
    const anyLeft = perQuery.some((list) => list.length > depth)
    if (!anyLeft) break
    for (const list of perQuery) {
      const next = list[depth]
      if (!next || sources.length >= maxSources) continue
      sources.push(next)
    }
  }

  if (sources.length === 0 && failures.length > 0) {
    return { status: 'error', provider, queriesRun, sources: [], costUsd, reason: failures.join(' ') }
  }

  return {
    status: 'available',
    provider,
    queriesRun,
    sources,
    costUsd,
    // "Searched and found nothing" is a real, reportable outcome and must
    // never be allowed to read as "this company has no such thing".
    reason: sources.length === 0 ? NO_EVIDENCE : null,
  }
}

/**
 * The sentence a caller shows when the open web produced nothing.
 *
 * Exported so both engines say the SAME thing, and so neither can drift into
 * phrasing that turns an absence of evidence into evidence of absence.
 */
export const NO_EVIDENCE = 'No additional public evidence found.'

/**
 * The most links one discovery may return. Was 10 (2026-10-07): with half of
 * what a search finds refusing a server reader (HTTP 403, sign-in walls), ten
 * links left a company with two or three pages actually read.
 */
export const MAX_SOURCES_PER_SEARCH = 20

/**
 * Step 2: fetch one discovered URL ourselves and return what it served.
 *
 * Nothing about the discovery step is trusted here. The URL goes through the
 * same guarded transport as everything else — per-hop SSRF revalidation,
 * redirect cap, timeout, streamed byte cap — and the text returned is the text
 * this service received, which is the only text any caller may quote.
 */
export async function readPublicSource(source: PublicSource): Promise<ReadPublicSource> {
  const base = { ...source, finalUrl: source.url, text: '', loginWall: false }
  try {
    const res = await fetchPageRaw(source.url)
    if (!res.ok) {
      // Where the request LANDED, kept on a failure too. A search result is
      // usually a redirect link; dropping the destination left every refused
      // page recorded under that opaque link, and hid a Reddit thread from the
      // reader built for it (2026-10-07).
      return { ...base, finalUrl: res.finalUrl ?? source.url, reason: res.reason ?? 'The page could not be fetched.' }
    }
    const finalUrl = res.finalUrl ?? source.url
    const text = htmlToText(res.html).trim()

    if (looksLikeLoginWall(text)) {
      // Recorded, never summarised. What the platform showed a logged-out
      // reader IS the observation.
      return {
        ...base,
        finalUrl,
        loginWall: true,
        reason: 'This page served a sign-in wall to a logged-out reader, so no content was read from it.',
      }
    }
    if (text.length < MIN_CONTENT_CHARS) {
      return { ...base, finalUrl, reason: 'The page carried too little readable text to use.' }
    }
    return { ...base, finalUrl, text, reason: null }
  } catch (err) {
    // A blocked destination throws out of the SSRF guard. It is a normal
    // outcome for a link we were never going to be allowed to follow.
    const message = (err as Error).message
    logger.info({ url: source.url, err: message }, 'public source not read')
    return { ...base, reason: message }
  }
}

/**
 * Reads discovered sources in order until `readable` of them returned content,
 * or `maxAttempts` were tried — so a page that refuses a server reader (HTTP
 * 403, a sign-in wall, an empty script shell) no longer uses up the budget
 * meant for pages that can be read. Every attempt is returned, read or not,
 * so the caller still records what refused.
 *
 * - Several search links often lead to the SAME page; it is returned once, so
 *   it is neither read twice nor quoted twice.
 * - `counts` says which pages count towards `readable` — a caller that skips
 *   the company's own pages does not spend its budget on them.
 * - `budgetMs` stops starting new fetches once that long has passed, so a run
 *   always finishes well inside the job's time limit.
 *
 * Sequential for the same reason as readPublicSources.
 */
export async function readPublicSourcesUntil(
  sources: PublicSource[],
  opts: { readable: number; maxAttempts: number; budgetMs?: number; counts?: (page: ReadPublicSource) => boolean },
  read: (source: PublicSource) => Promise<ReadPublicSource> = readPublicSource,
): Promise<ReadPublicSource[]> {
  const started = Date.now()
  const counts = opts.counts ?? ((page: ReadPublicSource) => Boolean(page.text))
  const out: ReadPublicSource[] = []
  const seen = new Set<string>()
  let readOk = 0
  for (const source of sources.slice(0, Math.max(0, opts.maxAttempts))) {
    if (readOk >= opts.readable) break
    if (opts.budgetMs !== undefined && Date.now() - started >= opts.budgetMs) break
    const page = await read(source)
    const key = samePageKey(page.finalUrl)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(page)
    if (counts(page)) readOk++
  }
  return out
}

/** One key for the same page reached by different links: no fragment, no trailing slash, no "www.". */
function samePageKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return url
  }
}

/**
 * Fetches several discovered sources, in sequence and bounded.
 *
 * Sequential on purpose: these are other people's servers, reached because a
 * search pointed at them, and a burst of parallel requests is how a research
 * layer turns into a nuisance.
 */
export async function readPublicSources(
  sources: PublicSource[],
  maxPages = env.PUBLIC_RESEARCH_MAX_PAGES,
): Promise<ReadPublicSource[]> {
  const out: ReadPublicSource[] = []
  for (const source of sources.slice(0, Math.max(0, maxPages))) {
    out.push(await readPublicSource(source))
  }
  return out
}
