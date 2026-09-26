import { createHash } from 'node:crypto'
import type { CrmCompany } from '../crm/types.js'
import { verifyCompanyMatch } from './companyMatch.js'
import { SENIORITY_WEIGHT, applyFallbackPolicy, matchRole, normalizeTitle } from './roleTaxonomy.js'
import { env } from '../config/env.js'
import type {
  CandidateConfidence,
  CandidateDraft,
  CandidateEvidence,
  CompanyMatchLevel,
  Contactability,
  DmSourceType,
  ScoredCandidate,
} from './types.js'

// STAGE 4 — turning provider observations into a ranked shortlist.
//
// Everything in this file is deterministic. Two people who look alike are the
// same person by a stated rule; a candidate is confident by a stated rule; the
// shortlist is ordered by a stated rule. All three are testable, and none of
// them can be talked into a better answer.

// ── Identity ───────────────────────────────────────────────────────────────

/** Names as sources write them: "Dr. Jane A. Smith Jr." and "jane smith". */
export function normalizePersonName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|prof|sir)\b\.?/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|phd|mba|cpa)\b\.?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A stable key for "the same human". Deliberately conservative: a provider's
 * own person ID or a profile URL is definitive, otherwise the name is scoped to
 * the company so two different Jane Smiths at two companies stay separate.
 *
 * Middle names are dropped from the fallback because sources disagree about
 * them constantly, and "Jane Smith" / "Jane A. Smith" at one company is one
 * person far more often than it is two.
 */
export function identityKey(draft: CandidateDraft, crmCompanyId: string): string {
  if (draft.providerPersonId) return `pid:${draft.providerPersonId}`
  if (draft.profileUrl) return `url:${draft.profileUrl.toLowerCase().replace(/\/+$/, '')}`

  const parts = normalizePersonName(draft.fullName).split(' ').filter(Boolean)
  const shortName = parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : parts.join(' ')
  return `name:${createHash('sha256').update(`${crmCompanyId}|${shortName}`).digest('hex').slice(0, 24)}`
}

// ── Merging ────────────────────────────────────────────────────────────────

/**
 * How much a source can be trusted about employment. The company's own site
 * outranks everything because the company is the authority on its own staff;
 * a third-party aggregator is last because it is a copy of a copy.
 */
const SOURCE_RANK: Record<DmSourceType, number> = {
  company_website: 5,
  crm_record: 5,
  press_release: 4,
  linkedin: 3,
  data_provider: 2,
  third_party: 1,
}

function bestEvidence(evidence: CandidateEvidence[], field: CandidateEvidence['supports'][number]) {
  return evidence
    .filter((e) => e.supports.includes(field))
    .sort((a, b) => SOURCE_RANK[b.sourceType] - SOURCE_RANK[a.sourceType])[0]
}

/**
 * Merges several sightings of one person.
 *
 * Field-level rule: keep the value from the highest-ranked source that actually
 * stated it, and never fill a null from anywhere. Two providers disagreeing
 * about a title is normal (people change jobs); the more authoritative source
 * wins, and BOTH snippets are kept so the disagreement stays visible.
 */
