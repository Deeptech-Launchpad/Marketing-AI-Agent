import { ACTIVITY_UNREAD_MARKER, type CrmActivity } from '../crm/types.js'
import { RECENT_ACTIVITY_DAYS } from '../intent/providers/crmProvider.js'
import type { ObservedSignal } from './score.js'

// WARM LEADS — what counts as a reply (2026-10-31, text added 2026-11-05, reworked after the PR #10 review and a second review of
// the rework). Pure: no I/O.
//
// NXT Sales files every message that comes IN to a mailbox as an inbound email, including the mail system's own: delivery
// failures, out-of-office notices, automatic replies. The first 30-company test called AWFS "warm: replied in the last 90 days" on
// the strength of "Delivery Status Notification (Failure)" — the bounce of OUR email, the opposite of interest. A reply is a
// message a person wrote. Automated mail is listed so it can be seen, and counts for nothing.
//
// And a reply is not always interest: "please unsubscribe us" is a message a person wrote. So the subject is read, and so is what
// the person wrote in the message itself (the text NXT Sales already returns with each email on the authorised /api/activities
// read). A reply whose text is not available, or that holds nothing of the person's own words, is "unverified" and never counts
// as interest. The text is read in memory and is NEVER stored: what is kept is the KIND of the answer (opt-out, not interested,
// ...) and the date, never the customer's wording and not even the subject.
//
// Two different things are kept apart (decision of 2026-11-05):
//   buying intent        a refusal is never intent;
//   permission to contact an opt-out (unsubscribe, stop, do not email) is a statement about contact, not about the market - a
//                        company that opted out can still have independent company-level buying signals, so it is not hidden: it
//                        goes to HUMAN REVIEW (score.ts), never listed as an actionable Warm Lead without a person's approval.
// A rejection of ONE product ("not interested in crates") is neither: it is not interest in that product, and says nothing about
// the others.
//
// Phrase matching can miss a refusal. The direction of every doubt is "not interest": a message that cannot be read with
// confidence is `unverified`, never `interested`.

/** Subjects that automated mail carries: bounces, out-of-office, auto-replies, no-reply senders. */
const AUTOMATED_SUBJECT = new RegExp(
  [
    'delivery status notification',
    '\\bundeliverable\\b',
    '\\bundelivered mail\\b',
    'delivery (has )?failed',
    'delivery failure',
    'mail delivery (subsystem|failed|failure)',
    'returned mail',
    'mail system error',
    'failure notice',
    'message (not delivered|blocked|rejected)',
    'could not be delivered',
    '^\\s*(automatic|auto)[ -]?reply',
    '^\\s*auto[- ]?response',
    '^\\s*autoreply',
    'out of (the )?office',
    '^\\s*ooo\\b',
    'away from (my )?(desk|office|email)',
    '\\bon (annual )?(leave|vacation|holiday)\\b',
    '\\bno-?reply\\b',
    'do not reply',
    'read receipt',
    // NOT calendar answers ("Accepted: ..."): a person accepting a meeting is engagement.
  ].join('|'),
  'i',
)

export function isAutomatedEmail(subject: string | null | undefined): boolean {
  return AUTOMATED_SUBJECT.test(subject ?? '')
}

/**
 * What an auto-responder or a mail system says in its text (an out-of-office under an ordinary "Re:" subject, a ticket
 * acknowledgement, a bounce body). Applied only to a short message, and only when the message neither refuses nor asks for anything:
 * "Please remove me from your list. I am travelling till Monday." is a person's reply.
 */
const AUTOMATED_TEXT = new RegExp(
  [
    'out of (?:the )?office',
    'not in the office',
    'automatic(?:ally)?[ -]?(?:reply|response|generated)',
    'auto[- ]?(?:reply|response|generated)',
    'this is an? (?:automated|system[- ]generated)',
    'system[- ]generated',
    'limited access to (?:my )?(?:e-?mail|email)',
    'not (?:be )?(?:checking|monitoring|reading|able to (?:check|access|respond))[^.!?\\n]{0,20}(?:e-?mail|messages)',
    'on leave until',
    'vacation (?:reply|responder|message)',
    'mailbox (?:is )?(?:full|unmonitored|not monitored|unavailable)',
    'do not reply to this (?:e-?mail|message)',
    'ticket (?:number|no|id|#)',
    'we have received your (?:e-?mail|message|request|enquiry|inquiry)',
    'will (?:get back|respond|reply|revert)[^.!?\\n]{0,20}(?:within|shortly|soon|as soon|on my return)',
    'office (?:will remain|is|will be) closed',
    'closed (?:from|for|on) ',
    'season(?:\'?s)? greetings|happy (?:diwali|new year|holi|eid|christmas)',
    'could not be delivered',
    'address not found',
    'does not exist',
    'courtesy email',
    'you are receiving this courtesy',
  ].join('|'),
  'i',
)
const AUTOMATED_TEXT_MAX = 700

/** What the mail system says about a meeting invitation answered "no". */
const MEETING_DECLINED_SUBJECT = /^\s*(?:declined|canceled|cancelled|refused|abgelehnt|abgesagt|refuse|annule|declinado|cancelado)\s*:/i
const MEETING_DECLINED_TEXT = /\b(?:has\s+declined\s+this\s+(?:invitation|meeting|event)|this\s+(?:meeting|event|invitation)\s+(?:has\s+been|was)\s+(?:cancell?ed|declined)|declined\s+this\s+(?:invitation|meeting))\b/i

// ── What a refusal looks like ──────────────────────────────────────────────────────────────────────────────────────────────────
// Matched on folded text (lower case, accents and invisible characters removed, look-alike letters and emphasis marks undone,
// quotes plain). Kinds, which score.ts treats differently:
//   opt_out          a request about CONTACT: unsubscribe, stop, remove me, do not email. Never softened by a "but".
//   not_interested   "no": not interested, not required, no requirement, we will pass, not at this time. A "but we do need ..."
//                    after it turns the message back into interest ("Not interested in crates, but we do need pallets").
//   product_specific "not interested in <one product>": not interest in that product, nothing more.
//   wrong_contact    "wrong person": not interest, and the company is not refused.
export type RefusalKind = 'opt_out' | 'not_interested' | 'product_specific' | 'wrong_contact' | 'meeting_declined'

/** What can follow "not interested in" without naming ONE product: the sender, the offer, or the whole business relationship. */
const GENERIC_AFTER_IN =
  '(?:your|our|this|that|these|those|the|any|anything|further|more|receiving|buying|purchasing|it|them|you|us|such|what|all|dealing|doing|working|business|cold|marketing|unsolicited|e-?mails?|mails?|offers?|proposals?|services?|solutions?|collaborations?|partnerships?|cooperation|discussions?|talks?|meetings?|calls?)'

