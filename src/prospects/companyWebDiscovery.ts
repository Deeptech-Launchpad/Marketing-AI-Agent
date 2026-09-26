import { env } from '../config/env.js'
import { registrableDomain } from '../enrichment/siteIdentity.js'
import { getLlm } from '../llm/index.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import type { PublicSource } from '../research/publicResearch.js'
import { normalizeCompanyName, significantTokens } from '../decisionmakers/companyMatch.js'
import { identifyCompanies, looksLikeCompanySite, readCandidatePage } from './companyIdentification.js'
import { discoveredWebsiteDomain } from './discoveredCompanyAdapter.js'
import { analyseCompanyWebsite, notAnalysed, type ProductPageAnalysis } from './productPageAnalysis.js'
import { STATE_CITIES, stateInObjective, type CompanyLocation } from './companyLocation.js'

// STAGE 1b — OPEN-WEB COMPANY DISCOVERY (2026-09-24 restructure; product-page
// evidence added 2026-09-25).
//
// ProspectSearch (prospectDiscovery.ts) is CRM-only by explicit design: every
// prospect it returns is a row NXT Sales already holds. This is the second,
// additive way a prospect can enter the pipeline — a Sales objective such as
// "Safety and Health companies in the USA" is turned into a public web
// search, and each company it names is verified by fetching that company's
// own site, never taken from a model's prose.
//
//   Web search → company → its own website → one product page →
//   PDP-audit-style analysis → issues → service need → URL + reason + action
//
//   1. DISCOVER — ask the search index where to look. A candidate's identity
//      comes ONLY from the grounding-chunk references getLlm().searchWeb()
//      returns; the model's own prose (modelText) is read for nothing.
//   2. IDENTIFY — fetch each reference ourselves (readPublicSource, the same
//      SSRF-guarded transport Decision Makers and Intent use) and hand the
//      ACTUALLY FETCHED text to a structured generate() call that names the
//      company and judges fit, stating only what that text supports.
//   3. CONFIRM THE WEBSITE — the company's own site, from the domain the page
//      confirmed or a host spelt from the company's own name. A news article
//      or directory listing ABOUT a company is never taken for its website.
//   4. ANALYSE ONE GENUINE PRODUCT — productPageAnalysis.ts opens that
//      website, finds ONE genuine individual product page on it (never a
//      family, category, solution, article or FAQ page), and analyses that
//      product's description, attributes, values and structure. Not a website
//      audit. Whether the company needs the service is decided from THAT
//      product, by a stated rule, not from the search result.
//
// Every candidate the search pointed to is recorded, including the ones that
// stopped short — unreadable page, no website of its own, no product page —
// each with the reason. Dropped candidates would make "found vs. actually
// checked" dishonest.

/**
 * Company websites checked per search when the salesperson names no number.
 * Raised from 25 (2026-09-26): a map search for "electrical distributors in
 * Ohio" lists dozens of businesses, and 25 stopped a search at a quarter of
 * its time budget with most of its results never opened.
 */
const MAX_CANDIDATES_DEFAULT = 60
export const MAX_CANDIDATES_HARD_CAP = 100
/** References each search phrasing may return. */
const REFERENCES_PER_QUERY = 20
/** References read in total, across every phrasing, to identify companies. */
const MAX_READS = 200
/**
 * Company websites checked at the same time. Each is a different company's
 * server, and each company's own pages are still read one at a time.
 */
const CONCURRENCY = 6
/**
 * Wall-clock budget for one search. The queue gives a job fifteen minutes;
 * stopping new work at twelve leaves the companies in progress room to finish.
 */
const TIME_BUDGET_MS = 12 * 60_000


/**
 * The one place a discovery query is composed — plain text, no model call.
 * Mirrors research/publicResearch.ts's queriesFor(): a query is built from
 * facts the caller already holds (here, the objective itself) and nothing
 * a model added.
 *
 * It asks for companies that publish their own products online, because a
 * company with no product pages gives the product-page audit nothing to read.
 */
export function queryFor(objective: string): string {
  return (
    `Find companies that plausibly match this description, each with its own public website that ` +
    `shows the products it makes, distributes or sells: "${objective}". Prefer the companies' own ` +
    `websites and product catalogues over news aggregators, listicles or directories. Only report ` +
    `pages you actually retrieved — do not name a company you did not find a page for.`
  )
}

