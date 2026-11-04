import { env } from '../config/env.js'
import { getCrm } from '../crm/index.js'
import { resolveCompanySource } from '../crm/companySource.js'
import type { CrmCompany } from '../crm/types.js'
import { RECENT_ACTIVITY_DAYS } from '../intent/providers/crmProvider.js'
import { hasRecentReply } from './replies.js'
import { logger } from '../platform/logger.js'

// WARM LEADS — THE REPRESENTATIVE TEST SAMPLE (2026-10-31).
//
// "The first 10 companies" were all small bathroom suppliers from one country,
// added together — it tested nothing but that corner of the CRM. The test is
// now a fixed-size sample chosen to COVER the cases the rule must handle:
//
//   customer      an existing customer (a won deal)         — must be ruled out
//   open_deal     an open deal                              — must be ruled out
//   recent_reply  an inbound email in the last 90 days      — the strongest warm signal
//   no_website    no website, or only a social profile     — cannot be read at all
//   general       an ordinary company with a website        — spread over countries and industries
//
// Repeatable: the same seed on the same CRM data picks the same companies,
// whatever order the CRM lists them in. When the CRM holds fewer companies of a
// kind than wanted, the sample says so (coverage / notes) instead of padding.
//
// Reads only: the company list, the deal list and the email activity of the few
// companies with recent activity, all through the CRM's existing read API.

export const SAMPLE_SIZE = 30
export const DEFAULT_QUOTAS: Record<Exclude<Stratum, 'general'>, number> = { customer: 3, open_deal: 3, recent_reply: 4, no_website: 4 }
/** Companies listed per request when reading the company list (the CRM allows up to 500). */
const LIST_PAGE = 500
const MAX_LIST_PAGES = 40
/**
 * NXT Sales' own windows for a company's NEWEST activity. A company with an inbound email in the last 90 days
 * has its newest activity inside that window too, so only those companies can have one — and the most recently
 * active are the likeliest, so they are read first.
 */
const ACTIVITY_WINDOWS = ['last_7', 'last_14', 'last_30', 'last_60', 'last_90']

export type Stratum = 'customer' | 'open_deal' | 'recent_reply' | 'no_website' | 'general'

export interface SampleCandidate {
  id: string
  name: string
  country: string | null
  industry: string | null
  website: 'website' | 'social_only' | 'none'
  customer: boolean
  openDeal: boolean
  recentReply: boolean
}

export interface SamplePick {
  id: string
  name: string
  country: string | null
  industry: string | null
  website: SampleCandidate['website']
  /** Every stratum this company stands for. */
  strata: Stratum[]
  /** The one it was chosen for. */
  pickedFor: Stratum
}

export interface SampleResult {
  seed: number
  size: number
  picks: SamplePick[]
  coverage: Array<{ stratum: Stratum; wanted: number; filled: number; available: number }>
  countries: number
  industries: number
  /** Plain sentences about what could not be covered, and why. */
  notes: string[]
  /** What was read to build it. */
  pool: { companies: number; withDeals: number; recentActivity: number; emailsRead: number; emailReadFailures: number; listTruncated: boolean; replyProbeTruncated: boolean }
}

const STRATUM_TEXT: Record<Stratum, string> = {
  customer: 'an existing customer (a won deal)',
  open_deal: 'an open deal',
  recent_reply: `a reply from a person in the last ${RECENT_ACTIVITY_DAYS} days`,
  no_website: 'no website or only a social profile',
  general: 'an ordinary company with a website',
}

// ── Pure selection ──────────────────────────────────────────────────────────

