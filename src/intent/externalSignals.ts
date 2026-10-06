import { z } from 'zod'
import { env } from '../config/env.js'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'
import { isEventAboutCompany, isHistoryStatement } from './eventReader.js'
import type { SignalCategory, SourceType } from './types.js'

// INTENT FROM WHAT OTHER PEOPLE PUBLISH ABOUT A COMPANY.
//
// The company's own site says what the company wants to say. Forums, Reddit,
// review platforms, news, blogs and public social posts say what its
// customers, its market and the press say — complaints about its product
// information, people researching suppliers, an expansion reported in the
// trade press. That is often the stronger signal, and it is where this looks.
//
// The standard of proof does not move:
//   · a signal is a VERBATIM quote from a page this service fetched itself;
//   · the quote, or the text right around it, must name the company;
//   · a date is kept only if the page states it;
//   · the "why it matters" line is a fixed sentence per kind, composed here —
//     never a model's opinion — so it can never claim more than the source.

export const EXTERNAL_KINDS = [
  'product_discussion',
  'customer_complaint',
  'buying_research',
  'expansion',
  'hiring',
  'technology_change',
  'product_launch',
  'business_change',
] as const
export type ExternalKind = (typeof EXTERNAL_KINDS)[number]

const ReadSignals = z.object({
  signals: z
    .array(
      z.object({
        kind: z.enum(EXTERNAL_KINDS),
        quote: z.string().min(10).max(600),
        statedDate: z.string().max(40).nullable().optional(),
      }),
    )
    .max(12)
    .default([]),
})

export interface ExternalReading {
  kind: ExternalKind
  quote: string
  /** Only a date the page itself states. */
  statedDate: string | null
}

/** Letters and digits only, lower-cased — for comparing what a page SAYS. */
function flatten(s: string): string {
  return s.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]/g, '')
}

/**
 * Keeps only what the page states about THIS company: the quote must be on
 * the page, must name the company in or near it, and must not be history.
 */
export function verifyReadings(
  raw: Array<{ kind: ExternalKind; quote: string; statedDate?: string | null }>,
  pageText: string,
  company: { name: string; host: string | null },
): { readings: ExternalReading[]; rejected: number } {
  const page = flatten(pageText)
  const readings: ExternalReading[] = []
  let rejected = 0
  const seen = new Set<string>()
  for (const r of raw) {
    const q = flatten(r.quote)
    const grounded = q.length >= 12 && page.includes(q)
    const event = { sourceSentence: r.quote, summary: r.quote }
    const about = grounded && isEventAboutCompany(event, pageText, { ...company, pageOnCompanyDomain: false })
    if (!grounded || !about || isHistoryStatement(event)) {
      rejected++
      continue
    }
    if (seen.has(q)) continue
    seen.add(q)
    const date = r.statedDate?.trim()
    readings.push({
      kind: r.kind,
      quote: r.quote.trim().slice(0, 500),
      statedDate: date && page.includes(flatten(date)) ? date : null,
    })
  }
  return { readings, rejected }
}

/** Reads one fetched third-party page. Never throws: a failure is "nothing read". */
export async function readExternalSignals(input: {
  text: string
  sourceUrl: string
  tenantId: string
  company: { name: string; host: string | null }
}): Promise<{ readings: ExternalReading[]; rejected: number; costUsd: number; reason: string | null; failed?: boolean }> {
  const text = input.text.slice(0, 12_000).trim()
  if (!env.PUBLIC_RESEARCH_ENABLED) return { readings: [], rejected: 0, costUsd: 0, reason: 'PUBLIC_RESEARCH_ENABLED is off.' }
  if (text.length < 200) return { readings: [], rejected: 0, costUsd: 0, reason: 'The page carried too little text to read.' }
  try {
    const result = await getLlm().generate({
      promptKey: 'intent.read_external_signals',
      variables: {
        companyName: input.company.name,
        companyDomain: input.company.host ? ` (${input.company.host})` : '',
        sourceUrl: input.sourceUrl,
        pageText: text,
      },
      schema: ReadSignals,
      feature: 'intent_external_sources',
      tenantId: input.tenantId,
    })
    const parsed = ReadSignals.safeParse(result.data)
    if (!parsed.success) return { readings: [], rejected: 0, costUsd: result.costUsd, reason: 'The reading did not match the expected shape.', failed: true }
    const verified = verifyReadings(parsed.data.signals, text, input.company)
    return { ...verified, costUsd: result.costUsd, reason: null }
  } catch (err) {
    logger.info({ err: (err as Error).message, sourceUrl: input.sourceUrl }, 'external page read failed; the run continues')
    return { readings: [], rejected: 0, costUsd: 0, reason: `The page could not be read: ${(err as Error).message}`, failed: true }
  }
}

// ── Where a page lives ─────────────────────────────────────────────────────