/**
 * Several phrasings of the same objective. One search returns a handful of
 * companies, mostly the best known; asking for makers, sellers and brands
 * separately reaches the many other companies Sales could approach.
 */
export function queriesFor(objective: string): string[] {
  return [
    queryFor(objective),
    `List manufacturers and brands that make products for: "${objective}". Each must have its own website ` +
      `with a product catalogue of individual product pages. Prefer the companies' own websites over directories ` +
      `or news. Only report pages you actually retrieved.`,
    `Find distributors, suppliers and online stores that sell products for: "${objective}", each with its own ` +
      `website showing individual product pages. Prefer the companies' own websites over marketplaces, directories ` +
      `or news. Only report pages you actually retrieved.`,
    `Find lists, directories and member pages that name many companies matching: "${objective}", with links to ` +
      `each company's own website. Only report pages you actually retrieved.`,
    `Find small and mid-sized companies matching: "${objective}" — regional manufacturers and distributors with ` +
      `their own websites and online product catalogues, not only the largest brands. Only report pages you ` +
      `actually retrieved.`,
    // The way a map search finds businesses: local listings, each with an
    // address, and the branches a distributor lists on its own site.
    `Find local business listings for: "${objective}" — the businesses a map search would show, each with its ` +
      `street address and city and a link to its own website. Cover every city and town in the area named, not ` +
      `only the largest. Only report pages you actually retrieved.`,
    `Find the "locations", "branches" or "find a store" pages of distributors and suppliers matching: ` +
      `"${objective}", each listing its sites with their addresses. Only report pages you actually retrieved.`,
    `Find companies matching: "${objective}" in the member directories of trade associations, chambers of ` +
      `commerce and regional manufacturers' or buyers' guides, with links to each company's own website. Only ` +
      `report pages you actually retrieved.`,
    ...cityQueries(objective),
  ]
}

/**
 * One search per major city of a US state the objective names — how a map
 * search covers a whole state rather than only its best-known businesses.
 * No state named, no city searches.
 */
export function cityQueries(objective: string): string[] {
  const state = stateInObjective(objective)
  if (!state) return []
  return (STATE_CITIES[state.code] ?? []).map(
    (city) =>
      `Find businesses matching: "${objective}" that are located in or near ${city}, ${state.name} — each with its ` +
      `own website and its address. Include local and independent businesses, not only national chains. Only ` +
      `report pages you actually retrieved.`,
  )
}

export async function startCompanyWebDiscovery(input: {
  tenantId: string
  objective: string
  requestedByCrmUserId: string
  requestedCount?: number | null
}): Promise<{ id: string }> {
  const id = newId()
  await prisma.companyDiscoverySearch.create({
    data: {
      id,
      tenantId: input.tenantId,
      objective: input.objective,
      requestedCount: input.requestedCount ?? null,
      requestedByCrmUserId: input.requestedByCrmUserId,
      status: 'queued',
    },
  })
  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.requestedByCrmUserId,
    action: 'company_web_discovery.started',
    resourceType: 'CompanyDiscoverySearch',
    resourceId: id,
    summary: input.objective,
  })
  return { id }
}