export function mergeDrafts(drafts: CandidateDraft[]): CandidateDraft {
  const evidence = drafts.flatMap((d) => d.evidence)

  const pick = <K extends keyof CandidateDraft>(
    field: K,
    supports: CandidateEvidence['supports'][number],
    tieBreak?: (a: CandidateDraft, b: CandidateDraft) => number,
  ): CandidateDraft[K] => {
    const ranked = drafts
      .filter((d) => d[field] != null && d[field] !== '')
      .sort((a, b) => {
        const ae = bestEvidence(a.evidence, supports)
        const be = bestEvidence(b.evidence, supports)
        return (
          (be ? SOURCE_RANK[be.sourceType] : 0) - (ae ? SOURCE_RANK[ae.sourceType] : 0) ||
          (tieBreak ? tieBreak(a, b) : 0)
        )
      })
    return ranked[0]?.[field] ?? (null as CandidateDraft[K])
  }

  // Two equally authoritative sources disagreeing about a title used to be
  // settled by input order, so a CRM entry reading just "Director" beat the
  // company's own "Managing Director" for the same person. On a tie the title
  // that names a relevant function wins, then the more specific (longer) one.
  // Neither is invented; both snippets stay in the evidence.
  const titleTieBreak = (a: CandidateDraft, b: CandidateDraft): number => {
    const am = a.rawTitle && matchRole(a.rawTitle) ? 1 : 0
    const bm = b.rawTitle && matchRole(b.rawTitle) ? 1 : 0
    return bm - am || (b.rawTitle ?? '').trim().length - (a.rawTitle ?? '').trim().length
  }

  // Longest name form wins — "Jane A. Smith" carries more information than
  // "Jane Smith", and neither is invented.
  const fullName = drafts
    .map((d) => d.fullName.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0]!

  // THE SAME TITLE, SAID PRECISELY, BEATS THE VAGUE FORM OF IT.
  //
  // The CRM held "Director" for a person a trade listing we fetched calls
  // "Managing Director". Source rank put the CRM first, so the engine carried
  // the title it could do nothing with and reported a company's managing
  // director as having no relevant role. Those two are not a disagreement:
  // the second is the first, said precisely.
  //
  // ONLY an elaboration qualifies - every word of the ranked title must appear
  // in the fuller one. That is what separates this from letting any source
  // overwrite any other: a data broker's "Head of Ecommerce" does NOT replace
  // the company's own "Buyer", because those are two different jobs and the
  // company is the authority on its own staff. "Director" inside "Managing
  // Director" is the same job, named properly.
  //
  // Nothing is invented and nothing is lost: both titles were stated by a
  // source, both snippets stay in the evidence, and the page that said it is
  // one click away. A title no source stated is still never produced.
  const rankedTitle = pick('rawTitle', 'title', titleTieBreak)
  const words = (title: string): string[] => normalizeTitle(title).split(/\s+/).filter(Boolean)
  const elaborates = (fuller: string, vaguer: string): boolean => {
    const inFuller = new Set(words(fuller))
    const vague = words(vaguer)
    return vague.length > 0 && vague.every((w) => inFuller.has(w)) && words(fuller).length > vague.length
  }
  const preciseTitle =
    rankedTitle && !matchRole(String(rankedTitle))
      ? drafts
          .filter((d) => d.rawTitle && matchRole(d.rawTitle) && elaborates(d.rawTitle, String(rankedTitle)))
          .sort((a, b) => {
            const ae = bestEvidence(a.evidence, 'title')
            const be = bestEvidence(b.evidence, 'title')
            return (
              (be ? SOURCE_RANK[be.sourceType] : 0) - (ae ? SOURCE_RANK[ae.sourceType] : 0) ||
              (b.rawTitle ?? '').trim().length - (a.rawTitle ?? '').trim().length
            )
          })[0]?.rawTitle
      : undefined
  const rawTitle = preciseTitle ?? rankedTitle

  return {
    fullName,
    rawTitle,
    statedCompany: pick('statedCompany', 'company'),
    profileUrl: pick('profileUrl', 'profile_url'),
    providerPersonId: drafts.find((d) => d.providerPersonId)?.providerPersonId ?? null,
    email: pick('email', 'contact'),
    phone: pick('phone', 'contact'),
    location: drafts.find((d) => d.location)?.location ?? null,
    evidence,
  }
}

// ── Confidence ─────────────────────────────────────────────────────────────

/**
 * Confidence describes EVIDENCE QUALITY, not enthusiasm. It can only be
 * demoted from the ceiling its weakest necessary link allows — there is no
 * path by which a lot of weak evidence becomes strong evidence.
 */