const PLATFORMS: Array<[RegExp, string, string]> = [
  [/(^|\.)reddit\.com$/, 'reddit', 'Reddit'],
  [/(^|\.)linkedin\.com$/, 'linkedin', 'LinkedIn'],
  [/(^|\.)(x|twitter)\.com$/, 'x', 'X (Twitter)'],
  [/(^|\.)facebook\.com$/, 'facebook', 'Facebook'],
  [/(^|\.)youtube\.com$/, 'youtube', 'YouTube'],
  [/(^|\.)instagram\.com$/, 'instagram', 'Instagram'],
  [/(^|\.)quora\.com$/, 'quora', 'Quora'],
  [/(^|\.)trustpilot\.com$/, 'trustpilot', 'Trustpilot'],
  [/(^|\.)g2\.com$/, 'g2', 'G2'],
  [/(^|\.)capterra\.com$/, 'capterra', 'Capterra'],
  [/(^|\.)glassdoor\.[a-z.]+$/, 'glassdoor', 'Glassdoor'],
  [/(^|\.)indeed\.com$/, 'indeed', 'Indeed'],
  [/(^|\.)yelp\.com$/, 'yelp', 'Yelp'],
  [/(^|\.)bbb\.org$/, 'bbb', 'BBB'],
  [/(^|\.)amazon\.[a-z.]+$/, 'amazon', 'Amazon reviews'],
  [/(^|\.)(medium\.com|substack\.com)$/, 'blog', 'Blog'],
]

const NEWS_HOST = /(news|times|journal|post|daily|herald|tribune|gazette|press|wire|magazine|mag|today|week|insider|reporter|chronicle|bizjournals)/i
const FORUM_HOST = /(forum|community|discuss|board|talk|answers|stackexchange|stackoverflow)/i
const BLOG_HOST = /(^|\.)blog\.|blog/i

/** Which kind of place a page is, from its host — for the chip and the confidence rule. */
export function placeOf(finalUrl: string): { platform: string; platformLabel: string; sourceType: SourceType } {
  let host = ''
  let path = ''
  try {
    const u = new URL(finalUrl)
    host = u.hostname.toLowerCase().replace(/^www\./, '')
    path = u.pathname.toLowerCase()
  } catch {
    return { platform: 'web', platformLabel: 'Web page', sourceType: 'third_party' }
  }
  for (const [re, platform, label] of PLATFORMS) if (re.test(host)) return { platform, platformLabel: label, sourceType: 'third_party' }
  if (FORUM_HOST.test(host) || /\/(forum|forums|community|threads?|discussion)s?\//.test(path)) {
    return { platform: 'forum', platformLabel: 'Forum', sourceType: 'third_party' }
  }
  if (NEWS_HOST.test(host) || /\/(news|article|articles)\//.test(path)) {
    return { platform: 'news', platformLabel: 'News', sourceType: 'news_article' }
  }
  if (BLOG_HOST.test(host) || /\/blog\//.test(path)) return { platform: 'blog', platformLabel: 'Blog', sourceType: 'third_party' }
  return { platform: host, platformLabel: host, sourceType: 'third_party' }
}

// ── What each kind means, and why it matters ───────────────────────────────

export const KIND_INFO: Record<ExternalKind, { category: SignalCategory; label: string; why: string }> = {
  product_discussion: {
    category: 'catalog',
    label: 'Product discussion',
    why:
      'People are discussing this company’s products in public. Questions and comparisons there often show what ' +
      'buyers cannot find on the product pages themselves; it may point to gaps in product information, and does not establish them.',
  },
  customer_complaint: {
    category: 'catalog',
    label: 'Customer complaint',
    why:
      'A customer is complaining in public. Where the complaint concerns wrong, missing or unclear product details, ' +
      'it is a direct sign the product information is not doing its job; other complaints are context, not a need.',
  },
  buying_research: {
    category: 'business',
    label: 'Buying / research activity',
    why:
      'The company is publicly looking for or evaluating a supplier, tool or platform. Active evaluation is when a ' +
      'new approach is most likely to be heard.',
  },
  expansion: {
    category: 'business',
    label: 'Expansion',
    why:
      'Growth — new locations, markets or acquisitions — usually means more products, more channels and more product ' +
      'data to keep consistent. It may create a need; it does not establish one.',
  },
  hiring: {
    category: 'hiring',
    label: 'Hiring',
    why:
      'A role reported publicly shows where the company is putting effort. It may indicate work that touches product ' +
      'information; it does not establish that it does.',
  },
  technology_change: {
    category: 'technology',
    label: 'Technology change',
    why:
      'A new website, e-commerce platform, ERP or PIM means product data is being moved or rebuilt — the moment its ' +
      'quality and structure matter most.',
  },
  product_launch: {
    category: 'catalog',
    label: 'New product launch',
    why:
      'New products need complete descriptions, attributes and specifications from day one, across every channel ' +
      'they are sold through.',
  },
  business_change: {
    category: 'business',
    label: 'Business change',
    why:
      'A leadership change, merger, rebrand or partnership often reopens how a company presents its catalogue. It may ' +
      'create an opening; it does not establish a need.',
  },
}

/**
 * Only a date the SOURCE stated. An unparseable string becomes null, never today.
 *
 * The date must state its year. Forums and Reddit often print just "Sep 5",
 * and `new Date("Sep 5")` is 4 September 2001 — so a fresh post was recorded
 * as twenty-five years old and shown as expired (2026-10-06). A date with no
 * year, or an all-number date that could be read either way round (05/06/2024
 * is May or June), is treated as the source giving no date. Nothing is guessed.
 */
export function statedDateOf(raw: string | null): Date | null {
  if (!raw) return null
  if (!/\b(19|20)\d{2}\b/.test(raw)) return null
  const numeric = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\s*$/.exec(raw)
  if (numeric && Number(numeric[1]) <= 12 && Number(numeric[2]) <= 12 && numeric[1] !== numeric[2]) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  if (d.getTime() > Date.now() + 86_400_000) return null
  return d
}