/** Queue handler. Never throws: failures are recorded on the search row. */
export async function runCompanyWebDiscovery(searchId: string): Promise<void> {
  const search = await prisma.companyDiscoverySearch.findUnique({ where: { id: searchId } })
  if (!search) return
  if (search.status === 'completed') return

  const log = logger.child({ searchId })

  if (!env.COMPANY_WEB_DISCOVERY_ENABLED) {
    await prisma.companyDiscoverySearch.update({
      where: { id: searchId },
      data: {
        status: 'failed',
        failureReason: 'COMPANY_WEB_DISCOVERY_ENABLED is off, so no open-web search was attempted.',
        finishedAt: new Date(),
      },
    })
    return
  }

  try {
    await prisma.companyDiscoverySearch.update({ where: { id: searchId }, data: { status: 'running' } })

    const maxCompanies = Math.max(1, Math.min(search.requestedCount ?? MAX_CANDIDATES_DEFAULT, MAX_CANDIDATES_HARD_CAP))
    // ── 1. DISCOVER — several phrasings, one merged list ────────────────
    const queriesRun: unknown[] = []
    let costUsd = 0
    let provider = 'gemini'
    let lastFailure: string | null = null
    const references: PublicSource[] = []
    const refsSeen = new Set<string>()
    for (const query of queriesFor(search.objective)) {
      const found = await getLlm().searchWeb({
        query,
        tenantId: search.tenantId,
        feature: 'prospect.discover_companies',
        maxReferences: REFERENCES_PER_QUERY,
      })
      costUsd += found.costUsd
      queriesRun.push(...((found.queriesRun as unknown[]) ?? []))
      if (!found.ok) {
        lastFailure = found.reason ?? 'The search source failed without a reason.'
        continue
      }
      provider = found.provider
      for (const r of found.references) {
        const k = `${r.url}\u0000${(r.title ?? '').toLowerCase()}`
        if (refsSeen.has(r.url) || (r.title && refsSeen.has(k))) continue
        refsSeen.add(r.url)
        if (r.title) refsSeen.add(k)
        references.push({ url: r.url, title: r.title, discoveredVia: provider })
      }
    }

    if (references.length === 0 && lastFailure) {
      await prisma.companyDiscoverySearch.update({
        where: { id: searchId },
        data: {
          status: 'failed',
          queriesRun: queriesRun as never,
          costUsd,
          failureReason: lastFailure,
          finishedAt: new Date(),
        },
      })
      return
    }

    const started = Date.now()
    let websitesAudited = 0
    let inFlight = 0
    let stoppedForTime = false
    // One company, one row: the same site found through two references is
    // the same prospect, and checking it twice would only spend its server.
    const sitesSeen = new Set<string>()

    const record = (
      ref: PublicSource,
      fields: {
        companyName: string
        domain: string | null
        websiteUrl?: string | null
        websiteSummary?: string
        fitAssessment?: { verdict: string; reasons: string[] }
        analysis: ProductPageAnalysis
        /** The location the listing page printed, used only when the company's own website stated none. */
        listingLocation?: CompanyLocation | null
      },
    ) => {
      if (!fields.analysis.companyLocation && fields.listingLocation) {
        fields = { ...fields, analysis: { ...fields.analysis, companyLocation: fields.listingLocation } }
      }
      return prisma.discoveredCompany.upsert({
        where: { tenantId_searchId_discoverySourceUrl: { tenantId: search.tenantId, searchId, discoverySourceUrl: ref.url } },
        create: {
          id: newId(),
          tenantId: search.tenantId,
          companyName: fields.companyName,
          domain: fields.domain,
          sourceQuery: search.objective,
          websiteUrl: fields.websiteUrl ?? undefined,
          websiteSummary: fields.websiteSummary,
          fitAssessment: fields.fitAssessment as never,
          discoverySourceUrl: ref.url,
          discoverySourceTitle: ref.title,
          productPageUrl: fields.analysis.product?.url ?? fields.analysis.reviewUrl ?? null,
          productAnalysis: fields.analysis as never,
          serviceNeed: fields.analysis.serviceNeed,
          status: 'candidate',
          createdByCrmUserId: search.requestedByCrmUserId,
          searchId,
        },
        update: {},
      })
    }

    // One row per company name when no website could be confirmed, so the
    // same company named on ten pages is listed once, not ten times.
    const namesSeen = new Set<string>()
    // One row per unreadable HOST: seven unreadable results from the same
    // site are one fact.
    const unreadableHosts = new Set<string>()

    /**
     * Opens one company's website, analyses one genuine product, records it.
     * The caller has already claimed the site in sitesSeen.
     */
    const checkCompany = async (
      rowRef: PublicSource,
      c: { companyName: string; site: string; summary?: string; fit?: { verdict: string; reasons: string[] }; location?: CompanyLocation | null },
    ): Promise<void> => {
      const websiteUrl = `https://${c.site}/`
      inFlight++
      try {
        // ── 4. ANALYSE ONE GENUINE PRODUCT ──────────────────────────────
        const analysis = await analyseCompanyWebsite({ websiteUrl, objective: search.objective, tenantId: search.tenantId })
        websitesAudited++
        await record(rowRef, {
          companyName: c.companyName,
          domain: c.site,
          websiteUrl: analysis.websiteUrl ?? websiteUrl,
          websiteSummary: c.summary || undefined,
          fitAssessment: c.fit,
          analysis,
          listingLocation: c.location,
        })
        log.info(
          { site: c.site, status: analysis.status, serviceNeed: analysis.serviceNeed, product: analysis.product?.url ?? analysis.reviewUrl },
          'company website checked',
        )
      } finally {
        inFlight--
      }
      // Progress, so the screen can count while the search is still running.
      await prisma.companyDiscoverySearch
        .update({ where: { id: searchId }, data: { totalAssessed: websitesAudited } })
        .catch(() => undefined)
    }

    const full = () => websitesAudited + inFlight >= maxCompanies || Date.now() - started > TIME_BUDGET_MS

    /** One search result, start to finish — possibly several companies. */
    const handle = async (ref: PublicSource): Promise<void> => {
      // ── 2. IDENTIFY ───────────────────────────────────────────────────
      const page = await readCandidatePage(ref)
      if (!page.text) {
        // The result led to a company's own website whose first page could
        // not be read — often one built in the browser. The site is still
        // the candidate: its product pages may read fine, and if they do not,
        // Sales is told so and can open it.
        const landed = page.host ? mainSite(page.host) : null
        if (landed && looksLikeCompanySite(landed) && isEntryPage(page.finalUrl)) {
          const siteKey = registrableDomain(landed)
          if (sitesSeen.has(siteKey) || full()) return
          sitesSeen.add(siteKey)
          const title = ref.title?.trim()
          await checkCompany(ref, { companyName: title && !/^https?:/i.test(title) ? title : landed, site: landed })
          return
        }
        const host = page.host ?? ref.url
        // A directory, social network, job board or search redirect that could
        // not be read is not a company that could not be read: nothing to list.
        if (!looksLikeCompanySite(page.host)) return
        if (unreadableHosts.has(host)) return
        unreadableHosts.add(host)
        await record(ref, {
          companyName: ref.title ?? ref.url,
          domain: null,
          analysis: notAnalysed(
            'source_unreadable',
            `The page the search pointed to could not be read (${page.reason ?? 'no content'}), so no company was identified on it.`,
          ),
        })
        log.info({ url: ref.url, reason: page.reason }, 'candidate page not read')
        return
      }

      const identified = await identifyCompanies({ tenantId: search.tenantId, objective: search.objective, page })
      costUsd += identified.costUsd
      if (identified.companies.length === 0) {
        log.info({ url: page.finalUrl }, 'no matching company identified on this page')
        return
      }

      for (const [i, a] of identified.companies.entries()) {
        if (full()) return
        // Several companies can come from one result; each needs its own row.
        const rowRef: PublicSource = i === 0 ? ref : { ...ref, url: `${ref.url}#company-${i + 1}` }
        const fit = { verdict: a.fitVerdict, reasons: a.reasons }
        const nameKey = normalizeCompanyName(a.companyName)

        // ── 3. CONFIRM THE COMPANY'S OWN WEBSITE ────────────────────────
        const stated = discoveredWebsiteDomain({ companyName: a.companyName, domain: a.website, websiteUrl: page.finalUrl })
        const site = stated ? mainSite(stated) : null
        if (!site) {
          if (namesSeen.has(nameKey)) continue
          namesSeen.add(nameKey)
          await record(rowRef, {
            companyName: a.companyName,
            domain: null,
            websiteUrl: page.finalUrl,
            websiteSummary: a.summary || undefined,
            fitAssessment: fit,
            listingLocation: a.location,
            analysis: notAnalysed(
              'no_website',
              `The search found this company on ${hostLabel(page.finalUrl)}, and that page does not state a website of the company's own — so there was no product page to read.`,
            ),
          })
          continue
        }

        // Checked and claimed in one synchronous step, so two workers can
        // never take the same company.
        const siteKey = registrableDomain(site.replace(/^www\./i, ''))
        if (sitesSeen.has(siteKey)) continue
        sitesSeen.add(siteKey)
        namesSeen.add(nameKey)

        if (a.fitVerdict === 'unlikely_fit') {
          const websiteUrl = `https://${site}/`
          await record(rowRef, {
            companyName: a.companyName,
            domain: site,
            websiteUrl,
            websiteSummary: a.summary || undefined,
            fitAssessment: fit,
            analysis: notAnalysed(
              'not_relevant',
              'The page gave no clear evidence this company matches the search, so its website was not checked.',
              { websiteUrl },
            ),
          })
          continue
        }

        await checkCompany(rowRef, { companyName: a.companyName, site, summary: a.summary, fit, location: a.location })
      }
    }

    // ── 2–4, a few companies at a time ──────────────────────────────────
    let next = 0
    const pending = references.slice(0, MAX_READS)
    const worker = async () => {
      while (next < pending.length) {
        if (websitesAudited + inFlight >= maxCompanies) return
        if (Date.now() - started > TIME_BUDGET_MS) {
          stoppedForTime = true
          return
        }
        const ref = pending[next++]!
        try {
          await handle(ref)
        } catch (err) {
          log.info({ url: ref.url, err: (err as Error).message }, 'candidate could not be processed')
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

    // One company, one row: a company one directory listed without a website
    // and another source found WITH its website is the same prospect. The
    // bare listing row goes; the row whose website was checked stays.
    const merged = await dropDuplicateListings(search.tenantId, searchId).catch(() => 0)
    if (merged) log.info({ merged }, 'listing-only rows merged into the same company found with its website')

    const needing = await prisma.discoveredCompany
      .count({ where: { tenantId: search.tenantId, searchId, serviceNeed: { in: ['needed', 'possible'] } } })
      .catch(() => 0)

    await prisma.companyDiscoverySearch.update({
      where: { id: searchId },
      data: {
        status: 'completed',
        queriesRun: queriesRun as never,
        totalCandidatesFound: references.length,
        totalAssessed: websitesAudited,
        costUsd,
        finishedAt: new Date(),
      },
    })

    await audit({
      tenantId: search.tenantId,
      actorType: 'agent',
      action: 'company_web_discovery.completed',
      resourceType: 'CompanyDiscoverySearch',
      resourceId: searchId,
      summary:
        `${references.length} candidate page(s) found, ${websitesAudited} company website(s) checked, ` +
        `${needing} that may need the service` +
        (stoppedForTime ? '; stopped early at the time budget' : ''),
    })

    log.info({ found: references.length, websitesAudited, needing, costUsd, stoppedForTime }, 'company web discovery completed')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err: message }, 'company web discovery failed')
    await prisma.companyDiscoverySearch
      .update({
        where: { id: searchId },
        data: { status: 'failed', failureReason: message, finishedAt: new Date() },
      })
      .catch(() => undefined)
  }
}

/** A company's name as a comparison key: its distinctive words, order-free. */
export function companyKey(name: string): string {
  const tokens = significantTokens(name)
  return (tokens.length ? tokens : normalizeCompanyName(name).split(' ')).filter(Boolean).sort().join(' ')
}

/**
 * Removes this search's "no website" rows whose company the search also found
 * with a website. Only listing-only rows are ever removed. Returns how many.
 */
export async function dropDuplicateListings(tenantId: string, searchId: string): Promise<number> {
  const rows = await prisma.discoveredCompany.findMany({
    where: { tenantId, searchId },
    select: { id: true, companyName: true, domain: true, productAnalysis: true },
  })
  const withSite = new Set(rows.filter((r) => r.domain).map((r) => companyKey(r.companyName)))
  const dupes = rows.filter(
    (r) => !r.domain && (r.productAnalysis as { status?: string } | null)?.status === 'no_website' && withSite.has(companyKey(r.companyName)),
  )
  if (!dupes.length) return 0
  await prisma.discoveredCompany.deleteMany({ where: { tenantId, searchId, id: { in: dupes.map((d) => d.id) } } })
  return dupes.length
}

/**
 * A page a company's site would be entered by: its homepage, a shallow
 * section, or a product page — not a news article or blog post that merely
 * sits on some other site.
 */
function isEntryPage(url: string): boolean {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
    if (segs.some((s) => /^(news|blog|blogs|article|articles|press|story|stories|insights|magazine)$/i.test(s))) return false
    return segs.length <= 2 || /\/(product|products|p|item|dp)\//i.test(url)
  } catch {
    return false
  }
}

/**
 * The company's shopping site for a host found on one of its side sites:
 * pressroom.grainger.com, ir.example.com and careers.example.com belong to
 * the company, but its products are on its main site.
 */
function mainSite(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '')
  const first = h.split('.')[0] ?? ''
  if (/^(pressroom|newsroom|press|news|media|ir|investors?|careers?|jobs|blog|support|help|about|corporate|community)$/.test(first)) {
    return `www.${registrableDomain(h)}`
  }
  return h
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return 'another site'
  }
}
