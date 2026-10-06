import { z } from 'zod'
import { env } from '../config/env.js'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'
import { isEventAboutCompany, isHistoryStatement } from './eventReader.js'

// COMMUNITY QUESTIONS — THE COMMUNITY ENGAGEMENT & TRUST-BUILDING METHOD.
//
// Source: "AltiusNxt — Community Engagement & Trust-Building System"
// (September 2026). Someone at a distributor asks, in a forum or subreddit,
// "why doesn't our product show up when someone asks ChatGPT for a part
// number?" — describing exactly what AltiusNxt solves. This finds those
// questions for ONE company, and keeps only what the method would flag:
//
//   Filter one — WHAT is it about? Six phrase clusters (section 3.1):
//     1 AI / LLM discoverability ...... high   → flagged on its own
//     2 Structured data / schema ...... high   → flagged on its own
//     3 Data enrichment / PIM ......... medium → flagged only with filter two
//     4 B2B ecommerce search pain ..... medium → flagged only with filter two
//     5 Competitive / benchmark ....... medium → flagged only with filter two
//     6 General digital transformation  low    → never a signal; counted only
//   Filter two — WHO is asking? A target title visible on the page, or a
//   community whose audience already tells the industry (section 3.2).
//   Excluded outright: job postings, consumer chatbot questions, ChatGPT
//   subscription pricing, vendors promoting their own PIM/SEO tools.
//
// The cluster is decided HERE, by the method's own phrases, from the quote —
// never from a model's opinion. A model only finds candidate passages on a
// page this service fetched; each must be on the page verbatim, name the
// company, and pass these rules. A flagged question is an opportunity to help,
// not a lead (section 1): the angle says so.

export type ClusterId = 1 | 2 | 3 | 4 | 5 | 6

export const CLUSTERS: Record<ClusterId, { label: string; weight: 'high' | 'medium' | 'low'; patterns: RegExp[] }> = {
  1: {
    label: 'AI / LLM discoverability',
    weight: 'high',
    patterns: [
      // "chatgpt doesn't show", "perplexity doesn't recommend", "gemini doesn't find", "cited by chatgpt"…
      /\b(chat ?gpt|perplexity|gemini|copilot|claude|llms?|ai overviews?|ai search|ai shopping|ai answers?|ai agents?|ai assistants?|ai tools?|generative (ai|search))\b[\s\S]{0,80}\b(show(s|ing)? up|shows?|appear(s|ing)?|find(s|ing)?|found|recommend(s|ed|ing)?|rank(s|ed|ing)?|cit(e|es|ed|ing)|mention(s|ed)?|visib(le|ility)|invisible|surfac(e|es|ed|ing))\b/i,
      /\b(show(ing)? up|appear(ing)?|rank(ing)?|cited|visib(le|ility)|invisible)\b[\s\S]{0,60}\b(chat ?gpt|perplexity|gemini|copilot|ai overviews?|ai search|ai answers?|llms?)\b/i,
      /\b(ai|llm) (search )?visibility\b/i,
    ],
  },
  2: {
    label: 'Structured data / schema',
    weight: 'high',
    patterns: [
      /\bschema(\.org)?( markup)?\b[\s\S]{0,60}\bproducts?\b|\bproducts?\b[\s\S]{0,60}\bschema(\.org)?( markup)?\b/i,
      /\bjson-?ld\b/i,
      /\bstructured data\b/i,
      /\brich (results?|snippets?)\b/i,
      /\b(google )?merchant (center|centre)\b[\s\S]{0,60}\b(errors?|disapproved|rejected|warnings?|missing)\b|\b(product|merchant|shopping) feed errors?\b/i,
      /\b(missing|no) (product )?attributes?\b|\bproduct attributes? (are )?missing\b/i,
      /\b(gtins?|upcs?|ean)\b[\s\S]{0,30}\b(missing|required|errors?|invalid)\b|\b(missing|invalid) (gtins?|upcs?)\b/i,
    ],
  },
  3: {
    label: 'Data enrichment / PIM',
    weight: 'medium',
    patterns: [
      /\b(product )?data enrichment\b/i,
      /\bsku data( quality)?\b|\bproduct data quality\b|\bdata quality\b[\s\S]{0,40}\b(products?|skus?|catalog(ue)?)\b/i,
      /\bcatalog(ue)? (data )?(clean ?up|cleanse|cleansing)\b|\bclean(ing)? up (our |the )?(product )?(catalog(ue)?|product data)\b/i,
      /\bpim\b|\bproduct information management\b/i,
      /\bincomplete product (data|information|descriptions?)\b/i,
      /\bproduct (data )?feeds?\b|\bproduct content( management)?\b/i,
    ],
  },
  4: {
    label: 'B2B ecommerce visibility / search pain',
    weight: 'medium',
    patterns: [
      /\b(customers?|buyers?|people|users) (can'?t|cannot|can not|don'?t|do not|struggle to) find (our |the |their )?(products?|parts?|items?|part numbers?)\b/i,
      /\b(website|site|store|web ?shop) (is )?not converting\b|\bnot converting\b[\s\S]{0,40}\b(website|site|store)\b/i,
      /\bb2b (search|seo)( visibility)?\b/i,
      /\bproduct pages? (is |are )?(not|aren'?t|isn'?t) (ranking|indexed|showing)\b/i,
      /\b(site|product|catalog(ue)?) search (is )?(broken|useless|poor|bad|not working)\b|\bfitment search\b/i,
    ],
  },
  5: {
    label: 'Competitive / benchmark language',
    weight: 'medium',
    patterns: [
      /\b(grainger|mcmaster(-carr)?|amazon business|zoro|fastenal|msc direct)\b[\s\S]{0,80}\b(show(s)? up|ranks? (higher|above|first)|outranks?|beats? us|above us|instead of us|losing (customers|sales|business))\b/i,
      /\blosing (customers|sales|business) to (amazon( business)?|grainger|mcmaster)\b/i,
      /\bcompetitors?\b[\s\S]{0,40}\b(show(s)? up|rank(s)?|appear(s)?)\b[\s\S]{0,40}\b(we don'?t|we do not|not us|and we don'?t)\b/i,
    ],
  },
  6: {
    label: 'General digital transformation',
    weight: 'low',
    patterns: [
      /\bdigital transformation\b/i,
      /\be-?commerce strategy\b/i,
      /\bmoderni[sz](e|es|ed|ing) (our |the )?(product )?catalog(ue)?\b/i,
      /\bai in b2b( commerce)?\b/i,
    ],
  },
}