export function scoreCandidateConfidence(
  draft: CandidateDraft,
  companyMatch: CompanyMatchLevel,
  providers: string[],
): { confidence: CandidateConfidence; reasons: string[] } {
  const reasons: string[] = []

  // An unproven company link caps everything. The title is irrelevant if we
  // cannot show the person works here.
  if (companyMatch === 'rejected') {
    return { confidence: 'low', reasons: ['A source states this person works at a different company.'] }
  }
  if (companyMatch === 'unverified') {
    return {
      confidence: 'low',
      reasons: ['No source states which company this person works at, so the association is unproven.'],
    }
  }

  const titleEvidence = draft.evidence.filter((e) => e.supports.includes('title'))
  if (!titleEvidence.length) {
    return { confidence: 'low', reasons: ['No source stated a job title, so the role cannot be established.'] }
  }

  const strongestTitleRank = Math.max(...titleEvidence.map((e) => SOURCE_RANK[e.sourceType]))
  let confidence: CandidateConfidence = strongestTitleRank >= 4 ? 'high' : 'medium'
  reasons.push(
    `Job title stated by ${titleEvidence
      .map((e) => e.sourceType)
      .join(', ')} (strongest source rank ${strongestTitleRank}/5).`,
  )

  if (companyMatch === 'verified') {
    reasons.push('Employment at this company is verified.')
  } else {
    // `probable` — a partial name match. Cannot support a HIGH claim.
    if (confidence === 'high') confidence = 'medium'
    reasons.push('Employment at this company is only probable, which caps confidence at medium.')
  }

  if (providers.length > 1) {
    reasons.push(`Independently reported by ${providers.length} providers: ${providers.join(', ')}.`)
  } else {
    reasons.push(`Reported by a single provider (${providers[0]}), so nothing corroborates it.`)
    if (confidence === 'high' && strongestTitleRank < 5) confidence = 'medium'
  }

  const thin = titleEvidence.every((e) => e.snippet.trim().length < 20)
  if (thin) {
    reasons.push('Supporting text is too short to inspect, so confidence is reduced.')
    confidence = confidence === 'high' ? 'medium' : 'low'
  }

  return { confidence, reasons }
}

/**
 * Reports reachability WITHOUT changing it. When a provider returned contact
 * data but DM_STORE_CONTACT_DATA is off, this says so explicitly — otherwise a
 * deliberate privacy decision would be indistinguishable from a data gap.
 */
export function contactabilityOf(draft: CandidateDraft): Contactability {
  const hasContact = Boolean(draft.email || draft.phone)
  if (hasContact) return env.DM_STORE_CONTACT_DATA ? 'contactable' : 'withheld_by_policy'
  if (draft.profileUrl) return 'profile_only'
  return 'none'
}

// ── Ranking ────────────────────────────────────────────────────────────────

const MATCH_WEIGHT: Record<CompanyMatchLevel, number> = {
  verified: 30,
  probable: 12,
  unverified: 0,
  rejected: -100,
}
const CONFIDENCE_WEIGHT: Record<CandidateConfidence, number> = { high: 20, medium: 10, low: 0 }
const PRIORITY_WEIGHT: Record<number, number> = { 1: 40, 2: 24, 3: 10 }

/**
 * Builds the final scored candidate. Role relevance dominates seniority on
 * purpose: a Product Data Manager who owns the catalogue is a better
 * conversation than a CTO who has never heard of it.
 */
