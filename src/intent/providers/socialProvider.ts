import { fetchPageRaw } from '../../research/pageFetch.js'
import { normalizeUrl } from '../../research/ssrfGuard.js'
import { extractPeople } from '../../decisionmakers/peopleExtraction.js'
import { resolveCompanySource } from '../../crm/companySource.js'
import {
  discoverSocialProfiles,
  discoverSocialProfilesInText,
  firstPartyAssetUrls,
  looksLikeAppShell,
  readProfileUrl,
  type SocialProfile,
} from '../socialProfiles.js'
import { personalizationSignal, readSocialPage, type SocialReading } from '../socialReading.js'
import { POST_KIND_INFO, readPosts, searchRecentPosts, youtubeRecentVideos, type SocialPost } from '../socialActivity.js'
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE — WHAT THE COMPANY HAS RECENTLY POSTED ON ITS OWN SOCIAL ACCOUNTS.
//
// (2026-10-07) A profile is not a signal. "Publishes a LinkedIn profile" and
// "the profile describes the business as …" used to be recorded as signals;
// they say nothing about what the company is doing now, and are no longer
// recorded. The accounts are found as before (step 1), and then their RECENT
// POSTS are read — see socialActivity.ts — and each post is read for what it
// is about. Only a post with a verbatim quote of a relevant kind is a signal.
//
// Two steps, in this order, and the order is the whole compliance story:
//
//   1. read the company's OWN website and collect the profile links it
//      publishes. A link on the company's site is the company saying "this
//      account is ours"; a platform search for the company name is a guess
//      that finds franchisees, resellers and parody accounts with no way to
//      tell them apart.
//
//   2. request each of those profile URLs exactly as any logged-out visitor
//      would, through the same SSRF-guarded fetcher the rest of the platform
//      uses, and read what comes back.
//
// WHAT THIS DOES NOT DO, deliberately and permanently: no login, no session
// cookie, no API token, no headless browser pretending to be a person, no
// retry against a wall, no scraping of a personal profile, no collection of
// anything a logged-out visitor could not see. Where a platform answers with a
// login wall — which LinkedIn does, by design — that fact is recorded AS the
// finding. A wall reported as "no signals" would tell an operator the company
// has no presence when the truth is that the platform refused to answer.

/** "Recent" activity: posts from the last twelve months. */
const RECENT_DAYS = 365
/** Recent posts read per company, newest first. */
const MAX_POSTS_READ = 15

/** Pages on the company's own site most likely to carry the profile links. */
const LINK_PAGES = ['', '/contact', '/contact-us', '/about', '/about-us']