// A "remove / delete" request needs a list, an address or a contact to act on; "drop me an email" and "take us through" are not requests to stop.
const OPT_OUT: RegExp[] = [
  /\bun-?subscri(?:be|bed|bing|ption)\b(?!\s+from\s+(?:our|the|a)\s+(?:old|previous|former|current)\b)/,
  /\bopt[- ]?(?:out|ing out)\b(?!\s+of\s+(?:our|the)\s+(?:current|existing|old)\b)/,
  /\b(?:remove|delete|erase)\s+(?:me|us)\b/,
  /\b(?:remove|delete|erase)\s+(?:(?:my|our|this|that|the)\s+)?(?:e-?mail(?:\s+(?:id|address))?|id|name|number|address|details|contacts?|company|firm|organi[sz]ation)\b[^.!?\n]{0,40}?\b(?:from|off)\b[^.!?\n]{0,20}\b(?:list|lists|database|mailing|contacts?|records?|system)\b/,
  /\b(?:remove|delete|erase)\s+(?:my|our)\s+(?:e-?mail(?:\s+(?:id|address))?|id|name|number|address|details|contacts?|company|firm|organi[sz]ation)\b/,
  /\btake\s+(?:me|us|my\s+name|our\s+name)\s+off\b/,
  /\bstop\s+(?:(?:e-?)?mail(?:ing|s)?\b|sending\s+(?:me|us|these|this|the|any|more|further|e-?mails?|mails?|messages?|spam|promotions?|marketing|offers?)\b|contacting\b|writing\s+(?:to\s+)?(?:me|us)\b|messaging\b|spamming\b|texting\b|(?:these|this|the|all|your|any|such|further|more)\s+(?:e-?mails?|mails?|messages?|spam|mailers?|promotions?|marketing|offers?)\b)/,
  /\b(?:do\s*not|don'?t|dont|never)\s+(?:e-?mail|contact|mail|spam|solicit)\b/,
  /\b(?:do\s*not|don'?t|dont|never)\s+(?:disturb|bother)\s+(?:me|us)\b/,
  /\b(?:do\s*not|don'?t|dont|never)\s+(?:send|write|message|text|reach|approach|ping|call|phone)\s+(?:me|us)\s+(?:any|more|further|another|anything|again|anymore|ever|e-?mails?|mails?|messages?|offers?|promotions?|marketing|spam)\b/,
  /\b(?:do\s*not|don'?t|dont|never)\s+(?:send|mail|e-?mail|write|call|phone)\s+(?:to\s+)?(?:me\s+|us\s+)?(?:again|anymore|any\s+more)\b/,
  /\b(?:do\s*not|don'?t|dont|never)\s+(?:send|mail|e-?mail|write)\s+(?:any\s+)?(?:e-?mails?|mails?|messages?|offers?|promotions?)\s+(?:to\s+)?(?:me|us|this\s+(?:address|id|e-?mail))\b/,
  /\b(?:do\s*not|don'?t|dont|never)\s+(?:send|mail|e-?mail)\s+(?:(?:me|us)\s+)?(?:any\s+)?(?:further|more|these|such|future|marketing|promotional|unsolicited)?\s*(?:e-?mails?|mails?|messages?|mailers?)\b/,
  /\brefrain\s+from\s+(?:contacting|e-?mailing|mailing|writing|calling|sending)\b/,
  /\bno\s+(?:more|further|future)\s+(?:e-?mails?|mails?|messages?|communications?|correspondence|promotions?|marketing|spam|follow[- ]?ups?|mailers?|offers?|contact)\b(?!\s+(?:required|needed|necessary|is\s+(?:required|needed)))/,
  /\b(?:this\s+is|it'?s|its|marking\s+(?:this\s+)?as|report(?:ed|ing)?\s+(?:you\s+|this\s+|it\s+)?as)\s+spam\b|\bwhy\s+(?:do|are)\s+you\s+(?:spam|spamming)\b|\bthis\s+is\s+harassment\b/,
  /\b(?:black-?list(?:ed)?\s+(?:you|your|this|the\s+sender)|blocked?\s+(?:you|your|this)|blocking\s+(?:you|your)|ndnc|dnd\s+(?:list|registry)|do\s*not\s+(?:call|disturb)\s+(?:list|registry))\b/,
  /\b(?:do\s*not|don'?t|dont|no\s+longer|not)\s+(?:wish|want|like|care)\s+to\s+(?:receive|get|hear|be\s+(?:contacted|e-?mailed|mailed|disturbed|solicited))\b/,
  /\b(?:do\s*not|don'?t|dont)\s+want\s+(?:any|these|your|such|further|more)\s+(?:e-?mails?|mails?|messages?|offers?|promotions?|communications?|calls?)\b/,
  /\b(?:discontinue|cease)\b[^.!?\n]{0,30}\b(?:e-?mails?|mails?|communications?|contact|messages?)\b/,
  // other languages that reach an Indian B2B mailbox
  /\b(?:desabonn\w*|desinscri\w*|ne\s+(?:nous\s+|me\s+)?(?:contactez|envoyez|ecrivez)\s+plus|arretez\s+(?:de\s+)?(?:nous\s+)?(?:envoyer|ecrire|contacter))\b/,
  /\b(?:abbestell\w*|austragen|aus\s+(?:dem|ihrem|ihren)\s+verteiler|keine\s+(?:weiteren\s+)?(?:e-?mails?|werbung|nachrichten|mails)|nicht\s+mehr\s+(?:kontaktier\w+|anschreiben|anrufen))\b/,
  /\b(?:non\s+(?:ci\s+)?(?:inviar\w*|scriver\w*|contattar\w*)|cancellat\w+\s+(?:ci\s+)?dalla\s+lista|disiscri\w+)\b/,
  /\b(?:darse?\s+de\s+baja|darme\s+de\s+baja|darnos\s+de\s+baja|dar\s+de\s+baja|dense\s+de\s+baja|no\s+(?:me\s+|nos\s+)?(?:contacten|escriban|envien|manden)|dejen?\s+de\s+(?:enviar|escribir|contactar)|elimin\w+\s+(?:nos|me)\s+de)\b/,
  /\b(?:cancelar\s+(?:a\s+)?inscricao|nao\s+(?:nos\s+|me\s+)?(?:envie|enviem|contate|contatem|escreva)\w*)\b/,
  /\b(?:mail|email|message|msg|sms|call)\s+(?:mat|na)\s+(?:kar\w*|bhej\w*)\b/,
  /\b(?:mat|na)\s+bhej\w*\b/,
  /\bbhejna\s+band\b/,
  /\b(?:mails?|e-?mails?)\b[^.!?\n]{0,25}\bband\b/,
  /\b(?:list|database)\s+se\s+(?:hata|nikal)\w*\b/,
  /\bhata\s*(?:do|dijiye|iye|en)\b/,
  // Devanagari (Hindi): "please do not send email", "not interested", "remove from the list"
  /(?:ईमेल|मेल)\s*(?:भेजना|भेजने|करना|करने)\s*बंद|ईमेल\s*(?:न|मत)\s*भेज|मेल\s*(?:न|मत)\s*भेज|सूची\s*से\s*(?:हटा|निकाल)|अनसब्सक्राइब/u,
]
/** Whole-message commands: only when that is ALL the person wrote ("STOP", "Remove"). */
const OPT_OUT_BARE = /^(?:(?:please|pls|kindly)\s+)*(?:stop|remove|unsubscribe|delete|cancel|block|opt\s*out)(?:\s+(?:me|us|e-?mails?|mails?|it|this|now))?[\s.!,]*$/

const NOT_INTERESTED: RegExp[] = [
  new RegExp(`\\b(?:not|no\\s+longer|never|nt)\\s+(?:really\\s+|currently\\s+|at\\s+all\\s+|that\\s+)?(?:interested|intrested|intersted|interasted|interestd)\\b(?!\\s+in\\s+(?!${GENERIC_AFTER_IN}\\b))`),
  /\b(?:no|zero|nil)\s+(?:further\s+|current\s+|immediate\s+)?(?:interest|requirements?|requirment)\b/,
  /\bno\s+(?:immediate\s+|current\s+)?need\s+(?:(?:of|for)\s+(?:this|it|your|any|these|such|packaging|the\s+product)|at\s+present|at\s+the\s+moment|currently|now)\b/,
  /^\s*no\s+need\b[^.!?\n]{0,8}$/,
  /\b(?:not|no\s+longer)\s+(?:looking|in\s+the\s+market|in\s+need|needed|required|necessary|applicable|relevant|suitable|a\s+(?:good\s+)?fit|an?\s+option|a\s+priority)\b/,
  /\b(?:do\s*not|don'?t|dont|does\s*not|doesn'?t|did\s*not|didn'?t|won'?t|will\s+not|wont)\s+(?:currently\s+|really\s+|presently\s+)?(?:need|require|want|buy|purchase|order|have\s+(?:any\s+)?(?:requirement|need|use))\b/,
  /\bno,?\s+thank(?:s|\s+you)\b/,
  /\b(?:this|it)\s+(?:is|isn'?t)\s+not\s+(?:for|meant\s+for|suitable\s+for|relevant\s+(?:for|to))\s+(?:us|me|our)\b|\bnot\s+for\s+us\b/,
  /\b(?:we|i)(?:'ll|\s+will|\s+would)?\s+(?:have\s+to\s+|need\s+to\s+|must\s+)?(?:pass|decline)\b/,
  /\bpass(?:ing)?\s+on\s+(?:this|that|it|the|your)\b/,
  /\b(?:declin(?:e|ed|ing)\s+(?:the|your|this)|unable\s+to\s+(?:proceed|take\s+up|consider|accept)|cannot\s+proceed|can'?t\s+proceed|not\s+(?:possible|able)\s+to\s+proceed|not\s+in\s+a\s+position\s+to)\b/,
  /\bwe\s+regret\s+to\s+inform\b/,
  /\bnot\s+(?:at\s+(?:this|the)\s+(?:time|moment)|at\s+present|right\s+now|for\s+now|this\s+time)\b|\bnot\s+now\s*(?:[,.!]|$|thanks)/,
  /\b(?:maybe|perhaps)\s+(?:later|some\s+other\s+time|next\s+(?:year|quarter|month))\b/,
  /\bsome\s+other\s+time\b/,
  /\bno\s+(?:scope|budget|plans?)\b/,
  /\balready\s+(?:have|has|having|using|working\s+with)\s+(?:a|an|our|the|enough|sufficient)?\s*(?:supplier|vendor|partner|provider|solution|system|arrangement|source)s?\b/,
  /\b(?:satisfied|happy|comfortable)\s+with\s+(?:our|the|my)\s+(?:current|present|existing|regular)\b/,
  /\bwill\s+not\s+be\s+(?:changing|switching|needing)\b/,
  /\bnot\s+(?:the\s+)?(?:right|ideal|best)\s+(?:time|moment)\b/,
  /\b(?:pas\s+interesse[es]?|ne\s+sommes\s+pas\s+interesse\w*|aucun\s+interet|pas\s+besoin)\b/,
  /\b(?:kein\s+interesse|nicht\s+interessiert|kein\s+bedarf)\b/,
  /\b(?:no\s+(?:estamos\s+|estoy\s+)?interesad[oa]s?|no\s+nos\s+interesa|no\s+(?:tenemos\s+)?(?:interes|necesidad))\b/,
  /\b(?:nao\s+(?:temos|tenho)\s+interesse|nao\s+(?:estamos|estou)\s+interessad[oa]s?|sem\s+interesse)\b/,
  /\bnahi\s+chahiye\b/,
  /\b(?:zaroorat|zarurat|jarurat|jaroorat|zaruri)\s+nahi(?:n)?\b/,
  /\b(?:interest|interested|ruchi|dilchaspi)\s+nahi(?:n)?\b/,
  /\bnahi\s+(?:lena|leni|chahte|chahta|chahti)\b/,
  /\bkoi\s+(?:zaroorat|requirement|need)\s+nahi\b/,
  /जरूरत\s*नहीं|ज़रूरत\s*नहीं|दिलचस्पी\s*नहीं|रुचि\s*नहीं|नहीं\s*चाहिए/u,
]
const NOT_INTERESTED_BARE = /^(?:no|nope|nah|pass|no\s+need|no\s+requirement|not\s+(?:required|needed|interested|now|applicable)|no\s+thanks?|no\s+thank\s+you|n\/?a)[\s.!,]*$/

const PRODUCT_SPECIFIC = new RegExp(`\\bnot\\s+(?:really\\s+|currently\\s+)?interested\\s+in\\s+(?!${GENERIC_AFTER_IN}\\b)[a-z0-9]`)

// Only a person who is no longer at the company, not "has left for the day" or "no longer working with Acme, please quote".
const WRONG_CONTACT: RegExp[] = [
  /\bwrong\s+(?:person|contact|company|address|e-?mail|number|department)\b/,
  /\bnot\s+the\s+(?:right|correct|concerned|relevant|responsible)\s+(?:person|contact|authority|department)\b/,
  /\b(?:i\s+am|i'?m)\s+not\s+(?:the\s+)?(?:right|correct|concerned|relevant|responsible)\s+(?:person|contact|one)\b/,
  /\bno\s+longer\s+(?:with\s+(?:this|the|our)\s+(?:company|organi[sz]ation|firm)|work(?:s|ing)?\s+(?:at|for|here|with\s+us)|employed\s+(?:at|by|with)\s+(?:this|the|our|us))\b/,
  /\b(?:has|have)\s+(?:left|resigned\s+from)\s+(?:the|this|our)\s+(?:company|organi[sz]ation|firm)\b/,
  /\bleft\s+the\s+(?:company|organi[sz]ation|firm)\b/,
]

/** Letters that look like Latin ones (Cyrillic, Greek): a spelled-out refusal in look-alike letters is still a refusal. */
const HOMOGLYPHS: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', ο: 'o', α: 'a', ε: 'e', ι: 'i', ν: 'v', τ: 't', κ: 'k', ρ: 'p' }

/**
 * Text folded for matching: accents (Latin marks only) and invisible characters removed, look-alike letters mapped, emphasis marks
 * (*bold*, _italic_) dropped, plain quotes, lower case.
 */
const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[\p{Cf}]/gu, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .replace(/[асеорхіјѕԁɡοαειντκρ]/g, (c) => HOMOGLYPHS[c] ?? c)

/** What the person is ASKING for: used to tell "not interested in crates. We do need pallets, please quote" from a refusal. */
const REQUEST =
  /\bplease\s+(?:send|share|quote|call|confirm|e-?mail|provide|revert)\b(?!\s+(?:me\s+|us\s+)?(?:nothing|no\s+more|any\s+more|further|anything))|\bwe\s+(?:do\s+)?(?:need|want|require)\s+(?!you\b|to\s+(?:stop|be)\b|no\b)|\bwe\s+are\s+(?:looking\s+for|keen)\b|\b(?:send|share)\s+(?:me|us|the|a|an|your)\s+(?:quote|quotation|price|pricing|rates?|catalog(?:ue)?|brochure|proposal|details|samples?)\b|\b(?:i|we)\s+am?\s+keen\b|\bquote\s+for\b|\bquotation\s+for\b|\bcall\s+(?:me|us)\b|\bcontact\s+(?:me|us)\b|\be-?mail\s+(?:me|us)\b/
/** The requests that turn a refusal round even without a "but": asking for a quote, a price, a confirmation; "we do need ...". NOT "call me". */
const REQUEST_COMMERCIAL =
  /\bplease\s+(?:send|share|quote|confirm)\b(?!\s+(?:me\s+|us\s+)?(?:nothing|no\s+more|any\s+more|further|anything))|\bwe\s+(?:do\s+)?(?:need|want|require)\s+(?!you\b|to\s+(?:stop|be)\b|no\b)|\bwe\s+are\s+(?:looking\s+for|keen)\b|\b(?:send|share)\s+(?:me|us|the|a|an|your)\s+(?:quote|quotation|price|pricing|rates?|catalog(?:ue)?|brochure|proposal)\b|\bquote\s+for\b|\bquotation\s+for\b/
const TURN = /\b(?:but|however|though|although|except|yet|only|just|still|lekin|magar|parantu|kintu)\b/
/** What follows a turn word and shows the person wants something (imperatives and "we need", not the nouns of the mail). */
const INTEREST_CUE =
  /\b(?:please\s+(?:send|share|quote|call|confirm|e-?mail|provide|revert)|(?:send|share)\s+(?:me|us|the|a|an|your)\b|we\s+(?:do\s+)?(?:need|want|require)\b|looking\s+for|interested\s+in|keen|quote\s+for|quotation\s+for|call\s+(?:me|us)|contact\s+(?:me|us)|e-?mail\s+(?:me|us)|chahiye|bhejiye)\b/g

/** Whether the words after a refusal turn it round ("not interested in crates, but we do need pallets"). */
function turnedRound(text: string, matchEnd: number): boolean {
  const tail = text.slice(matchEnd, matchEnd + 260)
  const negatedBefore = (at: number) => /(?:\bnot|\bno|n't|\bnever)\s+(?:\w+\s+)?$/.test(tail.slice(Math.max(0, at - 14), at))
  const turn = TURN.exec(tail)
  if (turn) {
    const after = tail.slice(turn.index + turn[0].length)
    for (const m of after.matchAll(INTEREST_CUE)) if (!negatedBefore(turn.index + turn[0].length + (m.index ?? 0))) return true
  }
  // a plain request in the next sentences, with no turn word: "Not interested in crates. We do need pallets, please quote."
  return REQUEST_COMMERCIAL.test(tail)
}

/** Handing a message on is not declining it: "I will pass this on to our purchase manager". */
const FORWARDING = /\bpass(?:ed|ing)?\s+(?:on\s+)?(?:(?:this|it|that|them|these|those|your|my|the|our)\s+)?(?:\w+\s+){0,2}?(?:to|on\s+to)\s+(?:our|my|the|his|her|them|him|someone|concerned)\b|\bpass(?:ed|ing)?\s+on\s+(?:the|your|this)\s+(?:details?|information|info|quote|quotation|request|enquiry|inquiry|mail|e-?mail|message|proposal)\b/g

/** The kind of refusal in a text, or null. `bare` is the person's words with greetings and sign-offs taken away. */
function refusalKindIn(own: string, bare: string): RefusalKind | null {
  const t = fold(own).replace(FORWARDING, ' ')
  const b = fold(bare).replace(/\s+/g, ' ').trim()
  if (OPT_OUT.some((re) => re.test(t)) || OPT_OUT_BARE.test(b)) return 'opt_out'
  const strong = (res: RegExp[]) => {
    for (const re of res) {
      for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('u') ? 'gu' : 'g'))) if (!turnedRound(t, (m.index ?? 0) + m[0].length)) return true
    }
    return false
  }
  if (strong(NOT_INTERESTED) || NOT_INTERESTED_BARE.test(b)) return 'not_interested'
  const wrong = WRONG_CONTACT.map((re) => re.exec(t)).find((m) => m !== null)
  if (wrong && !turnedRound(t, wrong.index + wrong[0].length)) return 'wrong_contact'
  const product = PRODUCT_SPECIFIC.exec(t)
  if (product) {
    // asked for something else, before OR after the rejection: demand for another product is not ruled out
    const rest = t.slice(0, product.index) + ' ' + t.slice(product.index + product[0].length)
    if (!REQUEST.test(rest) && !turnedRound(t, product.index + product[0].length)) return 'product_specific'
  }
  return null
}

// ── What the person wrote ──────────────────────────────────────────────────────────────────────────────────────────────────────
// NXT Sales gives the text with its line breaks (mappers.ts keeps them), so a quoted line is recognised by where it STARTS: a ">"
// inside a sentence ("Quantity > 500") is not a quote, and a dash or "with regards," inside a sentence is not a signature.

/** Where the quoted earlier messages begin when nothing marks them line by line. Everything from here on is quoted. */
const HARD_QUOTE: RegExp[] = [
  /(?<!-)-{2,}\s*(?:original message|forwarded message|reply above this line|ursprungliche nachricht|message d'origine|mensaje original|mensagem original)\s*-{2,}/i,
  /(?<!-)-{2,}\s*on\s[^\n]{0,200}\bwrote\s*-{2,}/i, // Zoho: "---- On Tue, 03 Nov 2026 ... wrote ----"
  /(?:^|\n)[ \t]*_{5,}/,
  /(?:^|\n)[ \t]*(?:from|de|von|da)[ \t]*:[^\n]{0,200}\n(?:[^\n]{0,200}\n){0,4}?[ \t]*(?:sent|date|envoy[eé]|gesendet|enviado|inviato|data)[ \t]*:/i,
]
/** The same Outlook block when the text has lost its line breaks (also tried when it has them: the header may be on one line). */
const COLLAPSED_QUOTE = /\bfrom\s*:[^\n]{0,200}?\b(?:sent|date)\s*:\s*\S/i
/** "Sales <s@w.com> wrote:" when the text has lost its line breaks (cut where the name starts). */
const COLLAPSED_ATTRIBUTION = /[^\n.!?]{0,80}<[^<>\s@]+@[^<>\s]+>\s*(?:wrote|a [eé]crit|schrieb|escribi[oó]|escreveu|ha scritto)\s*:/i
/** "On Tue, 3 Nov 2026 at 10:15, Sales <s@w.com> wrote:" — in the middle of a line, anchored on the date. */
const ATTRIBUTION_DATED = /\b(?:on|le|am|el|em|il|op)\s+(?:(?:mon|tue|wed|thu|fri|sat|sun|lun|mar|mer|jeu|ven|sam|dim)\b|\d{1,2}[\s/.-]|(?:jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec)\b)[^]{0,200}?\b(?:wrote|a [eé]crit|schrieb|escribi[oó]|escreveu|ha scritto)\s*:/i
/** A line that ends in ":" and carries an address, a year or a time, directly above a ">"-quoted line ("Am 03.11.2026 um 10:15 schrieb Sales <s@w.com>:"). */
const ATTRIBUTION_STAMPED = /(?:^|\n)[ \t]*[^\n>][^\n]{0,200}?(?:@|\b(?:19|20)\d\d\b|\b\d{1,2}:\d{2}\b)[^\n]{0,120}:[ \t]*(?=\n(?:[ \t]*\n)*[ \t]*>)/
/** A single line that ends with "<someone> wrote:". It never reaches back to the line before (that is the person's own last line). */
const ATTRIBUTION_LINE = /(?:^|\n)[ \t]*[^\n]{0,160}\b(?:wrote|a [eé]crit|schrieb|escribi[oó]|escreveu|ha scritto)[ \t]*:[ \t]*(?=\n|$)/i

/** A signature delimiter or a mail app's standard line: only when it is a line of its own. */
const SIGNATURE_LINE =
  /(?:^|\n)[ \t]*(?:--[ \t]*(?=\n|$)|sent from my (?:\w+[ -]){0,2}(?:iphone|ipad|android|galaxy|samsung|mobile|phone|device|tablet|blackberry|smartphone|pixel|oneplus|xiaomi|redmi|oppo|vivo|huawei)\b|sent from (?:outlook|mail|yahoo|gmail|samsung|my\s+\w+\s+(?:mobile|phone))\b|sent via (?:outlook|gmail|yahoo|mail)\b|sent using (?:outlook|gmail|yahoo|mail)\b|get outlook for\b)/i
/** Footers, wherever they are: a legal disclaimer, a mailing-list footer. NOT "regards" or a dash inside a sentence. */
const FOOTER = /\b(?:confidentiality notice|disclaimer\s*:|this\s+(?:e-?mail|message)(?:\s+and\s+any\s+attachments)?\s+(?:is\s+(?:intended|confidential)|may\s+contain|contains\s+confidential)|if\s+you\s+are\s+not\s+the\s+intended\s+recipient|(?:click|tap)\s+(?:here\s+)?to\s+unsubscribe|you\s+are\s+receiving\s+this\s+(?:e-?mail|message)\s+because|view\s+(?:this\s+(?:e-?mail|message)\s+)?in\s+(?:your\s+)?browser|manage\s+(?:your\s+)?(?:e-?mail\s+)?preferences)\b/i

/** Longest stretch of the person's words that is looked at (the mapper keeps at most this many, see ACTIVITY_BODY_MAX). */
const OWN_MAX = 6000

/**
 * What the person wrote in THIS message: the text without the quoted earlier messages, without the signature and without a
 * footer. Line breaks are kept. (A footer often says "unsubscribe" and a quoted copy of our own mail says things the person did
 * not; neither is theirs.)
 */
export function ownWords(text: string | null | undefined): string {
  // the mapper's "not read in full" marker is not the person's text: it is removed before anything is judged (see wasTruncated)
  let t = (text ?? '').split(ACTIVITY_UNREAD_MARKER).join('').replace(/\r\n?/g, '\n').slice(0, OWN_MAX)
  const hasLines = t.includes('\n')
  // 1. quoted blocks that carry no ">" prefix
  let cut = t.length
  for (const re of [...HARD_QUOTE, COLLAPSED_QUOTE, ...(hasLines ? [] : [COLLAPSED_ATTRIBUTION])]) {
    const m = re.exec(t)
    if (m && m.index < cut) cut = m.index
  }
  t = t.slice(0, cut)
  // 2. "... wrote:" — what follows is quoted, unless the quote is ">"-prefixed line by line (then the lines BETWEEN the quoted
  //    ones are the person's own answers, written inline)
  for (let i = 0; i < 12; i++) {
    const dated = ATTRIBUTION_DATED.exec(t)
    const line = hasLines ? (ATTRIBUTION_LINE.exec(t) ?? ATTRIBUTION_STAMPED.exec(t)) : null
    const lineAt = line ? line.index + (line[0].startsWith('\n') ? 1 : 0) : Infinity
    const m = dated && dated.index <= lineAt ? dated : line
    if (!m) break
    const at = m === dated ? m.index : lineAt
    const startsLine = at === 0 || t[at - 1] === '\n' || /^[ \t]*$/.test(t.slice(t.lastIndexOf('\n', at - 1) + 1, at))
    const rest = t.slice(m.index + m[0].length)
    const nextLine = rest.split('\n').find((l) => l.trim() !== '')
    if (startsLine && nextLine !== undefined && /^\s*>/.test(nextLine)) t = t.slice(0, at) + rest // interleaved: drop the header, keep going
    else {
      t = t.slice(0, at)
      break
    }
  }
  // 3. ">"-prefixed lines are quoted text
  t = t
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
  // 4. signature and footer (a "--" line only cuts when what follows is signature-sized)
  cut = t.length
  const sig = SIGNATURE_LINE.exec(t)
  if (sig && (!/^\s*--/.test(sig[0]) || t.length - sig.index <= 500) && sig.index < cut) cut = sig.index
  const foot = FOOTER.exec(t)
  if (foot && foot.index < cut) cut = foot.index
  return t.slice(0, cut).replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

const GREET = '(?:hi|hello|hey|dear|good\\s+(?:morning|afternoon|evening)|greetings|namaste|namaskar|respected)'
/** A greeting line: the greeting, a name or two, and then a comma / colon / "!" (or nothing at all). "Hi please send quote" is not one. */
const GREETING = new RegExp(`^${GREET}\\b(?:(?:\\s+[\\p{L}.'/]+){0,3}\\s*[,:!-])?$`, 'iu')
const GREETING_PREFIX = /^(?:hi|hello|hey|dear)\b(?:\s+[\p{L}.]+)?\s*[,:!-]\s*/iu
const GRATITUDE = /^(?:thanks|thank\s+you|thankyou|thx|ok|okay|noted|regards)\b[\s,.!-]*$/i
const SIGN_OFF = /^(?:(?:thanks|thank\s+you|thx)\s*(?:and|&|n)?\s*)?(?:(?:with|best|kind|warm|kindest|many|yours)\s+)*(?:regards|sincerely|cheers|rgds|regds|best\s+wishes|warm\s+wishes|faithfully|truly|best|br)\b[\s,.!-]*$/i
const SIGN_OFF_TAIL_MAX = 300

/** The substance of the person's words: greetings, thanks and a sign-off with its signature taken away. May be empty. */
export function substanceOf(own: string): string {
  const kept: string[] = []
  const lines = own.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (SIGN_OFF.test(l)) {
      const tail = lines.slice(i + 1).join(' ')
      if (tail.length <= SIGN_OFF_TAIL_MAX && !REQUEST.test(fold(tail))) break // the rest is the signature
      continue
    }
    if (GREETING.test(l) || GRATITUDE.test(l)) continue
    kept.push(l.replace(GREETING_PREFIX, ''))
  }
  return kept.join('\n').trim()
}

const AFFIRMATIVE = new Set(['yes', 'yeah', 'yep', 'sure', 'interested', 'ok', 'okay'])
/** A short reply is interest only if it asks for something or says yes: "Ok thanks" and "Noted" are acknowledgements. */
const POSITIVE_CUE = /\b(?:yes|yeah|sure|interested|please\s+(?:send|share|quote|call|e-?mail)|send|share|quote|quotation|price|pricing|rates?|details|catalog(?:ue)?|brochure|proposal|samples?|demo|meeting|call\s+(?:me|us)|contact\s+(?:me|us)|need|want|require|looking|talk|happy|glad|information|interesting|connect|reach\s+out|follow\s*up|proceed|let'?s|go\s+ahead|schedule|available|tomorrow|discuss|how\s+much|cost)\b/i
const NEGATION = /\b(?:not|no|dont|don't|never|won't|wont|cannot|can't|cant|nothing|nope)\b/
const SHORT_REPLY_WORDS = 6
/** A question about who we are or how we got the address is a complaint, not interest. */
const COMPLAINT = /\b(?:how\s+did\s+you\s+get|who\s+are\s+you|why\s+are\s+you\s+(?:mailing|e-?mailing|writing|contacting|sending)|who\s+gave\s+you|where\s+did\s+you\s+get)\b/

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length
}

/**
 * Lines that are all name / title / company / phone and nothing else: no sentence, no request. ("Raj Kumar\nPurchase Manager\nAcme
 * Industries Pvt Ltd\nMumbai", or "Raj Kumar | Purchase Manager | Acme".) A signature that no sign-off introduced.
 */
function looksLikeSignature(substance: string): boolean {
  const lines = substance.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  if (REQUEST.test(fold(substance)) || POSITIVE_CUE.test(substance)) return false
  if (lines.some((l) => (l.match(/\|/g) ?? []).length >= 2)) return true
  // short lines with no full stop, in which most words are capitalised (names, titles, company) or numbers
  const nameLike = (l: string) => {
    const words = l.match(/[\p{L}\p{N}][\p{L}\p{N}.&'-]*/gu) ?? []
    return words.length > 0 && words.filter((w) => /^\p{Lu}|\d/u.test(w)).length / words.length >= 0.6
  }
  return lines.every((l) => wordCount(l) <= 8 && !/[.!?]$/.test(l) && nameLike(l))
}

/**
 * The ONLY opt-outs that may ever be recorded on the suppression list automatically: an unambiguous, STANDALONE, individual
 * marketing opt-out - "UNSUBSCRIBE", "STOP", "REMOVE ME", "REMOVE ME FROM YOUR MAILING LIST", "DO NOT EMAIL ME", "PLEASE STOP SENDING ME
 * MARKETING EMAILS" - and nothing else in the message (greetings, thanks and a signature are not "something else"). Anything that also asks
 * for a quotation, product information or any other action, mentions another address, a colleague or "us", or is only in the subject or in
 * quoted text, is still an opt-out for the HUMAN-REVIEW hold - but a person decides what goes on the list.
 */
const PLEASE = '(?:(?:please|kindly|pls)\\s+)*'
const FROM_LIST = '(?:\\s+from\\s+(?:your|the|this)\\s+(?:mailing\\s+|e-?mail\\s+|marketing\\s+|distribution\\s+)?(?:list|lists|database|newsletters?|mails?|e-?mails?|communications?))?'
const STRICT_OPT_OUT: RegExp[] = [
  new RegExp(`^${PLEASE}unsubscribe(?:\\s+me)?${FROM_LIST}$`),
  new RegExp(`^${PLEASE}stop$`),
  new RegExp(`^${PLEASE}stop\\s+(?:sending|e-?mailing|mailing)\\s+me(?:\\s+(?:any\\s+)?(?:more\\s+|further\\s+)?(?:marketing\\s+|promotional\\s+)?(?:e-?mails?|mails?|messages?))?$`),
  new RegExp(`^${PLEASE}remove\\s+me${FROM_LIST}$`),
  new RegExp(`^${PLEASE}(?:do\\s*not|don'?t)\\s+(?:e-?mail|mail|contact)\\s+me(?:\\s+(?:again|anymore|any\\s+more))?$`),
  new RegExp(`^${PLEASE}(?:do\\s*not|don'?t)\\s+send\\s+me\\s+(?:any\\s+)?(?:more\\s+|further\\s+)?(?:marketing\\s+|promotional\\s+)?(?:e-?mails?|mails?|messages?)(?:\\s+again)?$`),
  new RegExp(`^${PLEASE}opt\\s*(?:me\\s+)?out$`),
]
const STRICT_MAX_CHARS = 160

/** Whether everything the person wrote (greetings, thanks and sign-off already taken away) is one or more standalone individual opt-out phrases. */
export function isStandaloneOptOut(substance: string): boolean {
  return standaloneOptOutPhrase(substance) !== null
}

/** The canonical names of the standard phrases, in the order of STRICT_OPT_OUT. These are OUR labels, never the person's words. */
const STRICT_LABELS = ['UNSUBSCRIBE', 'STOP', 'STOP SENDING ME EMAILS', 'REMOVE ME', 'DO NOT EMAIL ME', 'DO NOT SEND ME EMAILS', 'OPT OUT']

/**
 * Which standard phrase(s) the message consists of - as OUR canonical label(s), e.g. "UNSUBSCRIBE" - or null when it is not a standalone
 * opt-out. This is the exact reason a proposal was generated, shown to the administrator who approves it (no customer wording is kept).
 */
export function standaloneOptOutPhrase(substance: string): string | null {
  const t = fold(substance)
  if (t.length === 0 || t.length > STRICT_MAX_CHARS) return null
  const parts = t
    .split(/[\n.!;]+/)
    .map((p) => p.replace(/[\s,]+$/g, '').replace(/^[\s,]+/g, ''))
    .filter(Boolean)
  if (parts.length === 0) return null
  const labels = new Set<string>()
  for (const p of parts) {
    const i = STRICT_OPT_OUT.findIndex((re) => re.test(p.replace(/\s+/g, ' ')))
    if (i < 0) return null
    labels.add(STRICT_LABELS[i] ?? 'OPT-OUT')
  }
  return [...labels].join(' / ')
}

export type ReplyVerdict = 'interested' | 'declined' | 'unverified'
export interface ReplyAssessment {
  activity: CrmActivity
  verdict: ReplyVerdict
  /** The KIND of refusal when the verdict is "declined" (never the person's words). */
  kind: RefusalKind | null
  /** What the verdict rests on: the subject, the person's own words, or nothing readable. */
  basis: 'subject' | 'text' | 'no_text'
  /** The person's own words clearly and affirmatively ask to receive marketing mail again. Only ever a candidate for a person to review. */
  reconsent: boolean
  /** An unambiguous, standalone, individual marketing opt-out in the person's own words (not only the subject): the only kind recorded automatically. */
  strictOptOut: boolean
  /** When `strictOptOut`: the canonical label of the standard phrase it consists of ("UNSUBSCRIBE", "STOP", ...). Never the person's words. */
  strictPhrase: string | null
}

const CALENDAR_ANSWER = /^\s*(?:tentatively\s+)?accepted\b/i
const REPLY_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|sv|rv|tr)(?:\[\d+\])?\s*:\s*|\[[^\]]{1,20}\]\s*)+/i

/** The subject as the person left it: without "Re:" / "Fwd:" prefixes. */
const subjectOf = (a: CrmActivity): string => (a.subject ?? '').replace(REPLY_PREFIX, '').trim()

/**
 * A subject that asks to stop ("Unsubscribe", "Remove me", "STOP"). Always honoured, even when the message has a body. A subject that
 * is only a "no" ("Not interested") is judged like the text, because it is often OUR subject, left unchanged ("Re: Not looking for a
 * better supplier?").
 */
function subjectRefusal(a: CrmActivity, textUnavailable: boolean): RefusalKind | null {
  const s = subjectOf(a)
  if (!s) return null
  if (MEETING_DECLINED_SUBJECT.test(a.subject ?? '')) return 'meeting_declined'
  if (s.length > 100) return null
  const kind = refusalKindIn(s, s)
  if (kind === 'opt_out') return kind
  if (kind && textUnavailable && !s.endsWith('?')) return kind
  return null
}

/** The text of this message was cut before the person's actual reply could be fully read (see ACTIVITY_UNREAD_MARKER). */
export function wasTruncated(a: CrmActivity): boolean {
  return typeof a.body === 'string' && a.body.includes(ACTIVITY_UNREAD_MARKER)
}

/** Whether the message is mail-system output: by its subject, or - for a short message that neither refuses nor asks for anything - by what it says. */
export function isAutomatedMessage(a: CrmActivity): boolean {
  if (isAutomatedEmail(a.subject)) return true
  if (a.body === undefined || a.body === null) return false
  const own = ownWords(a.body)
  if (own.length === 0 || own.length > AUTOMATED_TEXT_MAX || !AUTOMATED_TEXT.test(own)) return false
  // a person who asks to be removed, or asks for something, is a person even if the message also says they are travelling
  return refusalKindIn(own, substanceOf(own)) === null && !REQUEST.test(fold(own))
}

/**
 * Whether one message a person wrote is a refusal, interest, or cannot be told.
 *   declined    the subject or the person's own words refuse (and `kind` says how)
 *   interested  the person's own words were read, say something, and refuse nothing (or a calendar invitation was accepted)
 *   unverified  the text was not available, held nothing of the person's own, or was too short or too bare to tell - never
 *               counted as interest
 * With `requireText` false and no text loaded (the test sample only needs to find replies) only the subject is read.
 */
function assessBase(a: CrmActivity, requireText: boolean): Omit<ReplyAssessment, 'reconsent' | 'strictOptOut' | 'strictPhrase'> {
  // A message that was not read in full may hold a refusal in the part that was cut off, so NOTHING positive is inferred from it: whatever would
  // have been "interested" is "unverified". A refusal found in the part that WAS read still counts (that can only make the company more careful).
  const truncated = wasTruncated(a)
  const done = (verdict: ReplyVerdict, kind: RefusalKind | null, basis: ReplyAssessment['basis']): Omit<ReplyAssessment, 'reconsent' | 'strictOptOut' | 'strictPhrase'> =>
    truncated && verdict === 'interested' ? { activity: a, verdict: 'unverified', kind: null, basis: 'no_text' } : { activity: a, verdict, kind, basis }
  const noBody = a.body === undefined || a.body === null
  const own = noBody ? '' : ownWords(a.body)
  const bySubject = subjectRefusal(a, noBody || own === '')
  if (bySubject) return done('declined', bySubject, 'subject')
  if (noBody) return requireText ? done('unverified', null, 'no_text') : done('interested', null, 'subject')
  if (MEETING_DECLINED_TEXT.test(own)) return done('declined', 'meeting_declined', 'text')
  const substance = substanceOf(own)
  const kind = refusalKindIn(own, substance)
  if (kind) return done('declined', kind, 'text')
  if (own.length > 0 && own.length <= AUTOMATED_TEXT_MAX && AUTOMATED_TEXT.test(own)) return done('unverified', null, 'no_text') // an auto-responder, not a person
  if (!substance) return CALENDAR_ANSWER.test(a.subject ?? '') ? done('interested', null, 'subject') : done('unverified', null, 'no_text')
  const words = wordCount(substance)
  if (words < 2 && !AFFIRMATIVE.has(fold(substance).replace(/[^a-z]/g, ''))) return done('unverified', null, 'no_text')
  if (looksLikeSignature(substance) || COMPLAINT.test(fold(substance))) return done('unverified', null, 'no_text')
  if (words <= SHORT_REPLY_WORDS && (!POSITIVE_CUE.test(fold(substance)) || (NEGATION.test(fold(substance)) && !REQUEST.test(fold(substance))))) return done('unverified', null, 'no_text')
  return done('interested', null, 'text')
}

/**
 * Clear, AFFIRMATIVE words asking to receive marketing mail (again): "please subscribe me", "add us back to your list", "we would like to
 * receive your newsletter", "keep me informed". An acknowledgement, a quote request or a product enquiry is NOT this. Matched only in a
 * message that refuses nothing.
 */
const RECONSENT: RegExp[] = [
  /\b(?:please\s+)?(?:re-?)?subscribe\s+(?:me|us)\b/,
  /\bre-?subscrib(?:e|ing)\b/,
  /\badd\s+(?:me|us)\s+(?:back\s+)?(?:to|on|onto)\s+(?:your|the)\s+(?:mailing\s+|e-?mail\s+|distribution\s+)?(?:list|newsletter|database)\b/,
  /\b(?:i|we)\s+(?:would\s+like|want|wish|'d\s+like)\s+to\s+(?:receive|get|hear)\s+(?:your\s+)?(?:e-?mails?|newsletters?|updates|offers|marketing|promotions?|news)\b/,
  /\bkeep\s+(?:me|us)\s+(?:informed|posted|updated|on\s+your\s+list)\b/,
  /\b(?:please\s+)?(?:continue|keep)\s+(?:sending|e-?mailing|mailing)\s+(?:me|us)\b/,
  /\bopt(?:ing)?\s*(?:me|us)?\s*back\s+in\b/,
]
export const affirmsMarketingConsent = (own: string): boolean => {
  const t = fold(own)
  return RECONSENT.some((re) => {
    const m = re.exec(t)
    // "please do NOT subscribe me" is the opposite
    return m !== null && !/(?:\bnot\b|n't|\bnever\b|\bno\b)[^.!?\n]{0,20}$/.test(t.slice(Math.max(0, m.index - 30), m.index))
  })
}

export function assessReply(a: CrmActivity, requireText: boolean): ReplyAssessment {
  const r = assessBase(a, requireText)
  const body = a.body === undefined || a.body === null ? '' : ownWords(a.body)
  // a message that was not read in full is never a STANDALONE opt-out (something unread may follow the phrase)
  const strictPhrase = r.verdict === 'declined' && r.kind === 'opt_out' && r.basis === 'text' && body !== '' && !wasTruncated(a) ? standaloneOptOutPhrase(substanceOf(body)) : null
  return { ...r, reconsent: r.verdict !== 'declined' && body !== '' && affirmsMarketingConsent(body), strictOptOut: strictPhrase !== null, strictPhrase }
}

/** How cautious a verdict is: when two messages carry the same time, the more cautious one decides. */
const SEVERITY = (x: ReplyAssessment): number => (x.verdict === 'declined' ? (x.kind === 'opt_out' ? 0 : 1) : x.verdict === 'unverified' ? 2 : 3)
const timeOf = (a: CrmActivity): number => {
  const t = new Date(a.createdAt).getTime()
  return Number.isFinite(t) ? t : -Infinity
}

export interface InboundSummary {
  /** Messages a person wrote that are interest (or cannot be told apart from interest without their text), newest first. */
  replies: CrmActivity[]
  /** Automated inbound mail inside the window (bounces, auto-replies, out-of-office). */
  automated: CrmActivity[]
  /** Messages a person wrote that refuse. */
  declined: CrmActivity[]
  /** Every message a person wrote inside the window, newest first. */
  written: CrmActivity[]
  /** The same messages, assessed, newest first; messages with the same time are ordered most cautious first. */
  assessed: ReplyAssessment[]
}

export function summariseInbound(activities: CrmActivity[], now: Date = new Date(), days: number = RECENT_ACTIVITY_DAYS, requireText = false): InboundSummary {
  const cutoff = now.getTime() - days * 86_400_000
  const inbound = activities.filter((a) => a.direction === 'inbound' && timeOf(a) >= cutoff)
  const automated = inbound.filter(isAutomatedMessage).sort((a, b) => timeOf(b) - timeOf(a))
  const assessed = inbound
    .filter((a) => !isAutomatedMessage(a))
    .map((a) => assessReply(a, requireText))
    .sort((x, y) => timeOf(y.activity) - timeOf(x.activity) || SEVERITY(x) - SEVERITY(y))
  return {
    replies: assessed.filter((x) => x.verdict === 'interested').map((x) => x.activity),
    automated,
    declined: assessed.filter((x) => x.verdict === 'declined').map((x) => x.activity),
    written: assessed.map((x) => x.activity),
    assessed,
  }
}

/** Whether a company has a real reply in the window (used to find them for the test sample). */
export const hasRecentReply = (activities: CrmActivity[], now?: Date): boolean => summariseInbound(activities, now).replies.length > 0

const SIGNAL_OF_KIND: Record<RefusalKind, string> = {
  opt_out: 'reply_opt_out',
  not_interested: 'reply_declined',
  product_specific: 'reply_declined_product',
  wrong_contact: 'reply_wrong_contact',
  meeting_declined: 'reply_declined_meeting',
}
export const REFUSAL_SIGNAL_TYPES: ReadonlySet<string> = new Set(Object.values(SIGNAL_OF_KIND))

const REFUSAL_TEXT: Record<RefusalKind, string> = {
  opt_out: 'asked not to be contacted (an unsubscribe, stop or do-not-email request) — not interest. Do not approach this person; add them to the suppression list before any outreach',
  not_interested: 'said they are not interested — not buying intent',
  product_specific: 'said they are not interested in one product — not counted as interest in it; their interest in other products is not ruled out',
  wrong_contact: 'said this is not the right person or address — not interest; find the right contact',
  meeting_declined: 'declined or cancelled a meeting — not interest',
}

/**
 * The engagement signal for an evaluation, from the emails themselves.
 * Replaces the CRM provider's own, which counts any inbound message.
 *
 * The NEWEST message a person wrote decides: a refusal after a friendly reply withdraws the interest; a friendly reply after a
 * refusal counts; two messages with the same time are decided by the more cautious. If the newest message cannot be read
 * (`requireText` and no text, or nothing of the person's own, or too short to tell) it is "unverified" - listed, scoring nothing,
 * never interest - even when an older message was friendly. And an opt-out is not erased by a LATER message that says nothing
 * ("Ok thanks", a bare signature): only a later message that is interest does that.
 *
 * Nothing the person wrote is kept: the signal records the KIND of answer and the date, never their words (not even the subject).
 */
export function engagementSignal(
  activities: CrmActivity[],
  now: Date = new Date(),
  days: number = RECENT_ACTIVITY_DAYS,
  freshDays: number = 30,
  opts: { requireText?: boolean } = {},
): ObservedSignal | null {
  const { automated, assessed } = summariseInbound(activities, now, days, opts.requireText === true)
  const base = { signalCategory: 'crm', confidence: 'high', freshness: 'unknown', status: 'active', sourceUrl: null }
  const on = (a: CrmActivity) => `Inbound email on ${a.createdAt.slice(0, 10)}`
  if (assessed.length) {
    let latest = assessed[0]!
    if (latest.verdict === 'unverified') {
      // an opt-out stands against later messages that say nothing; only interest after it removes it
      for (const x of assessed.slice(1)) {
        if (x.verdict === 'interested') break
        if (x.verdict === 'declined' && x.kind === 'opt_out') {
          latest = x
          break
        }
      }
    }
    if (latest.verdict === 'declined') {
      const kind = latest.kind ?? 'not_interested'
      return {
        ...base,
        signalType: SIGNAL_OF_KIND[kind],
        polarity: 'neutral',
        summary: `The newest reply (${latest.activity.createdAt.slice(0, 10)}) ${REFUSAL_TEXT[kind]}`,
        evidence: `${on(latest.activity)}; kind: ${kind}`,
        observedAt: latest.activity.createdAt,
      }
    }
    if (latest.verdict === 'unverified') {
      return {
        ...base,
        signalType: 'reply_unverified',
        polarity: 'neutral',
        summary: "The newest reply could not be checked (its text was not available, held nothing of the person's own, or was too short to tell) — not counted as interest",
        evidence: on(latest.activity),
        observedAt: latest.activity.createdAt,
      }
    }
    const interested = assessed.filter((x) => x.verdict === 'interested')
    // FRESH = the latest reply is within freshDays (Intent Signals' own INTENT_FRESH_DAYS); older in the window is aging.
    const ageDays = (now.getTime() - new Date(latest.activity.createdAt).getTime()) / 86_400_000
    return {
      ...base,
      freshness: ageDays <= freshDays ? 'fresh' : 'aging',
      signalType: 'inbound_engagement',
      polarity: 'positive',
      summary: `${interested.length} reply(ies) written by a person in the last ${days} days${latest.basis === 'text' ? ', the newest read and containing no refusal' : ''}`,
      evidence: on(latest.activity),
      observedAt: latest.activity.createdAt,
    }
  }
  if (automated.length) {
    const latest = automated[0]!
    return {
      ...base,
      signalType: 'automated_inbound_only',
      polarity: 'neutral',
      summary: `${automated.length} automated inbound message(s) in the last ${days} days (delivery failure or auto-reply) — not a reply from a person`,
      evidence: on(latest),
      observedAt: latest.createdAt,
    }
  }
  return null
}