/** What the method excludes automatically (section 3.1). */
const EXCLUDED: Array<[RegExp, string]> = [
  [/\b(we'?re hiring|we are hiring|job (opening|posting|opportunity)|apply now|now hiring|join our team)\b/i, 'a job posting'],
  [/\bbest (ai )?chat ?bot for (customer (service|support))\b|\bcustomer service chat ?bot\b/i, 'a consumer chatbot question'],
  [/\bchat ?gpt (plus|pro|team|enterprise)\b[\s\S]{0,40}\b(price|pricing|cost|subscription|worth it)\b|\bchat ?gpt subscription\b/i, 'a ChatGPT subscription question'],
  [/\b(book a demo|free trial|request a demo|sign up (now|today)|our (pim|seo|platform|tool|software) (helps|lets|makes))\b/i, 'a vendor promoting its own tool'],
]

/** Target titles (section 3.2) — the visible title of whoever asked. */
const TARGET_TITLE =
  /\b(e-?commerce (manager|director|lead|specialist|coordinator)|director,? (of )?e-?commerce|head of (b2b|e-?commerce|digital)|digital (product|commerce|marketing|operations) (manager|specialist|director|lead)|product data (manager|specialist|lead)|e-?commerce and product data manager|vp (of )?(product management|marketing|sales|e-?commerce|digital)|evp (of )?marketing|marketing operations (manager|director)|product owner|director (of )?it|it manager|senior director,? digital|director digital operations|founder|co-?founder|owner|president|ceo|general manager|managing director|b2b product marketing)\b/i

/**
 * Communities whose audience already tells the industry (section 3.2: "a post
 * inside MDM's distributor community, or r/Machinists, already tells us the
 * industry"). The industrial and distribution communities of section 2.1.
 */
const INDUSTRY_COMMUNITY: Array<[RegExp, string]> = [
  [/(^|\.)eng-tips\.com$/, 'Eng-Tips'],
  [/(^|\.)practicalmachinist\.com$/, 'Practical Machinist'],
  [/(^|\.)cr4\.globalspec\.com$|(^|\.)engineering\.com$/, 'CR4 / Engineering.com'],
  [/(^|\.)element14\.com$|(^|\.)community\.element14\.com$/, 'element14 Community'],
  [/(^|\.)se\.com$|schneider-electric\./, 'Schneider Electric Community'],
  [/(^|\.)industryweek\.com$/, 'IndustryWeek'],
  [/(^|\.)manufacturing\.net$/, 'Manufacturing.net'],
  [/(^|\.)mdm\.com$/, 'Modern Distribution Management (MDM)'],
  [/(^|\.)asq\.org$/, 'ASQ'],
  [/(^|\.)smrp\.org$/, 'SMRP'],
  [/(^|\.)ida-assoc\.org$/, 'Industrial Distribution Association'],
  [/(^|\.)naw\.org$/, 'NAW'],
  [/(^|\.)ismworld\.org$/, 'ISM'],
  [/(^|\.)xometry\.com$/, 'Xometry'],
  [/(^|\.)thomasnet\.com$/, 'ThomasNet'],
]
const INDUSTRY_SUBREDDIT = /\/r\/(manufacturing|machinists|industrialengineering|logistics|supplychain|mechanicalengineering|askengineers|electricians|hvac|plumbing|engineering)\b/i

/** Where the question was asked, by name, and whether that community already tells the industry. */
export function communityOf(url: string): { name: string; industryEvident: boolean } {
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase().replace(/^www\./, '')
    path = u.pathname
  } catch {
    return { name: 'Web page', industryEvident: false }
  }
  if (/(^|\.)reddit\.com$/.test(host)) {
    const sub = path.match(/\/r\/([A-Za-z0-9_]+)/)?.[1]
    return { name: sub ? `r/${sub}` : 'Reddit', industryEvident: INDUSTRY_SUBREDDIT.test(path) }
  }
  for (const [re, name] of INDUSTRY_COMMUNITY) if (re.test(host)) return { name, industryEvident: true }
  return { name: host, industryEvident: false }
}

/** Typographic quotes as plain ones, so "can’t" reads like "can't". */
function plainQuotes(text: string): string {
  return text.replace(/[’‘ʼ]/g, "'").replace(/[“”]/g, '"')
}

/** Every cluster the quote's own words match, strongest first. */
export function clustersIn(text: string): ClusterId[] {
  const t = plainQuotes(text)
  return ([1, 2, 3, 4, 5, 6] as ClusterId[]).filter((id) => CLUSTERS[id].patterns.some((p) => p.test(t)))
}

export function excludedAs(text: string): string | null {
  const t = plainQuotes(text)
  for (const [re, why] of EXCLUDED) if (re.test(t)) return why
  return null
}

/**
 * The method's decision point (section 5, step 5). Cluster 1 or 2 → flag.
 * Only 3/4/5 → flag only when the persona matched. Only 6, or nothing → log only.
 */
export function decide(clusters: ClusterId[], persona: { matched: boolean }): { flag: boolean; cluster: ClusterId | null; why: string } {
  const top = clusters[0] ?? null
  if (top === null) return { flag: false, cluster: null, why: 'matches none of the six phrase clusters' }
  if (top === 1 || top === 2) return { flag: true, cluster: top, why: `cluster ${top} (${CLUSTERS[top].label}) is flagged on its own` }
  if (top === 6) return { flag: false, cluster: 6, why: 'only cluster 6 (general digital transformation) — logged, never flagged' }
  return persona.matched
    ? { flag: true, cluster: top, why: `cluster ${top} (${CLUSTERS[top].label}) with a matching persona` }
    : { flag: false, cluster: top, why: `cluster ${top} (${CLUSTERS[top].label}) without a matching persona — logged, not flagged` }
}

// ── Reading one page ───────────────────────────────────────────────────────

const Found = z.object({
  questions: z
    .array(
      z.object({
        quote: z.string().min(15).max(700),
        posterTitle: z.string().max(160).nullable().optional(),
        statedDate: z.string().max(40).nullable().optional(),
      }),
    )
    .max(8)
    .default([]),
})

export interface CommunityQuestion {
  quote: string
  cluster: ClusterId
  clusterLabel: string
  weight: 'high' | 'medium' | 'low'
  clustersMatched: ClusterId[]
  posterTitle: string | null
  persona: { matched: boolean; basis: string | null }
  statedDate: string | null
  decision: string
}

function flatten(s: string): string {
  return s.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]/g, '')
}

