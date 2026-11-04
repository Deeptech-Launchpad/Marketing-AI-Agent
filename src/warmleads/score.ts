// WARM LEADS — the classification rule (2026-10-30). Pure: no I/O.
//
// Answers "is there current, evidenced reason to approach this company now?"
// from what the evaluation actually observed, and says why in reasons a person
// can check. The outcomes (2026-10-31 decision):
//
//   warm               score >= WARM_THRESHOLD (50) AND at least one VERIFIED
//                      INTENT signal — something the company did or that
//                      happened to it: a reply written by a person, or a
//                      published business event with a source we could check.
//   early_signal       score 25-49 AND at least one verified, FRESH intent
//                      signal. Not warm, not cold: a person should look.
//   cold               evaluated, and nothing current enough to act on.
//   insufficient_data  there was nothing to read: no website on the record (or the
//                      site itself says its page does not exist) and no CRM
//                      history, or the web research it needed did not run.
//
// and three statuses of their own, because each means something different to
// sales and none of them is "cold" (the CRM already knows these companies):
//
//   existing_customer  a won deal is on record
//   active_opportunity an open deal is in progress
//   do_not_contact     on the suppression list — never approached by outreach
//
// NEVER enough on its own for warm OR early signal: the company existing in the
// CRM, having a website, a platform detected on it, or a shop/product catalogue.
// Those are FIT, not intent.
//
// A website that could not be READ — connection reset, firewall block page,
// timeout, bot wall — is none of these. That is a failed evaluation to retry
// (retryReason below), because it describes the network, not the company
// (websiteAccess.ts).
//
// What can NEVER make a company warm on its own: existing in the CRM, having a
// website, or the website showing a shop/product catalogue. Those are FIT, not
// intent, and carry few points by design.
//
// The weights are PROVISIONAL, like every other score in this platform
// (intentscore/policy.ts): a first, explainable rule to be checked against the
// test sample before anything else is evaluated.

export const WARM_THRESHOLD = 50
export const EARLY_SIGNAL_MIN = 25

export const POINTS = {
  inboundEngagement: 45,
  publicSignal: { high: 25, medium: 15, low: 0 },
  publicSignalCap: 60,
  technologyAdded: 10,
  websiteFit: 10,
  negativePublicSignal: -10,
  excluded: -100,
} as const

export type Classification = 'warm' | 'early_signal' | 'cold' | 'insufficient_data' | 'existing_customer' | 'active_opportunity' | 'do_not_contact'
export type Confidence = 'high' | 'medium' | 'low'
/** skipped_cap: the per-run research limit was used up. skipped_ceiling: the Gemini call ceiling was reached (research not started, or cut short). Neither may ever end as "cold". */
export type DeepCheck = 'done' | 'not_needed' | 'skipped_cap' | 'skipped_ceiling' | 'failed'

export interface Reason {
  signal: string
  polarity: 'positive' | 'negative' | 'neutral'
  points: number
  summary: string
  evidence: string | null
  sourceUrl: string | null
  observedAt: string | null
  /** fresh | aging | stale | unknown — how current the evidence is; null for facts that have no age (the website). */
  freshness: string | null
  source: 'crm' | 'website' | 'web_research'
}

/** A signal as Intent Signals stores and presents it (see intent/signalView.ts). */
export interface ObservedSignal {
  signalType: string
  signalCategory: string
  polarity: string
  confidence: string
  freshness: string
  status: string
  summary: string
  evidence: string
  sourceUrl: string | null
  observedAt: Date | string | null
}

