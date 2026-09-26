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
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE — THE COMPANY'S OWN PUBLIC SOCIAL PROFILES.
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

    // ── 2. What does each profile show a logged-out visitor? ──────────────
    const access: Array<{ url: string; platform: string; access: string; note: string }> = []
    let personalization: ReturnType<typeof personalizationSignal> = null

    for (const profile of [...profiles.values()].slice(0, Math.max(1, Math.min(ctx.maxResults, 6)))) {
      const page = await fetchPageRaw(profile.url)
      const reading = readSocialPage({
        html: page.html ?? '',
        status: page.status,
        transportFailed: !page.ok,
        transportReason: page.reason ?? null,
        platformLabel: profile.platformLabel,
      })
      access.push({
        url: profile.url,
        platform: profile.platformLabel,
        access: reading.access,
        note: reading.accessNote,
      })

      // The link itself is a finding, whatever the platform then served. It is
      // the company's own published claim, it is dated by the page it sits on,
      // and it is the thing that makes every other social signal attributable.
      //
      // When the platform would not show us the page, the SUMMARY says so.
      // Putting that only in the interpretation left the headline reading
      // "publishes a LinkedIn profile" beside no posts, which a reader takes
      // as "the account is empty" rather than "we were not allowed to look".
      const verified = reading.access === 'public' || reading.access === 'metadata_only'
      signals.push({
        crmCompanyId: company.id,
        signalType: `social_presence_${profile.platform}`,
        signalCategory: 'business',
        summary: verified
          ? // Where the link was found is part of the claim. A profile taken
            // from the CRM record has not been "published on the company's own
            // website", and saying so would misdescribe the evidence.
            `${company.name} publishes ${withArticle(profile.platformLabel)} profile on ${
              profile.discoveredOn.startsWith('http') ? 'its own website' : profile.discoveredOn
            }.`
          : `Public profile detected — content could not be verified from this session. (${profile.platformLabel})`,
        interpretation:
          `The link was found on ${profile.discoveredOn}, so the account is the company's own claim rather than a name match. ` +
          reading.accessNote,
        evidence: profile.anchorText
          ? `Link on ${profile.discoveredOn}: "${profile.anchorText}" → ${profile.url}`
          : `Link on ${profile.discoveredOn} → ${profile.url}`,
        sourceUrl: profile.url,
        sourceType: 'social_profile',
        observedAt: null,
        polarity: 'neutral',
        provider: this.name,
        metadata: {
          platform: profile.platform,
          handle: profile.handle,
          discoveredOn: profile.discoveredOn,
          access: reading.access,
          accessNote: reading.accessNote,
          profileTitle: reading.title,
          profileDescription: reading.description,
        },
      })

      // The account's own public description, when the platform served one.
      if (reading.description && reading.description.trim().length >= 24) {
        signals.push({
          crmCompanyId: company.id,
          signalType: `social_description_${profile.platform}`,
          signalCategory: 'business',
          summary: `${profile.platformLabel} profile describes the business as: ${clip(reading.description.trim(), 180)}`,
          interpretation:
            'How a company describes itself on a public profile is how it wants buyers to categorise it, and it is often more current than the website copy.',
          evidence: clip(reading.description.trim(), 400),
          sourceUrl: profile.url,
          sourceType: 'social_profile',
          observedAt: null,
          polarity: 'neutral',
          provider: this.name,
          metadata: { platform: profile.platform, field: 'profile_description', access: reading.access },
        })
      }

      // Publicly rendered posts, matched against the outreach themes.
      for (const [postIndex, post] of reading.posts.entries()) {
        const observedAt = postDate(reading, postIndex)
        const match = themeFor(post) // one theme per post; the strongest match is the first rule.
        if (!match) continue
        signals.push({
          crmCompanyId: company.id,
          signalType: `social_post_${match.theme.toLowerCase().replace(/[^a-z]+/g, '_')}`,
          signalCategory: 'business',
          summary: `${match.theme} mentioned in a public ${profile.platformLabel} post: "${clip(post, 160)}"`,
          interpretation: match.why,
          evidence: clip(post, 600),
          sourceUrl: profile.url,
          sourceType: 'social_profile',
          observedAt,
          polarity: 'positive',
          provider: this.name,
          metadata: { platform: profile.platform, theme: match.theme, matched: match.matched },
        })
      }

      // ── People the company itself named in public ──────────────────────
      //
      // Only where the company's OWN public content pairs a name with a role:
      // "Dana Reed, Head of Ecommerce". The same precision-biased extractor
      // the website provider uses, so the two agree about what counts as a
      // person and neither infers one from a mention.
      //
      // These are recorded as SIGNALS, not as decision makers. Stage 4 keeps
      // its own ranking, verification and role taxonomy; this only means it
      // starts from a name the company published rather than from nothing.
      const publicText = [reading.description ?? '', ...reading.posts].join('\n')
      for (const person of extractPeople(publicText, 5)) {
        // Dated only by the post that names them, when exactly that post's
        // markup gives a date. A name from the profile description is undated.
        const namingPost = reading.posts.findIndex((p) => p.includes(person.name))
        const observedAt = namingPost >= 0 ? postDate(reading, namingPost) : null
        signals.push({
          crmCompanyId: company.id,
          signalType: 'social_person_named',
          signalCategory: 'business',
          summary: `${profile.platformLabel} content names ${person.name} as ${person.title}.`,
          interpretation:
            'A person the company named alongside a role in its own public content. Recorded as a candidate for ' +
            'Decision Maker Discovery to verify — it is not a verified employment claim, and nothing here decides ' +
            'who to approach.',
          evidence: clip(person.snippet, 400),
          sourceUrl: profile.url,
          sourceType: 'social_profile',
          observedAt,
          polarity: 'neutral',
          provider: this.name,
          metadata: {
            kind: 'person',
            platform: profile.platform,
            platformLabel: profile.platformLabel,
            fullName: person.name,
            title: person.title,
            // The COMPANY's page the name was read on — not this person's
            // profile. Kept under a name that cannot be mistaken for one.
            companyProfileUrl: profile.url,
            // Where the profile link itself came from: the company's website
            // (a URL) or the CRM record. Readers word their evidence from it.
            discoveredOn: profile.discoveredOn,
          },
        })
      }

      if (!personalization) {
        personalization = personalizationSignal({
          posts: reading.posts,
          sourceUrl: profile.url,
          platformLabel: profile.platformLabel,
        })
      }
    }

    if (personalization) {
      signals.push({
        crmCompanyId: company.id,
        signalType: 'personalization_public_interest',
        signalCategory: 'business',
        summary: `Public ${personalization.platformLabel} post mentions ${personalization.topic}.`,
        interpretation:
          'A non-sensitive public interest, offered only as a way to open a conversation like a person rather than a form. It is not a fact about anybody’s private life and must not be used as one.',
        evidence: personalization.quote,
        sourceUrl: personalization.sourceUrl,
        sourceType: 'social_profile',
        observedAt: null,
        polarity: 'neutral',
        provider: this.name,
        metadata: { kind: 'personalization', topic: personalization.topic },
      })
    }

    // A reason is returned even on success: it is how the screen explains a run
    // that found profiles but was shown a wall by every one of them.
    const walled = access.filter((a) => a.access !== 'public')
    return {
      provider: this.name,
      ok: true,
      signals,
      reason:
        walled.length === access.length && access.length > 0
          ? `${access.length} profile(s) were found and none served post content to a logged-out reader. ${walled.map((w) => w.note).join(' ')}`
          : undefined,
      metadata: { pagesRead, assetsRead, profilesFound: profiles.size, access },
      durationMs: Date.now() - started,
    }
  }
}