/**
 * Applies the method to what a reader proposed. Pure: the page text is the
 * only authority, and every rule is the document's.
 */
export function judgeQuestions(
  raw: Array<{ quote: string; posterTitle?: string | null; statedDate?: string | null }>,
  pageText: string,
  pageUrl: string,
  company: { name: string; host: string | null },
): { flagged: CommunityQuestion[]; logged: number; excluded: number; rejected: number } {
  const page = flatten(pageText)
  const community = communityOf(pageUrl)
  const flagged: CommunityQuestion[] = []
  const seen = new Set<string>()
  let logged = 0
  let excluded = 0
  let rejected = 0
  for (const r of raw) {
    const quote = r.quote.replace(/\s+/g, ' ').trim()
    const q = flatten(quote)
    // On the page, about THIS company, and not history.
    const event = { sourceSentence: quote, summary: quote }
    if (q.length < 15 || !page.includes(q) || !isEventAboutCompany(event, pageText, { ...company, pageOnCompanyDomain: false }) || isHistoryStatement(event)) {
      rejected++
      continue
    }
    if (seen.has(q)) continue
    seen.add(q)
    if (excludedAs(quote)) {
      excluded++
      continue
    }
    const title = r.posterTitle?.trim() || null
    const titleOnPage = title && page.includes(flatten(title)) ? title : null
    const persona = titleOnPage && TARGET_TITLE.test(titleOnPage)
      ? { matched: true, basis: `the poster's title: ${titleOnPage}` }
      : community.industryEvident
        ? { matched: true, basis: `asked in ${community.name}, whose audience already tells the industry` }
        : { matched: false, basis: null }
    const clusters = clustersIn(quote)
    const d = decide(clusters, persona)
    if (!d.flag || d.cluster === null) {
      logged++
      continue
    }
    const date = r.statedDate?.trim()
    flagged.push({
      quote: quote.slice(0, 600),
      cluster: d.cluster,
      clusterLabel: CLUSTERS[d.cluster].label,
      weight: CLUSTERS[d.cluster].weight,
      clustersMatched: clusters,
      posterTitle: titleOnPage,
      persona,
      statedDate: date && page.includes(flatten(date)) ? date : null,
      decision: d.why,
    })
  }
  return { flagged, logged, excluded, rejected }
}