export function scoreCandidate(
  draft: CandidateDraft,
  company: CrmCompany,
  companyDomain: string | null,
  identity: string,
): ScoredCandidate {
  const providers = [...new Set(draft.evidence.map((e) => e.provider))].sort()
  const match = verifyCompanyMatch(draft, company, companyDomain)
  const role = draft.rawTitle ? matchRole(draft.rawTitle) : null
  const conf = scoreCandidateConfidence(draft, match.level, providers)

  const rankReasons: string[] = []
  let score = 0

  if (role) {
    const w = PRIORITY_WEIGHT[role.priority] ?? 0
    score += w
    rankReasons.push(`+${w} Priority ${role.priority} role (${role.roleGroup}) — matched on "${role.matchedFunction}".`)

    const sw = SENIORITY_WEIGHT[role.seniority] * 2
    score += sw
    rankReasons.push(`+${sw} seniority "${role.seniority}".`)
  } else {
    rankReasons.push('+0 title does not match any role group relevant to product-data decisions.')
  }

  score += MATCH_WEIGHT[match.level]
  rankReasons.push(
    `${MATCH_WEIGHT[match.level] >= 0 ? '+' : ''}${MATCH_WEIGHT[match.level]} company match "${match.level}".`,
  )

  score += CONFIDENCE_WEIGHT[conf.confidence]
  rankReasons.push(`+${CONFIDENCE_WEIGHT[conf.confidence]} evidence confidence "${conf.confidence}".`)

  if (providers.length > 1) {
    const cw = (providers.length - 1) * 8
    score += cw
    rankReasons.push(`+${cw} corroborated by ${providers.length} independent providers.`)
  }

  // Recency, only when a source actually dated its claim. A stale record of a
  // person who has since left is worth less than a current one, but MOST
  // sources here give no date at all, so an undated candidate is not penalised
  // -- that would punish the source's habits rather than the evidence.
  const dated = draft.evidence.map((e) => e.observedAt).filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
  if (dated.length) {
    const newest = Math.max(...dated.map((d) => d.getTime()))
    const ageDays = Math.floor((Date.now() - newest) / 86_400_000)
    const rw = ageDays <= 180 ? 6 : ageDays <= 730 ? 3 : 0
    score += rw
    rankReasons.push(`+${rw} most recent source evidence is ${ageDays} day(s) old.`)
  } else {
    rankReasons.push('+0 no source dated its claim, so recency could not be scored (not penalised).')
  }

  // Geography is recorded but deliberately NOT scored. The available sources
  // rarely state a person's location, and inventing a distance rule from a
  // company's country would be a guess dressed as arithmetic.

  return {
    identityKey: identity,
    fullName: draft.fullName,
    rawTitle: draft.rawTitle,
    normalizedTitle: role?.normalizedTitle ?? (draft.rawTitle ? displayNormalize(draft.rawTitle) : null),
    roleGroup: role?.roleGroup ?? null,
    rolePriority: role?.priority ?? null,
    roleIsFallback: role?.isFallback ?? false,
    seniority: role?.seniority ?? null,
    statedCompany: draft.statedCompany,
    profileUrl: draft.profileUrl,
    email: draft.email,
    phone: draft.phone,
    location: draft.location,
    companyMatch: match.level,
    companyMatchReasons: match.reasons,
    confidence: conf.confidence,
    confidenceReasons: conf.reasons,
    corroboratingProviders: providers,
    contactability: contactabilityOf(draft),
    rankScore: score,
    rankReasons: [...rankReasons, ...(role?.reasons ?? [])],
    evidence: draft.evidence,
  }
}

/** Normalisation for display when the title matched no role group. */
function displayNormalize(raw: string): string | null {
  const n = raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return n || null
}

/**
 * The shortlist.
 *
 * Two gates, both non-negotiable: a person whose employment was contradicted is
 * dropped entirely, and a person whose title matches no relevant role is
 * dropped even if they are a CEO. What survives is sorted by score and capped.
 *
 * Returning fewer than the cap — including zero — is a valid, honest outcome.
 */
export interface ShortlistExclusion {
  name: string
  identityKey: string
  reason: string
}

/** The reason a person whose employer no source established is not shortlisted. */
export const UNVERIFIED_EMPLOYER_REASON =
  'No source ties this person to this company, so their employment is unproven. Only people whose employment ' +
  'is verified or probable are shortlisted.'

