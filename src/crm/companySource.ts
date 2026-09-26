import type { CrmCompany } from './types.js'

// WHAT COUNTS AS THIS COMPANY'S WEBSITE.
//
// One answer, computed once, used by every engine that needs a URL. Before
// this, each engine read `company.domain` for itself and reached its own
// conclusion, which is how a CRM record reading "facebook.com" became:
//
//   Enrichment    fetched https://facebook.com/ and reported
//                 "the website could not be read"
//   Website Audit had no site to crawl
//   Intent        separately, and correctly, treated it as a social source
//
// Three engines, three interpretations, one field. The failure was not the
// fetch — the fetch worked fine — it was calling a social platform a website
// and then reporting the platform's front door as the customer's broken site.
//
// THE DISTINCTIONS THIS MODULE MAKES
//
//   PRIMARY WEBSITE   a URL on a domain the company controls
//   SOCIAL PROFILE    a page identifying this company ON a platform
//                     (facebook.com/danucstore) — real, useful, and not a
//                     website; handed to Intent Signals, never to a crawler
//   PLATFORM ROOT     facebook.com with no path — identifies nobody at all,
//                     and is neither of the above
//
// The third is the one that caused the bug, and it is the one most easily
// mistaken for the second.
//
// WHAT IT WILL NOT DO: invent a domain, guess one from a company name, or
// promote an unverified candidate to "the website". Where a corporate email
// address implies a domain, that domain is offered as a CANDIDATE with its
// provenance attached, for a caller that can check whether it responds. A
// hypothesis someone verified is a fact; a hypothesis nobody verified is a
// guess, and this module never returns the second as the first.

/** Hosts that are platforms. A page here belongs to the platform, not the company. */
const SOCIAL_HOSTS: Array<{ match: RegExp; platform: string }> = [
  { match: /(^|\.)facebook\.com$/i, platform: 'facebook' },
  { match: /(^|\.)fb\.(com|me)$/i, platform: 'facebook' },
  { match: /(^|\.)instagram\.com$/i, platform: 'instagram' },
  { match: /(^|\.)linkedin\.com$/i, platform: 'linkedin' },
  { match: /(^|\.)lnkd\.in$/i, platform: 'linkedin' },
  { match: /(^|\.)(twitter|x)\.com$/i, platform: 'x' },
  { match: /(^|\.)youtube\.com$/i, platform: 'youtube' },
  { match: /(^|\.)youtu\.be$/i, platform: 'youtube' },
  { match: /(^|\.)tiktok\.com$/i, platform: 'tiktok' },
  { match: /(^|\.)pinterest\.[a-z.]+$/i, platform: 'pinterest' },
  { match: /(^|\.)wa\.me$/i, platform: 'whatsapp' },
  { match: /(^|\.)t\.me$/i, platform: 'telegram' },
]

/**
 * Mailbox providers. An address here says nothing about a company's domain,
 * so no website candidate is ever derived from one.
 */
const FREE_MAIL =
  /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|mail|yandex|zoho|rediffmail|inbox|fastmail|tutanota)\./i

/** Paths that exist on every platform and identify no particular account. */
const PLATFORM_UTILITY =
  /^\/(?:$|home|login|signin|signup|register|help|about|privacy|terms|policies|legal|sharer|share|dialog|intent|explore|search|feed|watch|results|pages\/?$)/i

export type CompanyUrlKind = 'primary_website' | 'social_profile' | 'platform_root' | 'invalid'

export interface ClassifiedUrl {
  kind: CompanyUrlKind
  /** Normalised absolute URL, or null when it could not be read as one. */
  url: string | null
  /** Set for social_profile and platform_root. */
  platform: string | null
  /** The account handle a social profile names, when it names one. */
  handle: string | null
}

/**
 * Reads one stored value as a website, a social profile, or neither.
 *
 * Exported because this single judgement is the whole bug: "facebook.com",
 * "https://www.facebook.com/danucstore/" and "https://danuc.com.mt" are three
 * different kinds of thing that all arrive in the same CRM column.
 */
export function classifyCompanyUrl(raw: string | null | undefined): ClassifiedUrl {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return { kind: 'invalid', url: null, platform: null, handle: null }

  let u: URL
  try {
    // The CRM stores bare hosts as often as full URLs.
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return { kind: 'invalid', url: null, platform: null, handle: null }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { kind: 'invalid', url: null, platform: null, handle: null }
  }

  const host = u.hostname.replace(/^www\./i, '').toLowerCase()
  if (!host.includes('.')) return { kind: 'invalid', url: null, platform: null, handle: null }

  const social = SOCIAL_HOSTS.find((s) => s.match.test(host))
  if (!social) {
    return { kind: 'primary_website', url: u.toString(), platform: null, handle: null }
  }

  // On a platform, the PATH is what identifies a company. Without one there is
  // no account here — only the platform's own front door.
  const path = u.pathname.replace(/\/+$/, '')
  if (!path || PLATFORM_UTILITY.test(`${path}/`)) {
    return { kind: 'platform_root', url: u.toString(), platform: social.platform, handle: null }
  }

  const handle = path.split('/').filter(Boolean).pop() ?? null
  return {
    kind: 'social_profile',
    url: `https://${u.hostname.replace(/^www\./i, '')}${path}`,
    platform: social.platform,
    handle,
  }
}