/** One page, one model read. Never throws: a failure is "nothing read". */
export async function readCommunityQuestions(input: {
  text: string
  sourceUrl: string
  tenantId: string
  company: { name: string; host: string | null }
}): Promise<{ flagged: CommunityQuestion[]; logged: number; excluded: number; rejected: number; costUsd: number; reason: string | null; failed?: boolean }> {
  const none = { flagged: [], logged: 0, excluded: 0, rejected: 0 }
  const text = input.text.slice(0, 12_000).trim()
  if (!env.PUBLIC_RESEARCH_ENABLED) return { ...none, costUsd: 0, reason: 'PUBLIC_RESEARCH_ENABLED is off.' }
  if (text.length < 200) return { ...none, costUsd: 0, reason: 'The page carried too little text to read.' }
  try {
    const result = await getLlm().generate({
      promptKey: 'intent.read_community_questions',
      variables: {
        companyName: input.company.name,
        companyDomain: input.company.host ? ` (${input.company.host})` : '',
        sourceUrl: input.sourceUrl,
        pageText: text,
      },
      schema: Found,
      feature: 'intent_community_questions',
      tenantId: input.tenantId,
    })
    const parsed = Found.safeParse(result.data)
    if (!parsed.success) return { ...none, costUsd: result.costUsd, reason: 'The reading did not match the expected shape.', failed: true }
    return { ...judgeQuestions(parsed.data.questions, text, input.sourceUrl, input.company), costUsd: result.costUsd, reason: null }
  } catch (err) {
    logger.info({ err: (err as Error).message, sourceUrl: input.sourceUrl }, 'community page read failed; the run continues')
    return { ...none, costUsd: 0, reason: `The page could not be read: ${(err as Error).message}`, failed: true }
  }
}

/** Why a flagged question matters — fixed per cluster, never a model's view. */
export const CLUSTER_WHY: Record<ClusterId, string> = {
  1: 'Someone connected to this company asked in public why its products do not show up in AI answers (ChatGPT, Google AI Overviews, Perplexity, Gemini). That is the problem AI-discoverability work addresses; it shows the question has been asked, not that they have decided to act.',
  2: 'Someone connected to this company asked in public about product structured data — schema, JSON-LD, merchant-feed errors or missing attributes. That is a concrete product-data problem; it shows the question has been asked, not that they have decided to act.',
  3: 'Someone connected to this company discussed product data enrichment, catalogue clean-up or PIM in public, in a place whose audience matches our target buyers. It suggests a live product-data effort; it does not establish a need.',
  4: 'Someone connected to this company described buyers not finding its products online, in a place whose audience matches our target buyers. It points to a discoverability problem; it does not establish a need.',
  5: 'Someone connected to this company compared its search visibility with a larger competitor in public, in a place whose audience matches our target buyers. It suggests the gap is felt; it does not establish a need.',
  6: '',
}

/** The method's own guidance for the reply (section 1 and step 8). */
export const COMMUNITY_ANGLE =
  'Answer the question on that forum with genuinely useful help, with no pitch and no product mention. It becomes a lead only if they follow up or ask to go deeper.'