export function selectShortlist(
  candidates: ScoredCandidate[],
  max: number,
): { shortlist: ScoredCandidate[]; excluded: ShortlistExclusion[] } {
  const excluded: ShortlistExclusion[] = []
  const kept: ScoredCandidate[] = []
  const exclude = (c: ScoredCandidate, reason: string) =>
    excluded.push({ name: c.fullName, identityKey: c.identityKey, reason })

  for (const c of candidates) {
    if (c.companyMatch === 'rejected') {
      exclude(c, `A source places them at "${c.statedCompany}", not this company.`)
      continue
    }
    // "No verified decision maker found" beats "probably this person". A
    // person nobody ties to this company is kept on record with the reason,
    // but never shortlisted — and, because they never reach the fallback
    // policy below, never counts as the company "having a specialist" either.
    if (c.companyMatch === 'unverified') {
      exclude(c, UNVERIFIED_EMPLOYER_REASON)
      continue
    }
    if (c.rolePriority === null) {
      exclude(
        c,
        c.rawTitle
          ? `Title "${c.rawTitle}" does not match any role group that owns product or catalog data.`
          : 'No job title was stated by any source, so relevance cannot be established.',
      )
      continue
    }
    kept.push(c)
  }

  // The approved fallback rule (Team Answer, Section E.3): Owner / GM /
  // Managing Director stands in only where the company has no specialist.
  // Decided across the whole set, because it is a fact about the COMPANY —
  // the same Managing Director is the right approach at a ten-person
  // distributor and the wrong one somewhere that employs a catalogue owner.
  const decision = applyFallbackPolicy(kept, (c) =>
    c.rolePriority === null ? null : { priority: c.rolePriority, isFallback: c.roleIsFallback },
  )
  for (const c of decision.suppressed) {
    exclude(
      c,
      `"${c.rawTitle ?? 'unknown title'}" is an executive-sponsor fallback, and this company has a ` +
        'specialist who owns product data. The fallback applies only where no specialist exists.',
    )
  }
  const eligible = decision.eligible

  eligible.sort(
    (a, b) =>
      b.rankScore - a.rankScore ||
      (a.rolePriority ?? 9) - (b.rolePriority ?? 9) ||
      a.fullName.localeCompare(b.fullName),
  )

  // People cut by the cap are excluded too, and recorded as such, so the
  // excluded list (and every count derived from it) covers everyone who was
  // not shortlisted.
  for (const c of eligible.slice(max)) {
    exclude(c, `Ranked below the top ${max} (score ${c.rankScore}).`)
  }

  return { shortlist: eligible.slice(0, max), excluded }
}

/** Groups raw provider output into merged, scored candidates. */
export function assembleCandidates(
  drafts: CandidateDraft[],
  company: CrmCompany,
  companyDomain: string | null,
): ScoredCandidate[] {
  return groupDrafts(drafts, company.id).map(({ key, drafts: group }) =>
    scoreCandidate(mergeDrafts(group), company, companyDomain, key),
  )
}

// ── Grouping sightings into people ─────────────────────────────────────────

/**
 * Common short forms of a first name. Deliberately small: a pair here only
 * ever merges two sightings that ALSO share a surname at the same company, and
 * only when no other candidate could claim either of them.
 */