export interface CompanySocialSource {
  platform: string
  url: string
  /** Which CRM field it was read from. */
  field: string
}

export interface CompanySource {
  /**
   * `primary_website` — a real site exists and may be crawled.
   * `social_only`     — no website, but the company has a social presence.
   * `none`            — nothing usable on the record at all.
   */
  kind: 'primary_website' | 'social_only' | 'none'
  /** The URL a crawler may be given. Null unless kind is primary_website. */
  websiteUrl: string | null
  /** Which field the website came from, for the run's own account of itself. */
  websiteField: string | null
  /**
   * A domain implied by a corporate email address, NOT yet a website.
   *
   * Offered so a caller that can make a request may check whether it responds
   * and adopt it on the evidence. Never treated as the website here.
   */
  candidateWebsiteUrl: string | null
  candidateReason: string | null
  /** Every social profile the record holds. Preserved for Intent Signals. */
  socialSources: CompanySocialSource[]
  /**
   * Why there is no primary website, when there is none. Written for an
   * operator to act on: "the website field holds a social platform" and "the
   * record has no website" are different problems with different fixes.
   */
  reason: string | null
}

/** The record fields that can legitimately hold a company URL. */
const URL_FIELDS: Array<{ field: string; read: (c: CrmCompany) => string[] }> = [
  { field: 'Company.domain', read: (c) => [c.domain ?? ''] },
  { field: 'Company.endPdpUrl', read: (c) => [c.endPdpUrl ?? ''] },
  { field: 'Company.linkedProfiles', read: (c) => c.linkedProfiles ?? [] },
]

/**
 * The one answer to "where does this company live on the web".
 *
 * Pure and synchronous: it reads the record it is given and nothing else, so
 * every engine asking the same question about the same company gets the same
 * answer, and none of them can reach a different one by reading the raw column
 * for itself.
 */
export function resolveCompanySource(company: CrmCompany): CompanySource {
  const socialSources: CompanySocialSource[] = []
  const seenSocial = new Set<string>()
  let websiteUrl: string | null = null
  let websiteField: string | null = null
  let platformRootField: string | null = null

  for (const { field, read } of URL_FIELDS) {
    for (const raw of read(company)) {
      const c = classifyCompanyUrl(raw)
      if (c.kind === 'primary_website' && !websiteUrl) {
        websiteUrl = c.url
        websiteField = field
      } else if (c.kind === 'social_profile' && c.url && !seenSocial.has(c.url)) {
        seenSocial.add(c.url)
        socialSources.push({ platform: c.platform!, url: c.url, field })
      } else if (c.kind === 'platform_root' && !platformRootField) {
        platformRootField = field
      }
    }
  }

  // A domain implied by a corporate address. Offered, never adopted: see the
  // note on candidateWebsiteUrl.
  let candidateWebsiteUrl: string | null = null
  let candidateReason: string | null = null
  if (!websiteUrl) {
    for (const address of [company.email, ...(company.emails ?? [])]) {
      const domain = String(address ?? '').split('@')[1]?.trim().toLowerCase()
      if (!domain || !domain.includes('.') || FREE_MAIL.test(domain)) continue
      if (SOCIAL_HOSTS.some((s) => s.match.test(domain))) continue
      candidateWebsiteUrl = `https://${domain.replace(/^www\./, '')}`
      candidateReason = `Implied by the corporate address on the NXT Sales record. Unverified — no request has been made to it.`
      break
    }
  }

  if (websiteUrl) {
    return {
      kind: 'primary_website',
      websiteUrl,
      websiteField,
      candidateWebsiteUrl: null,
      candidateReason: null,
      socialSources,
      reason: null,
    }
  }

  const reason = platformRootField
    ? `The NXT Sales website field holds a social platform address rather than a company website, so there is no site to crawl.` +
      (socialSources.length > 0
        ? ` The company's ${socialSources.map((s) => s.platform).join(' and ')} profile is kept as a social source.`
        : '')
    : socialSources.length > 0
      ? 'This company has a social profile on record but no website of its own.'
      : 'The NXT Sales record holds no website and no social profile.'

  return {
    kind: socialSources.length > 0 ? 'social_only' : 'none',
    websiteUrl: null,
    websiteField: null,
    candidateWebsiteUrl,
    candidateReason,
    socialSources,
    reason,
  }
}