/** mulberry32: a small seeded generator; the same seed gives the same sequence everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

const norm = (v: string | null) => (v ?? '').trim().toLowerCase() || '(none)'

const isMember = (c: SampleCandidate, s: Stratum): boolean =>
  s === 'customer' ? c.customer :
  s === 'open_deal' ? c.openDeal :
  s === 'recent_reply' ? c.recentReply :
  s === 'no_website' ? c.website !== 'website' :
  c.website === 'website' && !c.customer && !c.openDeal && !c.recentReply

export function selectSample(
  candidates: SampleCandidate[],
  opts: { seed: number; size?: number; quotas?: Partial<Record<Exclude<Stratum, 'general'>, number>> },
): Pick<SampleResult, 'seed' | 'size' | 'picks' | 'coverage' | 'countries' | 'industries' | 'notes'> {
  const size = opts.size ?? SAMPLE_SIZE
  // The default quotas are for SAMPLE_SIZE; a different size keeps the same proportions (30 stays exactly as it was).
  const scaled = size === SAMPLE_SIZE ? DEFAULT_QUOTAS : (Object.fromEntries(Object.entries(DEFAULT_QUOTAS).map(([k, v]) => [k, Math.max(1, Math.round((v * size) / SAMPLE_SIZE))])) as typeof DEFAULT_QUOTAS)
  const quotas = { ...scaled, ...(opts.quotas ?? {}) }
  // Canonical order first, so the CRM's listing order can never change the result.
  const all = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const picked = new Map<string, SamplePick>()
  const countryCount = new Map<string, number>()
  const industryCount = new Map<string, number>()
  const available = (s: Stratum) => all.filter((c) => isMember(c, s)).length

  const take = (s: Stratum, want: number) => {
    // Seeded order within the stratum; among equals the least-represented
    // country, then industry, goes first — so countries and industries are covered before any repeats.
    const pool = shuffled(all.filter((c) => isMember(c, s) && !picked.has(c.id)), seededRandom((opts.seed ^ hash(s)) >>> 0))
    const have = () => [...picked.values()].filter((p) => p.strata.includes(s)).length
    while (picked.size < size && have() < want && pool.length) {
      let best = 0
      let bestKey: [number, number, number] | null = null
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i]!
        // Countries AND industries are balanced together: the least-represented combination first (the two counts added),
        // then the less-represented country, then industry. Country alone left whole industries out when countries were plentiful.
        const cc = countryCount.get(norm(c.country)) ?? 0
        const ic = industryCount.get(norm(c.industry)) ?? 0
        const key: [number, number, number] = [cc + ic, cc, ic]
        if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
          best = i
          bestKey = key
        }
      }
      const [c] = pool.splice(best, 1)
      if (!c) break
      const strata = (['customer', 'open_deal', 'recent_reply', 'no_website', 'general'] as Stratum[]).filter((x) => isMember(c, x))
      picked.set(c.id, { id: c.id, name: c.name, country: c.country, industry: c.industry, website: c.website, strata, pickedFor: s })
      countryCount.set(norm(c.country), (countryCount.get(norm(c.country)) ?? 0) + 1)
      industryCount.set(norm(c.industry), (industryCount.get(norm(c.industry)) ?? 0) + 1)
    }
  }

  // The scarcest kinds first, so a company that is both rare and common is spent on the rare one.
  const special = (Object.keys(quotas) as Array<Exclude<Stratum, 'general'>>).sort((a, b) => available(a) - available(b) || (a < b ? -1 : 1))
  for (const s of special) take(s, quotas[s])
  take('general', size)
  // Still short (a small CRM): anything left, so the sample is as large as the CRM allows.
  if (picked.size < size) {
    const rest = shuffled(all.filter((c) => !picked.has(c.id)), seededRandom((opts.seed ^ hash('rest')) >>> 0))
    for (const c of rest) {
      if (picked.size >= size) break
      picked.set(c.id, { id: c.id, name: c.name, country: c.country, industry: c.industry, website: c.website, strata: (['customer', 'open_deal', 'recent_reply', 'no_website', 'general'] as Stratum[]).filter((x) => isMember(c, x)), pickedFor: 'general' })
    }
  }

  const picks = [...picked.values()]
  const coverage = (['customer', 'open_deal', 'recent_reply', 'no_website', 'general'] as Stratum[]).map((stratum) => ({
    stratum,
    wanted: stratum === 'general' ? Math.max(0, size - Object.values(quotas).reduce((n, q) => n + q, 0)) : quotas[stratum],
    filled: picks.filter((p) => p.strata.includes(stratum)).length,
    available: available(stratum),
  }))
  const notes: string[] = []
  for (const c of coverage) {
    if (c.stratum === 'general') continue
    if (c.filled < c.wanted) {
      notes.push(
        c.available === 0
          ? `No company in the candidates has ${STRATUM_TEXT[c.stratum]}, so none could be included (wanted ${c.wanted}).`
          : `Only ${c.filled} of ${c.wanted} wanted could be included: only ${c.available} candidate(s) have ${STRATUM_TEXT[c.stratum]}.`,
      )
    }
  }
  if (picks.length < size) notes.push(`Only ${picks.length} companies were available for a sample of ${size}.`)
  return {
    seed: opts.seed,
    size,
    picks,
    coverage,
    countries: new Set(picks.map((p) => norm(p.country))).size,
    industries: new Set(picks.map((p) => norm(p.industry))).size,
    notes,
  }
}

// ── Reading the CRM ─────────────────────────────────────────────────────────

const log = logger.child({ module: 'warmleads-sample' })

export async function allCompanies(query: { lastActivity?: string } = {}, maxPages = MAX_LIST_PAGES): Promise<{ items: CrmCompany[]; truncated: boolean }> {
  const crm = getCrm()
  const items: CrmCompany[] = []
  let total = Infinity
  for (let page = 1; page <= maxPages && items.length < total; page++) {
    const res = await crm.searchCompanies({ ...query, page, limit: LIST_PAGE })
    total = res.total
    items.push(...res.items)
    if (res.items.length < LIST_PAGE) return { items, truncated: false }
  }
  return { items, truncated: items.length < total }
}

/**
 * The representative sample of the CRM, or as much of it as the CRM holds.
 * Read-only. The companies come back with the sample so a run can be started from it.
 */
