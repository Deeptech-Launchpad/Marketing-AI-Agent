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
//   human_review       the company's own signals would make it Warm or an Early Signal, but its newest reply asked not to be
//                      contacted or said no: a person decides; it is not offered as an actionable lead and not sent to NXT Sales.
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

export type Classification = 'warm' | 'early_signal' | 'cold' | 'insufficient_data' | 'existing_customer' | 'active_opportunity' | 'do_not_contact' | 'human_review'

/**
 * The CRM signals (replies.ts) that record a person saying no to being approached at all. A company with one of these whose
 * independent company-level evidence would still make it Warm or an Early Signal is HUMAN REVIEW REQUIRED, never an actionable lead.
 * (A rejection of one product, a wrong-person answer or a declined meeting are not in this list.)
 */
export const COMPANY_LEVEL_REFUSALS: ReadonlySet<string> = new Set(['reply_opt_out', 'reply_declined', 'contact_opt_out'])
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

// ── Comparing two descriptions of one event ──────────────────────────────────────────────────────────────────────────────────────
// Unicode-aware (Hindi, Chinese, German, Arabic ... summaries are compared the same way English ones are), light stemming so
// "opens / opened / opening" and "expand / expanding" are one word, and a rule for which differences matter: a different NUMBER
// (after "1,000" = "1000", "5M" = "5 million", "two" = "2"), or a different NAME in the same place of the sentence ("in Pune" /
// "in Delhi", "with Acme" / "with Globex"). Who REPORTED it ("according to Reuters", "said Rahul Sharma"), the form of a company
// name ("Corp" / "Corporation" / "Ltd") and any date written in the text (the event date is observedAt) are not facts. Extra detail
// on one side ("Pune, India" against "Pune, Maharashtra") is not a different event. Kept deliberately explainable: every signal
// that is folded into another is listed with 0 points and says so.

const STOP_WORDS = new Set(['that', 'this', 'with', 'from', 'have', 'been', 'will', 'were', 'their', 'there', 'about', 'which', 'after', 'into', 'also', 'announced', 'announces', 'company', 'its', 'for', 'and', 'the', 'reports', 'report', 'reported', 'says', 'said'])
/** Hindi function words (Devanagari words are short, so these are filtered by list rather than by length). */
const HINDI_STOP = new Set(['है', 'हैं', 'में', 'ने', 'को', 'से', 'का', 'की', 'के', 'और', 'एक', 'ताकि', 'पर', 'भी', 'कि', 'यह', 'था', 'थी', 'थे', 'जा', 'सके', 'रहा', 'रही', 'गया', 'गई', 'किया', 'हुआ', 'लिए', 'साथ', 'द्वारा', 'वह', 'इस', 'उस'])
/** Words that start a sentence and are capitalised only for that reason. */
const SENTENCE_STARTERS = new Set(['the', 'a', 'an', 'new', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'we', 'our', 'after', 'following', 'in', 'on', 'at', 'as', 'with', 'for', 'by', 'from', 'to', 'and', 'but', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'company', 'announced', 'announces', 'now', 'today', 'recently', 'also'])
/** The form of a company name, not a different company. */
const COMPANY_FORMS = new Set(['corp', 'corporation', 'ltd', 'limited', 'inc', 'incorporated', 'pvt', 'private', 'llc', 'llp', 'plc', 'co', 'gmbh', 'ag', 'sa', 'srl', 'bv', 'pty'])
/** Words before a name that make it one of two things in the same place of the sentence ("in Pune" / "at Delhi"). */
const PREPOSITIONS = new Set(['^', 'in', 'at', 'near', 'to', 'into', 'from', 'with', 'by', 'of', 'for', 'on', 'and', 'between', 'around', 'across', 'through'])
const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10', twenty: '20', thirty: '30', fifty: '50', hundred: '100' }
const SUMMARY_MAX = 1000

const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const WEEKDAYS = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)'
/** Native-script zero digits: 0-9 are the ten code points from here. */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0x0ed0, 0x1040]