export interface WebsiteObservation {
  /**
   * reachable     the page was read
   * no_website    nothing usable on the CRM record (decided before any request)
   * unreachable   the site itself answered that its page does not exist (404/410)
   * partial       the address redirected to a different company's site
   * not_checked   no request was made: the CRM already rules the company out (customer, open deal,
   *               do-not-contact), so its website is not read and nothing is spent on it
   * access_failed the page could NOT be read for a reason about the network, a
   *               firewall or the fetch (reset, block page, timeout, 403/429,
   *               DNS, TLS, 5xx, or the read itself failing) — retry, never classify
   */
  status: 'reachable' | 'unreachable' | 'no_website' | 'partial' | 'access_failed' | 'not_checked'
  url: string | null
  hasProductSchema: boolean
  /** Names of e-commerce / product-information platforms detected in the markup. */
  commercePlatforms: string[]
  failureReason?: string | null
}

export interface EvaluationInput {
  /** Signals from the CRM read (CrmSignalProvider). `ok:false` = a CRM call failed. */
  crm: { ok: boolean; signals: ObservedSignal[]; reason?: string | null }
  website: WebsiteObservation
  /** Signals of the web research, when it ran. */
  deep: { status: DeepCheck; signals: ObservedSignal[]; reason?: string | null }
}

export interface EvaluationResult {
  classification: Classification
  score: number
  confidence: Confidence
  summary: string
  reasons: Reason[]
}

const EXCLUDING = new Set(['existing_customer', 'open_opportunity', 'suppressed'])
/** Web-research categories that describe an event, which is what intent means here. */
const INTENT_CATEGORIES = new Set(['business', 'news'])

const iso = (d: Date | string | null): string | null => {
  if (!d) return null
  const t = d instanceof Date ? d : new Date(d)
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10)
}

/** A sentence without its closing full stop, so it can be placed inside another sentence. */
const noStop = (t: string) => t.trim().replace(/[.\s]+$/, '')

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }
const FRESHNESS_RANK: Record<string, number> = { fresh: 3, aging: 2, unknown: 1, stale: 0 }

/**
 * ONE EVENT, ONE SIGNAL. The same announcement is often recorded more than once — a later run finds it again in
 * different words, or two pages quote it. Pro Safety's single announcement (23 Oct, on its blog) was counted twice
 * on the second test (+25 +25) and turned a 35-point early signal into a "warm" 60. Signals from the same source
 * page on the same day are the same event: only the best is counted, the others are listed with 0 points.
 */