/** One record per company id, chosen without regard to the order the CRM listed them in. */
export function dedupeById(items: CrmCompany[]): CrmCompany[] {
  const best = new Map<string, CrmCompany>()
  const better = (a: CrmCompany, b: CrmCompany) => {
    const ua = a.updatedAt ?? ''
    const ub = b.updatedAt ?? ''
    if (ua !== ub) return ua > ub
    return JSON.stringify(a) < JSON.stringify(b)
  }
  for (const c of items) {
    const cur = best.get(c.id)
    if (!cur || better(c, cur)) best.set(c.id, c)
  }
  return [...best.values()]
}

export async function buildSample(opts: { seed: number; size?: number }): Promise<{ sample: SampleResult; companies: Map<string, CrmCompany> }> {
  const crm = getCrm()
  const read = await allCompanies()
  // Paging a live CRM by offset can return the same company twice. One copy is kept, chosen by a rule that does not depend on
  // the order the CRM answered in (the most recently updated; a tie goes to the smaller text), so the sample stays reproducible.
  const listed = { ...read, items: dedupeById(read.items) }
  const byId = new Map(listed.items.map((c) => [c.id, c]))

  // Deals: one read of every deal; a company is a customer with a won deal, and has an open deal with any other not-lost stage.
  const deals = await crm.exportDeals()
  const dealState = new Map<string, { won: boolean; open: boolean }>()
  for (const d of deals) {
    if (!d.companyId) continue
    const s = dealState.get(d.companyId) ?? { won: false, open: false }
    if (d.stage === 'Won') s.won = true
    else if (d.stage !== 'Lost') s.open = true
    dealState.set(d.companyId, s)
  }

  // Replies: only a company with recent activity can have an inbound email in the window, so only those are
  // read — the most recently active first, up to the cap. Said in the result when the cap stopped the search.
  const cap = env.WARM_LEADS_REPLY_PROBE_CAP
  const probe: CrmCompany[] = []
  const seenActive = new Set<string>()
  let recentActivity = 0
  let probeTruncated = false
  for (const window of ACTIVITY_WINDOWS) {
    if (probe.length >= cap) {
      probeTruncated = true
      break
    }
    const page = await allCompanies({ lastActivity: window }, 12)
    const fresh = page.items.filter((c) => !seenActive.has(c.id))
    for (const c of fresh) seenActive.add(c.id)
    recentActivity += fresh.length
    const ordered = shuffled(fresh, seededRandom((opts.seed ^ hash('probe:' + window)) >>> 0))
    for (const c of ordered) {
      if (probe.length >= cap) {
        probeTruncated = true
        break
      }
      probe.push(c)
    }
    if (page.truncated) probeTruncated = true
  }
  const replied = new Set<string>()
  let emailReadFailures = 0
  await Promise.all(
    probe.map(async (c) => {
      try {
        const emails = await crm.listActivities({ companyId: c.id, type: 'email' })
        // A reply is a message a person wrote: a bounce or an auto-reply does not count (replies.ts).
        if (hasRecentReply(emails)) replied.add(c.id)
      } catch (err) {
        emailReadFailures++
        log.warn({ crmCompanyId: c.id, message: (err as Error).message }, 'emails could not be read for the sample')
      }
    }),
  )

  const candidates: SampleCandidate[] = listed.items
    .filter((c) => c.name?.trim())
    .map((c) => {
      const src = resolveCompanySource(c)
      const d = dealState.get(c.id)
      return {
        id: c.id,
        name: c.name,
        country: c.country,
        industry: c.industry,
        website: src.websiteUrl ? 'website' : src.socialSources.length ? 'social_only' : 'none',
        customer: d?.won ?? false,
        openDeal: d?.open ?? false,
        recentReply: replied.has(c.id),
      }
    })

  const picked = selectSample(candidates, { seed: opts.seed, size: opts.size })
  if (listed.truncated) {
    picked.notes.push(`The company list was cut off after ${listed.items.length.toLocaleString()} companies, so only those could be sampled. The pilot is not drawn from the whole CRM.`)
  }
  if (read.items.length !== listed.items.length) {
    picked.notes.push(`${(read.items.length - listed.items.length).toLocaleString()} repeated company record(s) in the CRM list were ignored.`)
  }
  if (emailReadFailures > 0) {
    picked.notes.push(`The emails of ${emailReadFailures.toLocaleString()} companies could not be read, so any reply from them is not reflected in the "recent reply" group.`)
  }
  if (probeTruncated) {
    picked.notes.push(
      `Replies were looked for in the ${probe.length.toLocaleString()} most recently active of ${recentActivity.toLocaleString()}${recentActivity > probe.length ? '+' : ''} companies with activity in the last ${RECENT_ACTIVITY_DAYS} days (limit WARM_LEADS_REPLY_PROBE_CAP=${cap}); a company with a reply outside those was not seen.`,
    )
  }
  return {
    sample: {
      ...picked,
      pool: {
        companies: candidates.length,
        withDeals: dealState.size,
        recentActivity,
        emailsRead: probe.length - emailReadFailures,
        emailReadFailures,
        listTruncated: listed.truncated,
        replyProbeTruncated: probeTruncated,
      },
    },
    companies: byId,
  }
}
