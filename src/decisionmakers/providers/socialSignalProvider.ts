import { prisma } from '../../platform/db.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — people the Intent Signals engine already found.
//
// THE TWO ENGINES WERE NOT SPEAKING TO EACH OTHER.
//
// Stage 3 reads the public profiles a company links from its own website, and
// where that content pairs a name with a role — "Dana Reed, Head of Ecommerce"
// — it records a `social_person_named` signal. Stage 4 then went looking for
// decision makers from a standing start, ignoring a name the company had
// already published and Stage 3 had already stored. That is the gap this
// provider closes.
//
// WHAT IT DOES AND DOES NOT DECIDE.
//
// It contributes CANDIDATES. It does not rank them, does not verify the
// employment, does not assign confidence, and cannot promote anyone: the role
// taxonomy and the ranking policy are untouched, and a social-derived name is
// put through exactly the same checks as one from a leadership page. A person
// Stage 3 named is a person Stage 4 should EVALUATE, not a person Stage 4
// should accept.
//
// It makes no network request. Everything here was already collected, stored
// and evidenced by Stage 3 against this same company.

interface PersonMetadata {
  kind?: string
  fullName?: string
  title?: string
  platform?: string
  platformLabel?: string
  /** The COMPANY page the name was read on (new rows). */
  companyProfileUrl?: string
  /** Older rows stored the company page under this name. Never a personal profile. */
  profileUrl?: string
  /** Where the profile link was found: a URL on the company site, or the CRM record. */
  discoveredOn?: string
}

/** How many stored person signals are read before de-duplicating by name. */
const READ_LIMIT = 200

/** The evidence sentence, worded from where the profile link was actually found. */
export function socialSnippet(meta: PersonMetadata, evidence: string): string {
  const label = meta.platformLabel ?? 'A public profile'
  const where = meta.discoveredOn?.trim()
  const origin = !where
    ? `${label} page recorded by Intent Signals`
    : /^https?:\/\//i.test(where)
      ? `${label} page the company links from its own website`
      : `${label} page listed on ${where}`
  return `${origin}: "${evidence.slice(0, 300)}"`
}

export class SocialSignalProvider implements DecisionMakerProvider {
  readonly name = 'intent_social'
  readonly sourceType = 'third_party'

  available(): { status: ProviderStatus; reason?: string } {
    // Always runnable: it reads this platform's own store. Whether it finds
    // anything depends on whether Intent Signals has run and what it saw.
    return { status: 'available' }
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()

    // Scoped to THIS company by id. A social signal belongs to exactly one
    // company, which makes the isolation structural rather than a filter
    // somebody has to remember to apply.
    // Read wide, de-duplicate by name, THEN apply the caller's limit. Taking
    // the limit first let repeated rows of one name crowd out everyone else.
    // Withdrawn (expired) signals are not evidence of anybody.
    const limit = Math.min(Math.max(ctx.maxResults, 1), 25)
    const signals = await prisma.intentSignal.findMany({
      where: {
        tenantId: ctx.tenantId,
        crmCompanyId: ctx.company.id,
        signalType: 'social_person_named',
        status: { not: 'expired' },
      },
      orderBy: { detectedAt: 'desc' },
      take: READ_LIMIT,
      select: { metadata: true, evidence: true, sourceUrl: true, observedAt: true, detectedAt: true },
    })

    if (signals.length === 0) {
      return {
        provider: this.name,
        status: 'no_results',
        candidates: [],
        reason:
          'Intent Signals recorded no person for this company. Either it has not run, or the public profiles it read named nobody alongside a role.',
        metadata: { signalsRead: 0 },
        durationMs: Date.now() - started,
      }
    }

    const seen = new Set<string>()
    const candidates: CandidateDraft[] = []

    for (const s of signals) {
      if (candidates.length >= limit) break
      const meta = (s.metadata ?? {}) as PersonMetadata
      const fullName = meta.fullName?.trim()
      if (meta.kind !== 'person' || !fullName || fullName.length < 3) continue

      const key = fullName.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)

      const companyPage = meta.companyProfileUrl?.trim() || meta.profileUrl?.trim() || null

      candidates.push({
        fullName,
        rawTitle: meta.title?.trim() || null,
        statedCompany: ctx.company.name,
        // NEVER the company's page. Candidates are keyed on profile URL, so
        // giving everyone named on one company page that page's URL merged
        // them all into a single invented person. Stage 3 collects no
        // personal profiles, so there is no personal URL to pass through; the
        // company page stays in the evidence below, where it belongs.
        profileUrl: null,
        providerPersonId: null,
        // Social content names people; it does not publish their inbox. An
        // address for this person has to come from a source that states one.
        email: null,
        phone: null,
        location: null,
        evidence: [
          {
            provider: this.name,
            sourceType: 'third_party',
            sourceUrl: s.sourceUrl ?? companyPage,
            snippet: socialSnippet(meta, String(s.evidence ?? '')),
            // Only a date the source stated. When it stated none, the
            // evidence is undated — our detection time is not the event's.
            observedAt: s.observedAt ?? null,
            supports: meta.title ? ['name', 'title'] : ['name'],
          },
        ],
      })
    }

    return {
      provider: this.name,
      status: candidates.length > 0 ? 'available' : 'no_results',
      candidates,
      reason:
        candidates.length > 0
          ? undefined
          : `Intent Signals holds ${signals.length} person signal(s) for this company, none carrying a usable name.`,
      metadata: { signalsRead: signals.length, namedPeople: candidates.length },
      durationMs: Date.now() - started,
    }
  }
}