/** A description made comparable: native digits to 0-9, "1,000" to "1000", "5M" to 5000000, ordinals and dates out, attribution out. */
function comparable(raw: string): string {
  let t = String(raw ?? '').normalize('NFKC').slice(0, SUMMARY_MAX)
  t = t.replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0)!
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9)
    return zero === undefined ? d : String(cp - zero)
  })
  // who reported it is not what happened: "according to Reuters", "Economic Times reports ...", ", said Rahul Sharma", "Reuters: ..."
  t = t
    .replace(/\b(?:according to|reported by|as reported by|reports? from|via|per)\s+(?:\p{Lu}[\p{L}.&'-]*\s*){1,4}/gu, ' ')
    .replace(/(?:\p{Lu}[\p{L}.&'-]*\s+){1,4}(?:reports?|reported|writes|wrote)\b/gu, ' ')
    .replace(/,?\s*(?:said|says|added|noted|told)\s+(?:\p{Lu}[\p{L}.&'-]*\s*){1,4}/gu, ' ')
    .replace(/^\s*(?:\p{Lu}[\p{L}.&'-]*\s*){1,3}:\s+/u, ' ')
  // a headline's outlet suffix: "... - Reuters", "... | The Economic Times" (a short, capitalised tail after a spaced hyphen, dash or pipe) names who published it, not what happened
  t = t.replace(/\s[-|\u2013\u2014]\s+\p{Lu}[^-|\u2013\u2014]{1,38}$/u, ' ')
  // dates are carried by observedAt, not by the wording
  t = t
    .replace(new RegExp(`\\b${WEEKDAYS}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS}\\b\\.?(?:\\s+(?:19|20)\\d\\d)?|\\b${MONTHS}\\b\\.?\\s*\\d{0,2}(?:st|nd|rd|th)?(?:,?\\s+(?:19|20)\\d\\d)?`, 'gi'), ' ')
    .replace(/\b(?:19|20)\d\d\b/g, ' ')
  // numbers: 1,000 -> 1000; 23rd -> 23; 5M / 5 million -> 5000000
  t = t.replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1')
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*(k|thousand|m|mn|million|b|bn|billion|cr|crore|lakh|lac)\b/gi, (_w, n: string, u: string) => {
    const scale: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, cr: 1e7, crore: 1e7, lakh: 1e5, lac: 1e5 }
    return String(Math.round(Number(n) * (scale[u.toLowerCase()] ?? 1)))
  })
  return t
}

interface Tok {
  /** Lower case, accents removed, "centre" = "center". */
  key: string
  number: boolean
  /** Capitalised, and not just because it opens the sentence or the headline is in title case: a place, a company, a product. */
  proper: boolean
  /** Written after a comma, bracket or dash: an appositive ("Pune, India"), not the same place in the sentence. */
  afterBreak: boolean
  /** The word before it ("in", "with"), or "^" when it opens the text. */
  prev: string
}

const keyOf = (w: string): string => w.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/̇/g, '').replace(/tre$/, 'ter')

/** Crude English stemming: "opens", "opened", "opening" -> "open"; "warehouses" -> "warehous". Words that are not English pass through. */
function stem(w: string): string {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w.replace(/e$/, '')
  let s = w.replace(/(?:ational|ations|ation|ings|ing|ions|ion|edly|ed|ly|ies|es|(?<!s)s)$/, (m) => (m === 'ies' ? 'y' : ''))
  if (s.length < 3) s = w
  return s.replace(/gue$/, 'g').replace(/e$/, '')
}

const CJK_RUN = /\p{Script=Han}+|\p{Script=Hiragana}+|\p{Script=Katakana}+|\p{Script=Thai}+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]+/gu

interface Prepared {
  s: ObservedSignal
  /** The meaningful words (stems; two-character groups for scripts written without spaces). */
  words: Set<string>
  toks: Tok[]
  numbers: Set<string>
  keys: Set<string>
  page: string
  day: string | null
  dayNo: number | null
}

function prepare(s: ObservedSignal): Prepared {
  const text = comparable(s.summary)
  const words = new Set<string>()
  const toks: Tok[] = []
  let prev = '^'
  let afterBreak = false
  const matches = [...text.matchAll(/([\p{L}\p{M}\p{N}]+)([^\p{L}\p{M}\p{N}]*)/gu)]
  // a headline in Title Case (nearly every word capitalised) has no proper names to speak of
  const capitalised = matches.filter((m) => /^\p{Lu}/u.test(m[1]!)).length
  const titleCase = matches.length >= 5 && capitalised / matches.length >= 0.7
  for (const m of matches) {
    const word = m[1]!
    const brk = /[,;:()–—]/.test(m[2] ?? '')
    for (const run of word.match(CJK_RUN) ?? []) {
      const lower = run.toLowerCase()
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(run)) {
        if (run.length === 1) words.add(run)
        for (let i = 0; i + 1 < run.length; i++) words.add(run.slice(i, i + 2))
        continue
      }
      if (COMPANY_FORMS.has(lower)) continue // "Acme Corp" and "Acme Corporation" are one name
      const spelled = NUMBER_WORDS[lower]
      const number = /\d/.test(run) || spelled !== undefined
      const first = toks.length === 0
      const proper = !number && !titleCase && /^\p{Lu}/u.test(run) && !(first && SENTENCE_STARTERS.has(lower)) && (run.length >= 2 || !first)
      const key = spelled ?? keyOf(run)
      toks.push({ key, number, proper, afterBreak, prev })
      prev = lower
      afterBreak = false
      if (STOP_WORDS.has(lower) || HINDI_STOP.has(lower)) continue
      if (/^[\p{Script=Latin}\d]+$/u.test(run)) {
        if (lower.length >= 4 || spelled !== undefined) words.add(stem(keyOf(run)))
      } else if (lower.length >= 3) words.add(lower)
    }
    afterBreak = brk
  }
  const day = iso(s.observedAt)
  return {
    s,
    words,
    toks,
    numbers: new Set(toks.filter((t) => t.number).map((t) => t.key)),
    keys: new Set(toks.map((t) => t.key)),
    page: pageOf(typeof s.sourceUrl === 'string' ? s.sourceUrl : null),
    day,
    dayNo: day ? Date.parse(day) / 86_400_000 : null,
  }
}

/** Query parameters that only say where a visitor came from; every other parameter can identify a different article. */
const TRACKING_PARAM = /^(?:utm_.*|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|cmpid|_ga|spm|share|source|campaign)$/i
/**
 * A page address, spelled one way: no scheme, no "www.", no fragment, no trailing slash, no tracking parameters. Parameters that
 * identify the page (`news.aspx?id=101`) are kept, in a fixed order. A hash route (`/#/news/1`) is kept: it names the page.
 */
function pageOf(u: string | null): string {
  const raw = (u ?? '').trim().slice(0, 2000)
  if (!raw) return ''
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw)
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#(?!\/).*$/, '').replace(/\/+$/, '')
  }
  const query = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .sort()
    .join('&')
  const route = url.hash.startsWith('#/') ? url.hash.toLowerCase() : ''
  return url.hostname.toLowerCase().replace(/^www\./, '') + url.pathname.toLowerCase().replace(/\/+$/, '') + (query ? '?' + query : '') + route
}

/** Shared words, their share of all the words either description uses, and their share of the shorter description. */
function overlap(a: Prepared, b: Prepared): { shared: number; ratio: number; contained: number } {
  let shared = 0
  for (const w of a.words) if (b.words.has(w)) shared++
  const union = a.words.size + b.words.size - shared
  const shorter = Math.min(a.words.size, b.words.size)
  return { shared, ratio: union === 0 ? 0 : shared / union, contained: shorter === 0 ? 0 : shared / shorter }
}
/**
 * Two descriptions say the same thing: at least 4 meaningful words in common AND those words are at least 60% of all the
 * meaningful words either uses - or nearly all of the SHORTER description's words (a short version of a long retelling). One
 * announcement retold ("... service center" / "... service center for respiratory devices, trade press reports") shares nearly
 * everything. Two very short descriptions with the very same words are the same too.
 */
const sameWords = (a: Prepared, b: Prepared): boolean => {
  const { shared, ratio, contained } = overlap(a, b)
  return (shared >= 4 && (ratio >= 0.6 || contained >= 0.8)) || (shared >= 2 && ratio === 1)
}
/** Looser, for two records of the same page on the same day: some wording in common, so they can be one thing. */
const similarWords = (a: Prepared, b: Prepared): boolean => {
  const { shared, ratio, contained } = overlap(a, b)
  return shared >= 3 && (ratio >= 0.4 || contained >= 0.75)
}

/**
 * The two descriptions name DIFFERENT facts: a number one has and the other has not while each has its own, or a different name
 * where the sentence puts a place or a party ("in Pune" / "at Delhi", "with Acme" / "with Globex", "Pune warehouse" / "Delhi
 * warehouse", "Series A" / "Series B"). A name that only one side mentions, or that follows a comma ("Pune, India" / "Pune,
 * Maharashtra"), is extra detail. Text with no capital letters (some scripts have none) can only be told apart by its numbers.
 */
function factsConflict(a: Prepared, b: Prepared): boolean {
  const onlyA = [...a.numbers].filter((n) => !b.numbers.has(n))
  const onlyB = [...b.numbers].filter((n) => !a.numbers.has(n))
  if (onlyA.length && onlyB.length) return true
  // a one-letter name ("Series A") is compared only with the other side's names, not with its articles ("a round")
  const seenIn = (other: Prepared, t: Tok) => (t.key.length > 1 ? other.keys.has(t.key) : other.toks.some((o) => o.proper && o.key === t.key))
  const namesA = a.toks.filter((t) => t.proper && !t.afterBreak && !seenIn(b, t))
  const namesB = b.toks.filter((t) => t.proper && !t.afterBreak && !seenIn(a, t))
  return namesA.some((x) => namesB.some((y) => x.prev === y.prev || (PREPOSITIONS.has(x.prev) && PREPOSITIONS.has(y.prev))))
}

/** A news item is republished within about a week; the same words long after are a new item. */
export const REPUBLISH_WINDOW_DAYS = 7
const sameKind = (a: Prepared, b: Prepared): boolean => a.s.signalType === b.s.signalType && a.s.polarity === b.s.polarity
const withinWindow = (a: Prepared, b: Prepared): boolean => a.dayNo !== null && b.dayNo !== null && Math.abs(a.dayNo - b.dayNo) <= REPUBLISH_WINDOW_DAYS

/** One announcement told again: same kind, dated within a week of each other, in nearly the same words, naming the same facts. */
const sameStory = (a: Prepared, b: Prepared): boolean => sameKind(a, b) && withinWindow(a, b) && sameWords(a, b) && !factsConflict(a, b)
/** Two items that look alike but name different facts: a signal must not be pulled into an event whose other copies disagree. */
const conflicts = (a: Prepared, b: Prepared): boolean => sameKind(a, b) && withinWindow(a, b) && factsConflict(a, b)
/**
 * The same page on the same day (or with one date missing), of the same kind, in similar words, naming no different fact: the
 * page is the event. Two DIFFERENT things announced on one page on one day (a shop launch and a distribution agreement) are
 * two events; a page address that differs in a parameter that identifies the article is a different page.
 */
const samePage = (a: Prepared, b: Prepared): boolean =>
  a.page !== '' && a.page === b.page && (a.day === b.day || !a.day || !b.day) && sameKind(a, b) && similarWords(a, b) && !factsConflict(a, b)

/**
 * ONE EVENT, ONE SIGNAL. The same announcement is often recorded more than once — a later run finds it again in
 * different words, two pages quote it, a news site republishes it the next day, or its date was not captured the second
 * time. Pro Safety's single announcement (23 Oct, on its blog) was counted twice on the second test (+25 +25) and turned
 * a 35-point early signal into a "warm" 60; the same announcement on a second site a day later did the same.
 * Two signals are the same event when
 *   - they come from the same page and are dated the same day (or one of them has no date), are of the same kind and describe
 *     it in similar words without naming a different fact, or
 *   - they are of the same kind, dated within a week of each other, describe it in nearly the same words, and name the same
 *     facts (places, companies, numbers) - the same news on another page, or republished.
 * A signal is never pulled into an event if ANY other copy of it names a different fact (on the same page or not). Only the best
 * of each group is counted (the best evidenced; if equal, the EARLIEST, so a republication never makes old news look fresh); the
 * others are listed with 0 points. A different development - another place, company or number, another kind, or the same words
 * long afterwards - stays its own event. The same holds for NEGATIVE news: a layoff reported by three sites is one layoff.
 * Known limits: the same story in clearly DIFFERENT words (a synonym for the verb, another outlet's own phrasing) is not
 * recognised; a different kind of signal (another signalType) is never folded in; an English copy and a Hindi copy of one story are
 * not compared.
 */
function duplicateEvents(signals: ObservedSignal[]): Set<ObservedSignal> {
  // A fixed order, so the same signals give the same groups whatever order they arrive in.
  const cands = signals
    .filter((s) => INTENT_CATEGORIES.has(s.signalCategory) && (s.polarity === 'positive' || s.polarity === 'negative') && s.status === 'active')
    .map(prepare)
    .sort(
      (a, b) =>
        (a.day ?? '').localeCompare(b.day ?? '') ||
        a.page.localeCompare(b.page) ||
        String(a.s.summary ?? '').localeCompare(String(b.s.summary ?? '')) ||
        String(a.s.evidence ?? '').localeCompare(String(b.s.evidence ?? '')) ||
        String(a.s.sourceUrl ?? '').localeCompare(String(b.s.sourceUrl ?? '')) ||
        a.s.signalType.localeCompare(b.s.signalType),
    )
  const groups: Prepared[][] = []
  for (const s of cands) {
    // never into a group that holds a copy naming a different fact (a generic copy must not bridge two specific ones)
    const home = groups.find((g) => !g.some((m) => conflicts(s, m)) && g.some((m) => samePage(s, m) || sameStory(s, m)))
    if (home) home.push(s)
    else groups.push([s])
  }
  const losers = new Set<ObservedSignal>()
  for (const g of groups) {
    if (g.length < 2) continue
    const best = [...g].sort(
      (a, b) =>
        (b.s.sourceUrl ? 1 : 0) - (a.s.sourceUrl ? 1 : 0) || // an event that can be checked beats one that cannot
        (CONFIDENCE_RANK[b.s.confidence] ?? 0) - (CONFIDENCE_RANK[a.s.confidence] ?? 0) ||
        (a.day ?? '9999').localeCompare(b.day ?? '9999') || // then the earliest: the original, not its republication
        (FRESHNESS_RANK[b.s.freshness] ?? 0) - (FRESHNESS_RANK[a.s.freshness] ?? 0) ||
        String(b.s.evidence ?? '').length - String(a.s.evidence ?? '').length ||
        String(a.s.summary ?? '').localeCompare(String(b.s.summary ?? '')) || // last: a fixed order, so the same signals always give the same score and listing
        String(a.s.sourceUrl ?? '').localeCompare(String(b.s.sourceUrl ?? '')) ||
        a.s.signalType.localeCompare(b.s.signalType),
    )[0]!
    for (const m of g) if (m !== best) losers.add(m.s)
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
  let fitFromPlatformChanges = 0 // platform detections are the same kind of fact however many times they are recorded: one block of points
  // The types promise text and an address; a malformed signal must not crash the whole evaluation, so it is made well-formed first.
  const deepSignals = input.deep.signals.map((s) => ({ ...s, summary: String(s.summary ?? ''), evidence: String(s.evidence ?? ''), sourceUrl: typeof s.sourceUrl === 'string' && s.sourceUrl ? s.sourceUrl : null }))
  const sameEvent = duplicateEvents(deepSignals)
  // A fixed order, strongest evidence first, so the 60-point cap always goes to the same signals whatever order they arrive in.
  const ordered = [...deepSignals].sort(
    (a, b) =>
      (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0) ||
      (FRESHNESS_RANK[b.freshness] ?? 0) - (FRESHNESS_RANK[a.freshness] ?? 0) ||
      (iso(a.observedAt) ?? '9999').localeCompare(iso(b.observedAt) ?? '9999') ||
      (a.sourceUrl ?? '').localeCompare(b.sourceUrl ?? '') ||
      String(a.summary ?? '').localeCompare(String(b.summary ?? '')) ||
      String(a.evidence ?? '').localeCompare(String(b.evidence ?? '')) ||
      a.signalType.localeCompare(b.signalType),
  )
  for (const s of ordered) {
    if (s.signalCategory === 'crm') continue // already counted from the CRM read above
    if (s.status !== 'active') continue // weak or expired evidence is not counted
    // The proof of a detected platform is a raw fragment of the page's markup (it can even hold a public
    // storefront token): kept in the Marketing agent's own records, never copied into the CRM.
    const base = { evidence: s.signalCategory === 'technology' ? null : s.evidence || null, sourceUrl: s.sourceUrl, observedAt: iso(s.observedAt), freshness: s.freshness, source: 'web_research' as const }
    if (s.signalType === 'technology_added' && s.polarity === 'positive') {
      // A platform CHANGE is still a platform detection: it carries its points but never qualifies a company as
      // warm or an early signal on its own (2026-10-31 decision) — it is not added to `verified`.
      // Repeated or re-found platform detections must not stack: the same fit counted again is duplicate evidence.
      const pts = Math.max(0, Math.min(POINTS.technologyAdded, POINTS.technologyAdded - fitFromPlatformChanges))
      fitFromPlatformChanges += pts
      add({
        signal: s.signalType,
        polarity: 'positive',
        points: pts,
        summary: `${s.summary} (platform detection: fit, not a qualifying intent signal${pts ? '' : '; fit points were already counted'})`,
        ...base,
      })
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
      add({ signal: s.signalType, polarity: s.polarity === 'negative' ? 'negative' : 'positive', points: 0, summary: `${s.summary} (the same event as another signal: counted once)`, ...base })
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

  // Buying intent and permission to contact are different things (decision of 2026-11-05). A person who asked not to be contacted, or
  // said no, is not interest - but the company can still have independent buying signals (news, a platform change, other contacts).
  // Such a company is not hidden and is not offered as a lead: a person decides. It is never listed as Warm or Early Signal, so it
  // is not sent to NXT Sales as actionable (a company already sent is withdrawn).
  const refusal = input.crm.signals.find((s) => COMPANY_LEVEL_REFUSALS.has(s.signalType))
  if (refusal && (classification === 'warm' || classification === 'early_signal')) {
    const was = classification === 'warm' ? 'Warm' : 'an Early Signal'
    // A persisted contact opt-out outranks a newer friendly reply: only a person lifts it.
    const optedOut = input.crm.signals.some((s) => s.signalType === 'contact_opt_out')
    const what =
      refusal.signalType === 'reply_opt_out'
        ? 'its newest reply asked not to be contacted'
        : optedOut
          ? 'a contact has opted out of marketing email (a later reply, enquiry or acknowledgement does not lift that; only a person can)'
          : 'its newest reply said they are not interested'
    classification = 'human_review'
    summary = `Human review required: the company's own signals would make it ${was} (score ${score}), but ${what}. It is not listed as an actionable lead, and nothing is sent to NXT Sales for it, until a person decides.`
  }

  let confidence: Confidence
  if (classification === 'human_review') {
    confidence = 'medium'
  } else if (classification === 'warm') {
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