function duplicateEvents(signals: ObservedSignal[]): Set<ObservedSignal> {
  const groups = new Map<string, ObservedSignal[]>()
  for (const s of signals) {
    if (!INTENT_CATEGORIES.has(s.signalCategory) || s.polarity !== 'positive' || s.status !== 'active') continue
    const day = iso(s.observedAt)
    const page = (s.sourceUrl ?? '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '')
    if (!day || !page) continue
    const key = `${page}|${day}`
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const losers = new Set<ObservedSignal>()
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const best = [...g].sort(
      (a, b) =>
        (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0) ||
        (FRESHNESS_RANK[b.freshness] ?? 0) - (FRESHNESS_RANK[a.freshness] ?? 0) ||
        b.evidence.length - a.evidence.length,
    )[0]!
    for (const s of g) if (s !== best) losers.add(s)
  }
  return losers
}

/** Whether the CRM already rules the company out: an existing customer, an open deal, or on the suppression list. */
export const ruledOutByCrm = (signals: Array<{ signalType: string }>): boolean => signals.some((s) => EXCLUDING.has(s.signalType))

/** Whether a company is worth the paid web research: it is a lead, its site is readable, and there is a first sign. */
export function needsDeepCheck(crm: EvaluationInput['crm'], website: WebsiteObservation): boolean {
  if (!crm.ok) return false
  if (crm.signals.some((s) => EXCLUDING.has(s.signalType))) return false
  if (website.status !== 'reachable') return false
  const fit = website.hasProductSchema || website.commercePlatforms.length > 0
  const engaged = crm.signals.some((s) => s.signalType === 'inbound_engagement')
  return fit || engaged
}

/**
 * Why this evaluation must be FAILED and retried instead of classified, or null.
 *
 * Checked first, always. A company the CRM already rules out (existing
 * customer, open deal, do-not-contact) stays "cold: not a new lead" whatever the
 * network did — nothing the website says could change that. Every other company
 * whose website, or whose web research, could not be read has not been looked at.
 */
export function retryReason(input: EvaluationInput): string | null {
  if (input.crm.signals.some((s) => EXCLUDING.has(s.signalType))) return null
  if (input.website.status === 'access_failed') {
    return input.website.failureReason ?? 'The website could not be read. Retry from a network that can open the site.'
  }
  if (input.deep.status === 'failed') {
    return `${input.deep.reason ?? 'The web research could not be completed.'} Retry from a network that can read public pages.`
  }
  return null
}

/** One reason line recording what the website read returned, kept on a failed evaluation so it can be reviewed. */
export function accessFailureReason(w: WebsiteObservation, message: string): Reason {
  return { signal: 'website_access_failed', polarity: 'neutral', points: 0, summary: message, evidence: null, sourceUrl: w.url, observedAt: null, freshness: null, source: 'website' }
}

const incompleteResearchText = (status: DeepCheck): string =>
  status === 'skipped_ceiling'
    ? 'Web research is incomplete: the Gemini call ceiling was reached before it could finish. Not classified as cold; evaluate again.'
    : 'Flagged for web research, which did not run in this batch (limit reached). Not classified as cold; evaluate again.'

export function classify(input: EvaluationInput): EvaluationResult {
  // A failed read is never an answer. Callers decide with retryReason first;
  // reaching here with one is a bug, and must not turn into "cold".
  if (retryReason(input)) throw new Error('classify() was called for an evaluation that must be retried (the website or web research could not be read).')
  const reasons: Reason[] = []
  const add = (r: Reason) => reasons.push(r)

  // The intent signals that are VERIFIED (a reply a person wrote; a business event whose source could be
  // checked), with whether each is fresh. Only these can make a company warm or an early signal.
  const verified: Array<{ reason: Reason; fresh: boolean }> = []

  // ── CRM ────────────────────────────────────────────────────────────────
  for (const s of input.crm.signals) {
    const base = { evidence: s.evidence || null, sourceUrl: null, observedAt: iso(s.observedAt), source: 'crm' as const }
    if (EXCLUDING.has(s.signalType)) {
      const why = s.signalType === 'existing_customer' ? 'Existing customer' : s.signalType === 'open_opportunity' ? 'Active opportunity (open deal in NXT Sales)' : 'On the do-not-contact list'
      add({ signal: s.signalType, polarity: 'negative', points: POINTS.excluded, summary: `${why} — not a new lead (${s.summary})`, freshness: null, ...base })
    } else if (s.signalType === 'inbound_engagement') {
      const r: Reason = { signal: s.signalType, polarity: 'positive', points: POINTS.inboundEngagement, summary: s.summary, freshness: s.freshness, ...base }
      add(r)
      verified.push({ reason: r, fresh: s.freshness === 'fresh' })
    } else {
      add({ signal: s.signalType, polarity: s.polarity === 'negative' ? 'negative' : 'neutral', points: 0, summary: s.summary, freshness: null, ...base })
    }
  }

  // ── Website (fit, never intent) ────────────────────────────────────────
  const w = input.website
  if (w.status === 'reachable') {
    const fit: string[] = []
    if (w.commercePlatforms.length) fit.push(`runs ${w.commercePlatforms.join(', ')}`)
    if (w.hasProductSchema) fit.push('publishes product data (schema.org Product)')
    add({
      signal: fit.length ? 'website_product_fit' : 'website_reachable',
      polarity: fit.length ? 'positive' : 'neutral',
      points: fit.length ? POINTS.websiteFit : 0,
      summary: fit.length ? `Website ${fit.join(' and ')} — fits our offer (fit, not intent)` : 'Website reachable; no shop or product catalogue detected',
      evidence: null,
      sourceUrl: w.url,
      observedAt: null,
      freshness: null,
      source: 'website',
    })
  } else {
    const what =
      w.status === 'no_website' ? 'No website on the CRM record' :
      w.status === 'unreachable' ? 'The website says its page does not exist' :
      w.status === 'partial' ? 'Website redirects to a different company' :
      w.status === 'not_checked' ? 'Website not read: the CRM already rules this company out' :
      'Website could not be read'
    add({ signal: `website_${w.status}`, polarity: 'neutral', points: 0, summary: what, evidence: w.failureReason ?? null, sourceUrl: w.url, observedAt: null, freshness: null, source: 'website' })
  }

  // ── Web research (only for companies the screen flagged) ───────────────
  let publicPoints = 0
  const sameEvent = duplicateEvents(input.deep.signals)
  for (const s of input.deep.signals) {
    if (s.signalCategory === 'crm') continue // already counted from the CRM read above
    if (s.status !== 'active') continue // weak or expired evidence is not counted
    // The proof of a detected platform is a raw fragment of the page's markup (it can even hold a public
    // storefront token): kept in the Marketing agent's own records, never copied into the CRM.
    const base = { evidence: s.signalCategory === 'technology' ? null : s.evidence || null, sourceUrl: s.sourceUrl, observedAt: iso(s.observedAt), freshness: s.freshness, source: 'web_research' as const }
    if (s.signalType === 'technology_added' && s.polarity === 'positive') {
      // A platform CHANGE is still a platform detection: it carries its points but never qualifies a company as
      // warm or an early signal on its own (2026-10-31 decision) — it is not added to `verified`.
      add({ signal: s.signalType, polarity: 'positive', points: POINTS.technologyAdded, summary: `${s.summary} (platform detection: fit, not a qualifying intent signal)`, ...base })
      continue
    }
    // Only an EVENT is intent: something the company did or that happened to it
    // (business, news). A platform seen on its site, a website fact or a
    // question asked somewhere in its market describes what the company IS or
    // its market — fit and context, listed but never counted as intent. The
    // first test run counted "WooCommerce detected" as intent and called a
    // company warm on fit alone (2026-10-30).
    if (!INTENT_CATEGORIES.has(s.signalCategory)) {
      if (s.polarity !== 'neutral') add({ signal: s.signalType, polarity: 'neutral', points: 0, summary: `${s.summary} (context, not counted as intent)`, ...base })
      continue
    }
    if (sameEvent.has(s)) {
      add({ signal: s.signalType, polarity: 'positive', points: 0, summary: `${s.summary} (the same event as another signal from the same page and date: counted once)`, ...base })
      continue
    }
    if (s.polarity === 'positive') {
      let pts: number = POINTS.publicSignal[s.confidence as Confidence] ?? 0
      if (s.freshness === 'aging') pts = Math.floor(pts / 2)
      if (s.freshness === 'stale') pts = 0
      // VERIFIED: an event with no source address to check cannot be verified, so it counts for nothing.
      const unverifiable = pts > 0 && !s.sourceUrl
      if (unverifiable) pts = 0
      pts = Math.max(0, Math.min(pts, POINTS.publicSignalCap - publicPoints))
      publicPoints += pts
      const r: Reason = {
        signal: s.signalType,
        polarity: 'positive',
        points: pts,
        summary: pts ? s.summary : `${s.summary} (not counted: ${unverifiable ? 'no source address to verify it' : `${s.confidence} confidence, ${s.freshness}`})`,
        ...base,
      }
      add(r)
      if (pts > 0) verified.push({ reason: r, fresh: s.freshness === 'fresh' })
    } else if (s.polarity === 'negative') {
      add({ signal: s.signalType, polarity: 'negative', points: POINTS.negativePublicSignal, summary: s.summary, ...base })
    }
  }

  const score = Math.max(0, Math.min(100, reasons.reduce((n, r) => n + r.points, 0)))
  const intent = verified.map((v) => v.reason)
  const freshIntent = verified.filter((v) => v.fresh).map((v) => v.reason)
  const crmHistory = input.crm.signals.length > 0
  const websiteRead = w.status === 'reachable'
  const has = (t: string) => input.crm.signals.some((s) => s.signalType === t)
  const researchIncomplete = input.deep.status === 'skipped_cap' || input.deep.status === 'skipped_ceiling'

  let classification: Classification
  let summary: string
  if (has('suppressed')) {
    // The most restrictive first: a company on the suppression list is never approached, whatever else is true of it.
    classification = 'do_not_contact'
    summary = 'Do not contact: on the suppression list. It is never approached by outreach.'
  } else if (has('open_opportunity')) {
    classification = 'active_opportunity'
    summary = 'Active opportunity: an open deal is in progress with the sales team — not a new lead.'
  } else if (has('existing_customer')) {
    classification = 'existing_customer'
    summary = 'Existing customer: a won deal is on record — account management, not new-business outreach.'
  } else if (!websiteRead && (!crmHistory || (!intent.length && input.deep.status !== 'done'))) {
    // Nothing was read, no web research was done and there is no intent evidence: a CRM note such as a bounce is not an examination, so the company
    // cannot be called cold on it. Cold needs a website that was read or research that finished.
    classification = 'insufficient_data'
    const history = crmHistory ? 'the CRM history shows no current interest' : 'there is no recent CRM history'
    summary =
      w.status === 'partial'
        ? `Nothing to evaluate: the website on record redirects to a different company's site, and ${history}.`
        : w.status === 'unreachable'
          ? `Nothing to evaluate: the website says its page does not exist, and ${history}.`
          : `Nothing to evaluate: no website on the CRM record and ${history}.`
  } else if (researchIncomplete && !intent.length) {
    classification = 'insufficient_data'
    summary = incompleteResearchText(input.deep.status)
  } else if (score >= WARM_THRESHOLD && intent.length) {
    classification = 'warm'
    summary = `Warm: ${intent.map((r) => noStop(r.summary)).slice(0, 2).join('; ')}.`
  } else if (score >= EARLY_SIGNAL_MIN && score < WARM_THRESHOLD && freshIntent.length) {
    classification = 'early_signal'
    summary = `Early signal — needs review: ${noStop(freshIntent[0]!.summary)}. Score ${score}; ${WARM_THRESHOLD} and a verified signal are needed for warm.`
  } else if (researchIncomplete) {
    // Research that did not finish can never be the reason a company is called cold: "nothing found" is only
    // true of research that was done. What was found is kept; the conclusion is left open.
    classification = 'insufficient_data'
    summary = `${incompleteResearchText(input.deep.status)} Some interest was found (score ${score}) but not enough to classify without the rest.`
  } else {
    classification = 'cold'
    summary = intent.length
      ? score < EARLY_SIGNAL_MIN
        ? `Some interest found, but below an early signal (score ${score}; ${EARLY_SIGNAL_MIN} needed).`
        : `Some interest found, but nothing fresh enough for an early signal (score ${score}; the evidence is not recent).`
      : input.deep.status === 'done'
        ? 'Web research found no current buying signal.'
        : 'No sign of current interest: no recent reply on record and no fit that justified web research.'
  }

  let confidence: Confidence
  if (classification === 'warm') {
    confidence = intent.length >= 2 || reasons.some((r) => r.signal === 'inbound_engagement') ? 'high' : 'medium'
  } else if (classification === 'early_signal') {
    confidence = 'medium'
  } else if (classification === 'existing_customer' || classification === 'active_opportunity' || classification === 'do_not_contact') {
    confidence = 'high' // facts the CRM holds
  } else if (classification === 'cold') {
    confidence = input.deep.status === 'done' ? 'high' : websiteRead ? 'medium' : 'low'
  } else {
    confidence = 'low'
  }

  return { classification, score, confidence, summary, reasons }
}