/** A themed announcement worth surfacing, and why it is worth surfacing. */
const THEMES: Array<{ theme: string; pattern: RegExp; why: string }> = [
  {
    theme: 'New product or range',
    pattern: /\b(new (?:product|range|line|catalogue|catalog)|now stocking|now available|just landed|new arrival)\b/i,
    why: 'A catalogue that is actively growing is a catalogue whose product data has to scale with it.',
  },
  {
    theme: 'Expansion or new location',
    pattern: /\b(new (?:branch|store|depot|warehouse|showroom|location|premises)|opening (?:soon|our)|expanded? (?:into|to))\b/i,
    why: 'Expansion usually widens the range and the audience that has to find it.',
  },
  {
    theme: 'Hiring',
    pattern: /\b(we'?re hiring|now hiring|join our team|vacanc(?:y|ies)|apply now)\b/i,
    why: 'Hiring names the function a company is investing in.',
  },
  {
    theme: 'Ecommerce or website change',
    pattern: /\b(new website|online (?:shop|store|ordering)|shop online|e-?commerce|web ?shop|order online)\b/i,
    why: 'A company changing how it sells online is a company whose product data is about to be read by more systems.',
  },
  {
    theme: 'Event or exhibition',
    pattern: /\b(trade show|exhibition|expo|come and see us|visit us at|stand [A-Z]?\d+|booth)\b/i,
    why: 'A named event is a dated, checkable reason to make contact.',
  },
  {
    theme: 'Certification or accreditation',
    pattern: /\b(certified|accredit(?:ed|ation)|iso ?\d{4,5}|approved (?:supplier|distributor|partner))\b/i,
    why: 'A stated certification is a fact buyers filter on, and one that belongs in structured product data.',
  },
  {
    theme: 'Partnership or distribution',
    pattern: /\b(partnership with|now (?:an )?(?:official|authorised|authorized) (?:distributor|dealer|stockist)|proud to (?:partner|announce))\b/i,
    why: 'A new brand relationship usually arrives as a block of new products to publish.',
  },
  {
    theme: 'Training or certification programme',
    pattern: /\b(bootcamp|boot camp|training program(?:me)?|upskilling|certification course|now enrolling|new cohort|academy)\b/i,
    why: 'A company investing in a training or certification programme is actively building capability, and its own published materials are a first-party need signal.',
  },
]

/** The first theme a post matches, in the priority order THEMES is written in — or null. */
export function themeFor(post: string): { theme: string; why: string; matched: string } | null {
  for (const rule of THEMES) {
    const m = rule.pattern.exec(post)
    if (m) return { theme: rule.theme, why: rule.why, matched: m[0] }
  }
  return null
}

/**
 * The date post `index`'s OWN markup states, or null.
 *
 * Every post used to receive the page's first date — so six posts spanning a
 * year all read as published on the same day. A post the markup does not date
 * is undated, which the engine demotes; that is the honest outcome.
 */
export function postDate(reading: SocialReading, index: number): Date | null {
  const raw = reading.postDates?.[index] ?? null
  if (!raw) return null
  const t = new Date(raw)
  if (Number.isNaN(t.getTime()) || t.getTime() > Date.now() + 86_400_000) return null
  return t
}

/** "a LinkedIn", "an Instagram". */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
}