const SHORT_FORMS: Record<string, string[]> = {
  robert: ['bob', 'bobby', 'rob', 'robbie'],
  william: ['bill', 'billy', 'will', 'liam'],
  james: ['jim', 'jimmy', 'jamie'],
  john: ['jack', 'johnny'],
  richard: ['rick', 'ricky', 'dick', 'rich'],
  anthony: ['tony'],
  elizabeth: ['liz', 'beth', 'betty', 'eliza', 'lizzie'],
  margaret: ['maggie', 'meg', 'peggy'],
  katherine: ['kate', 'kathy', 'katie'],
  catherine: ['cathy', 'kate', 'katie'],
  david: ['dave'],
  stephen: ['steve'],
  steven: ['steve'],
  edward: ['ed', 'eddie', 'ted'],
  michael: ['mike', 'mick'],
  christopher: ['chris'],
  christine: ['chris'],
  thomas: ['tom', 'tommy'],
  joseph: ['joe', 'joey'],
  daniel: ['dan', 'danny'],
  matthew: ['matt'],
  nicholas: ['nick'],
  alexander: ['alex'],
  alexandra: ['alex'],
  benjamin: ['ben'],
  samuel: ['sam'],
  samantha: ['sam'],
  jennifer: ['jen', 'jenny'],
  patricia: ['pat', 'patty', 'trish'],
  patrick: ['pat'],
  susan: ['sue'],
  deborah: ['debbie', 'deb'],
  gregory: ['greg'],
  timothy: ['tim'],
  kenneth: ['ken'],
  andrew: ['andy', 'drew'],
  charles: ['charlie', 'chuck'],
  lawrence: ['larry'],
  frederick: ['fred'],
  jonathan: ['jon'],
  nathaniel: ['nate', 'nathan'],
  victoria: ['vicky', 'tori'],
  rebecca: ['becky'],
  abigail: ['abby'],
}

/** Whether two DIFFERENT first names can plausibly be the same person's. */
export function firstNamesCompatible(a: string, b: string): boolean {
  if (!a || !b || a === b) return a === b && Boolean(a)
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  // "Chris" / "Christopher": a prefix of at least three letters. Initials are
  // never enough — "J Smith" could be anyone called J.
  if (short.length >= 3 && long.startsWith(short)) return true
  return (SHORT_FORMS[long] ?? []).includes(short) || (SHORT_FORMS[short] ?? []).includes(long)
}

function nameParts(fullName: string): { first: string; last: string } | null {
  const parts = normalizePersonName(fullName).split(' ').filter(Boolean)
  if (parts.length < 2) return null
  return { first: parts[0]!, last: parts[parts.length - 1]! }
}

/** Namespace of a provider person ID: "apollo:123" -> apollo; a bare ID -> its provider. */
function idNamespace(d: CandidateDraft): string {
  const m = /^([a-z0-9_]+):/i.exec(d.providerPersonId ?? '')
  return (m?.[1] ?? d.evidence[0]?.provider ?? 'unknown').toLowerCase()
}

const normUrl = (u: string) => u.toLowerCase().replace(/\/+$/, '')

interface Cluster {
  key: string
  drafts: CandidateDraft[]
  /** namespace -> IDs seen. Two different IDs in one namespace are two people. */
  ids: Map<string, Set<string>>
  urls: Set<string>
  names: Set<string>
}

function clusterConflicts(a: Cluster, b: Cluster): boolean {
  for (const [ns, ids] of a.ids) {
    const other = b.ids.get(ns)
    if (other && ![...ids].some((id) => other.has(id))) return true
  }
  if (a.urls.size && b.urls.size && ![...a.urls].some((u) => b.urls.has(u))) return true
  return false
}

function joinClusters(into: Cluster, from: Cluster): void {
  into.drafts.push(...from.drafts)
  for (const [ns, ids] of from.ids) {
    const set = into.ids.get(ns) ?? new Set<string>()
    ids.forEach((id) => set.add(id))
    into.ids.set(ns, set)
  }
  from.urls.forEach((u) => into.urls.add(u))
  from.names.forEach((n) => into.names.add(n))
}