/** A record field name ("Company.endPdpUrl") in words an operator reads. */
const FIELD_WORDS: Record<string, string> = {
  'Company.domain': 'website field',
  'Company.endPdpUrl': 'product page URL field',
  'Company.linkedProfiles': 'linked profiles',
}
export function recordFieldWords(field: string): string {
  return FIELD_WORDS[field] ?? 'record'
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

export class SocialProfileProvider implements IntentProvider {
  readonly name = 'social_profiles'
  readonly category = 'business'

  available(): { ok: boolean; reason?: string } {
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const company = ctx.company
    const signals: IntentSignalDraft[] = []

    // The one authority on what this company's website is. A record whose
    // website column reads "facebook.com" has no website — but it very often
    // has a social profile, and this is the engine that profile belongs to.
    const source = resolveCompanySource(company)

    // ── 0. Profiles the record itself states ──────────────────────────────
    //
    // Read FIRST and independently of the website, because a social-only
    // company has no site to read links from and its profile would otherwise
    // be lost — which is exactly the case the website field was hiding.
    const profiles = new Map<string, SocialProfile>()
    for (const s of source.socialSources) {
      const read = readProfileUrl(s.url)
      if (!read || profiles.has(read.url)) continue
      profiles.set(read.url, {
        platform: read.platform,
        platformLabel: read.label,
        url: read.url,
        handle: read.handle,
        discoveredOn: `the NXT Sales company record (${recordFieldWords(s.field)})`,
        anchorText: null,
      })
    }

    if (!source.websiteUrl && profiles.size === 0) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason:
          source.reason ?? 'No website and no social profile on the CRM record, so there is nothing to read.',
        durationMs: Date.now() - started,
        metadata: { notApplicable: true },
      }
    }

    const base = source.websiteUrl ? normalizeUrl(source.websiteUrl) : null

    // ── 1. Which further profiles does the company's own site claim? ──────
    const pagesRead: string[] = []
    const assetsRead: string[] = []
    const shellPages: Array<{ url: string; html: string }> = []

    for (const path of base ? LINK_PAGES : []) {
      if (profiles.size >= 6) break
      const url = new URL(path, base!).toString()
      const page = await fetchPageRaw(url)
      if (!page.ok || !page.html) continue
      const finalUrl = page.finalUrl ?? url
      pagesRead.push(finalUrl)
      for (const p of discoverSocialProfiles({ html: page.html, pageUrl: finalUrl })) {
        if (!profiles.has(p.url)) profiles.set(p.url, p)
      }
      if (looksLikeAppShell(page.html)) shellPages.push({ url: finalUrl, html: page.html })
    }

    // ── 1b. A site that renders itself in the browser ─────────────────────
    //
    // A React or Vue site serves an empty shell — one <div id="root"> and a
    // script — so there are no anchors to read and the company comes back with
    // no profiles at all. That is a statement about the rendering, not about
    // the business: one such company publishes its Facebook page inside the
    // bundle its own shell loads.
    //
    // Only reached when the markup itself yielded nothing, and only for the
    // company's OWN same-origin assets, fetched logged-out through the same
    // guarded transport. The bytes are searched as text; nothing is executed,
    // and no platform is searched by name.
    if (profiles.size === 0) {
      for (const shell of shellPages) {
        if (profiles.size > 0 || assetsRead.length >= 3) break
        for (const assetUrl of firstPartyAssetUrls(shell.html, shell.url, 3)) {
          if (profiles.size > 0 || assetsRead.length >= 3) break
          const asset = await fetchPageRaw(assetUrl, { as: 'asset' })
          if (!asset.ok || !asset.html) continue
          assetsRead.push(assetUrl)
          for (const p of discoverSocialProfilesInText({
            text: asset.html,
            discoveredOn: shell.url,
          })) {
            if (!profiles.has(p.url)) profiles.set(p.url, p)
          }
        }
      }
    }

    // The CRM's own linkedProfiles column used to be read again here. It is
    // now read by resolveCompanySource in step 0 above, along with every other
    // field that can hold a company URL — one place, one set of rules.

    if (pagesRead.length === 0 && profiles.size === 0) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: base
          ? `No page on ${base.hostname} could be read, so no social profile links could be collected.`
          : (source.reason ?? 'No website on the CRM record and no social profile to read.'),
        durationMs: Date.now() - started,
      }
    }
    if (profiles.size === 0) {
      return {
        provider: this.name,
        ok: true,
        signals: [],
        reason: `${pagesRead.length} page(s) on ${base?.hostname ?? 'the company site'} were read and none linked to a social or company profile. That is the company's own site saying it publishes none.`,
        metadata: { pagesRead, assetsRead, profilesFound: 0 },
        durationMs: Date.now() - started,
      }
    }

    // ── 2. What has each account recently posted? ─────────────────────────
    //
    // The profile page itself (some platforms render recent posts to a
    // logged-out reader), the channel's newest videos for YouTube, and the
    // individual post pages a search finds on these accounts. Each post must be
    // provably on the company's own account; see socialActivity.ts.
    const access: Array<{ url: string; platform: string; access: string; note: string }> = []
    const posts: SocialPost[] = []
    const accounts = [...profiles.values()].slice(0, 6)

    for (const profile of accounts) {
      const page = await fetchPageRaw(profile.url)
      const reading = readSocialPage({
        html: page.html ?? '',
        status: page.status,
        transportFailed: !page.ok,
        transportReason: page.reason ?? null,
        platformLabel: profile.platformLabel,
      })
      access.push({ url: profile.url, platform: profile.platformLabel, access: reading.access, note: reading.accessNote })
      for (const [i, text] of reading.posts.entries()) {
        posts.push({
          platform: profile.platform,
          platformLabel: profile.platformLabel,
          profileUrl: profile.url,
          url: profile.url,
          text,
          comments: [],
          publishedAt: postDate(reading, i)?.toISOString() ?? null,
          via: 'profile_page',
        })
      }
      if (profile.platform === 'youtube') {
        posts.push(...(await youtubeRecentVideos(profile, page.ok ? page.html : null, { max: 5 })))
      }
    }

    const searched = await searchRecentPosts({
      tenantId: ctx.tenantId,
      companyName: company.name,
      domain: base?.hostname.replace(/^www\./, '') ?? null,
      profiles: accounts,
      maxPosts: 10,
      budgetMs: 90_000,
    })
    for (const p of searched.posts) if (!posts.some((x) => x.url === p.url && x.text === p.text)) posts.push(p)

    // RECENT means the last twelve months. A post whose page states no date is
    // kept and shown as undated (the engine demotes it); one dated older is not
    // recent activity and is only counted.
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000
    const recent = posts
      .filter((p) => !p.publishedAt || Date.parse(p.publishedAt) >= cutoff)
      .sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) : 0) - (a.publishedAt ? Date.parse(a.publishedAt) : 0))
      .slice(0, MAX_POSTS_READ)
    const olderThanRecent = posts.filter((p) => p.publishedAt && Date.parse(p.publishedAt) < cutoff).length

    // ── 3. What is each post about? ──────────────────────────────────────
    const read = await readPosts({
      posts: recent,
      companyName: company.name,
      companyHost: base?.hostname.replace(/^www\./, '') ?? null,
      tenantId: ctx.tenantId,
    })
    for (const r of read.readings) {
      const info = POST_KIND_INFO[r.kind]
      signals.push({
        crmCompanyId: company.id,
        signalType: `social_activity_${r.kind}`,
        signalCategory: info.category,
        // What it is about, then the post's own words.
        summary: `${info.label} — ${company.name} on ${r.post.platformLabel}: ${r.about ? `${r.about}. ` : ''}“${clip(r.quote.replace(/\s+/g, ' '), 180)}”`,
        // WHY IT MATTERS and WHAT TO DO NEXT — fixed sentences per kind, never a model's view.
        interpretation: info.why,
        outreachAngle: info.next,
        // The post itself, as the platform served it.
        evidence: clip(r.post.text, 600),
        sourceUrl: r.post.url,
        sourceType: 'social_profile',
        observedAt: r.post.publishedAt ? new Date(r.post.publishedAt) : null,
        polarity: 'positive',
        provider: this.name,
        metadata: {
          kind: r.kind,
          kindLabel: info.label,
          platform: r.post.platform,
          platformLabel: r.post.platformLabel,
          postUrl: r.post.url,
          profileUrl: r.post.profileUrl,
          publishedAt: r.post.publishedAt,
          via: r.post.via,
          quote: r.quote,
          about: r.about,
          publicComments: r.post.comments.length,
        },
      })
    }

    // Only when the reader itself FAILED: the fixed phrases this source always
    // matched, so an AI outage still reports what the posts plainly say. When
    // the reader worked, its answer stands — a phrase match overruled it with
    // "Come and visit us at <address>" read as an event (2026-10-07). Hiring is
    // never a signal.
    for (const post of read.failed ? recent : []) {
      const match = themeFor(post.text)
      if (!match || match.theme === 'Hiring') continue
      signals.push({
        crmCompanyId: company.id,
        signalType: `social_post_${match.theme.toLowerCase().replace(/[^a-z]+/g, '_')}`,
        signalCategory: 'business',
        summary: `${match.theme} — ${company.name} on ${post.platformLabel}: “${clip(post.text, 160)}”`,
        interpretation: match.why,
        evidence: clip(post.text, 600),
        sourceUrl: post.url,
        sourceType: 'social_profile',
        observedAt: post.publishedAt ? new Date(post.publishedAt) : null,
        polarity: 'positive',
        provider: this.name,
        metadata: { platform: post.platform, platformLabel: post.platformLabel, theme: match.theme, matched: match.matched, postUrl: post.url, publishedAt: post.publishedAt, via: post.via },
      })
    }

    // ── People the company itself named in its posts ──────────────────────
    //
    // Only where the company's OWN post pairs a name with a role: "Dana Reed,
    // Head of Ecommerce". Recorded for Decision Maker Discovery to verify; a
    // profile's description is not read for people any more than for signals.
    for (const post of recent) {
      for (const person of extractPeople(post.text, 5)) {
        signals.push({
          crmCompanyId: company.id,
          signalType: 'social_person_named',
          signalCategory: 'business',
          summary: `${post.platformLabel} post names ${person.name} as ${person.title}.`,
          interpretation:
            'A person the company named alongside a role in its own public content. Recorded as a candidate for ' +
            'Decision Maker Discovery to verify — it is not a verified employment claim, and nothing here decides ' +
            'who to approach.',
          evidence: clip(person.snippet, 400),
          sourceUrl: post.url,
          sourceType: 'social_profile',
          observedAt: post.publishedAt ? new Date(post.publishedAt) : null,
          polarity: 'neutral',
          provider: this.name,
          metadata: {
            kind: 'person',
            platform: post.platform,
            platformLabel: post.platformLabel,
            fullName: person.name,
            title: person.title,
            // The COMPANY's page the name was read on — not this person's
            // profile. Kept under a name that cannot be mistaken for one.
            companyProfileUrl: post.profileUrl,
            discoveredOn: profiles.get(post.profileUrl)?.discoveredOn ?? post.profileUrl,
          },
        })
      }
    }

    const personalization = personalizationSignal({
      posts: recent.map((p) => p.text),
      sourceUrl: recent[0]?.url ?? accounts[0]!.url,
      platformLabel: recent[0]?.platformLabel ?? accounts[0]!.platformLabel,
    })
    if (personalization) {
      signals.push({
        crmCompanyId: company.id,
        signalType: 'personalization_public_interest',
        signalCategory: 'business',
        summary: `Public ${personalization.platformLabel} post mentions ${personalization.topic}.`,
        interpretation:
          'A non-sensitive public interest, offered only as a way to open a conversation like a person rather than a form. It is not a fact about anybody’s private life and must not be used as one.',
        evidence: personalization.quote,
        sourceUrl: recent.find((p) => p.text.includes(personalization.quote))?.url ?? personalization.sourceUrl,
        sourceType: 'social_profile',
        observedAt: null,
        polarity: 'neutral',
        provider: this.name,
        metadata: { kind: 'personalization', topic: personalization.topic },
      })
    }

    // The run explains itself: how many accounts, how many recent posts were
    // read, and — when nothing was found — why, in the platform's own terms.
    // A profile with no readable posts is NOT reported as a signal.
    const activity = signals.filter((x) => x.signalType.startsWith('social_activity_') || x.signalType.startsWith('social_post_')).length
    const reason =
      activity > 0
        ? undefined
        : read.failed
          ? `${recent.length} recent post(s) were found but could not be read: ${read.failed}`
          : recent.length > 0
            ? `${recent.length} recent post(s) on ${accounts.length} account(s) were read; none was about a launch, a change or anything else this source reports. Profile details (followers, description) are not signals.`
            : `${accounts.length} social account(s) found; no recent post could be read from them` +
              (olderThanRecent ? ` (${olderThanRecent} post(s) found were older than ${RECENT_DAYS} days)` : '') +
              `. ${access.map((a) => a.note).join(' ')} Profile details (followers, description) are not signals.`
    return {
      provider: this.name,
      ok: !(read.failed && recent.length > 0 && activity === 0),
      signals,
      reason,
      costUsd: searched.costUsd + read.costUsd || undefined,
      metadata: {
        pagesRead,
        assetsRead,
        profilesFound: profiles.size,
        access,
        postsFound: posts.length,
        postsRead: recent.map((p) => ({ url: p.url, platform: p.platformLabel, publishedAt: p.publishedAt, via: p.via })),
        postsOlderThanRecent: olderThanRecent,
        postSearch: { queriesRun: searched.queriesRun, sourcesFound: searched.found, failed: searched.failed },
        claimsRejectedAsUngrounded: read.rejected,
      },
      durationMs: Date.now() - started,
    }
  }
}