/**
 * Groups one company's sightings into people.
 *
 * PASS 1 groups by identityKey — a provider ID, a profile URL, or the
 * company-scoped name. On its own that splits one person whenever one source
 * keyed them by an ID or URL and another only by name: a CRM contact carrying
 * a LinkedIn URL and the same name read off a web page became two candidates.
 *
 * PASS 2 joins groups whose normalised first+last name is identical, unless
 * they carry conflicting identifiers (two different IDs from one provider, or
 * two different profile URLs). If ANY pair sharing the name conflicts, none of
 * them are joined: a name-only sighting that could belong to either of two
 * distinct people belongs to neither.
 *
 * PASS 3 joins a short form to a full form ("Chris" / "Christopher") with an
 * identical surname, only when each side has exactly one such partner and they
 * do not conflict. Ambiguity keeps them apart.
 *
 * All evidence from every joined sighting is preserved.
 */
export function groupDrafts(
  drafts: CandidateDraft[],
  crmCompanyId: string,
): Array<{ key: string; drafts: CandidateDraft[] }> {
  // Pass 1.
  const byKey = new Map<string, Cluster>()
  for (const d of drafts) {
    const key = identityKey(d, crmCompanyId)
    let c = byKey.get(key)
    if (!c) {
      c = { key, drafts: [], ids: new Map(), urls: new Set(), names: new Set() }
      byKey.set(key, c)
    }
    c.drafts.push(d)
    if (d.providerPersonId) {
      const ns = idNamespace(d)
      const set = c.ids.get(ns) ?? new Set<string>()
      set.add(d.providerPersonId.toLowerCase())
      c.ids.set(ns, set)
    }
    if (d.profileUrl) c.urls.add(normUrl(d.profileUrl))
    const p = nameParts(d.fullName)
    if (p) c.names.add(`${p.first} ${p.last}`)
  }
  let clusters = [...byKey.values()]

  // Pass 2: identical first+last name.
  const byName = new Map<string, Cluster[]>()
  for (const c of clusters) {
    for (const n of c.names) {
      const list = byName.get(n) ?? []
      if (!list.includes(c)) list.push(c)
      byName.set(n, list)
    }
  }
  const absorbed = new Map<Cluster, Cluster>()
  const root = (c: Cluster): Cluster => {
    let r = c
    while (absorbed.has(r)) r = absorbed.get(r)!
    return r
  }
  for (const list of byName.values()) {
    const live = [...new Set(list.map(root))]
    if (live.length < 2) continue
    let conflict = false
    for (let i = 0; i < live.length && !conflict; i++) {
      for (let j = i + 1; j < live.length; j++) {
        if (clusterConflicts(live[i]!, live[j]!)) {
          conflict = true
          break
        }
      }
    }
    if (conflict) continue
    const [head, ...rest] = live
    for (const c of rest) {
      joinClusters(head!, c)
      absorbed.set(c, head!)
    }
  }
  clusters = clusters.filter((c) => !absorbed.has(c))

  // Pass 3: short form / full form with the same surname, unambiguous only.
  const partnersOf = (c: Cluster): Cluster[] =>
    clusters.filter((o) => {
      if (o === c) return false
      for (const a of c.names) {
        const [af, al] = a.split(' ')
        for (const b of o.names) {
          const [bf, bl] = b.split(' ')
          if (al === bl && af !== bf && firstNamesCompatible(af!, bf!)) return true
        }
      }
      return false
    })
  const pairs: Array<[Cluster, Cluster]> = []
  for (const c of clusters) {
    const mine = partnersOf(c)
    if (mine.length !== 1) continue
    const other = mine[0]!
    if (clusters.indexOf(other) < clusters.indexOf(c)) continue
    const theirs = partnersOf(other)
    if (theirs.length !== 1 || theirs[0] !== c) continue
    if (clusterConflicts(c, other)) continue
    pairs.push([c, other])
  }
  const joined = new Set<Cluster>()
  for (const [a, b] of pairs) {
    joinClusters(a, b)
    joined.add(b)
  }
  clusters = clusters.filter((c) => !joined.has(c))

  return clusters.map((c) => ({ key: c.key, drafts: c.drafts }))
}
