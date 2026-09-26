// THE SALES-APPROVED OUTREACH SEQUENCE — USA.
//
// Source of truth: "Outreach templete/Final -Email Outreach Content by
// Countries .pdf" (USA - UPDATED VERSION), supplied by Sales on 2026-09-25.
//
// Every template body below is the PDF text VERBATIM — its wording, its
// punctuation and its typos included. Nothing here is rewritten, shortened or
// "improved"; a change to approved copy is a change Sales makes in the PDF,
// and then here. Exactly two mechanical changes were made, both required by
// the requirements rather than by taste:
//
//   1. The sender. "Manoj" and "AltiusNxt" are replaced by [Sender first name]
//      and [Sender company], filled from Settings → Outreach sender. Sender
//      details are configuration, never hard-coded copy.
//   2. The expo registration block. The PDF wraps it in "[ … ]" as layout —
//      those two brackets are dropped; every line inside them is kept.
//
// The PDF gives subjects only for the three initial versions. Every later
// stage is sent in the same thread, so its subject is "Re: " + the subject the
// initial email actually went out with (see compose.ts), which Sales can edit.

export type StageKey =
  | 'initial'
  | 'reply_followup' // 2.1
  | 'sku_report' // 2.2
  | 'noreply_followup' // 2.3
  | 'noreply_report' // 2.4
  | 'expo_invite' // 3
  | 'expo_cannot_attend' // 3.1
  | 'breakup' // 4

export type InitialVersion = 'v1' | 'v2' | 'v3'
export const INITIAL_VERSIONS: InitialVersion[] = ['v1', 'v2', 'v3']

/** A value Sales must type in, because no system in this platform holds it. */
export type RequiredInput = 'clientCompanyName' | 'skus' | 'xOf5'

/** A claim in the approved copy the platform cannot check, which Sales confirms. */
export interface AttestationDef {
  key: 'ai_test' | 'report_attached'
  /** What Sales confirms, with {Company} / {Product} filled in at display time. */
  statement: string
  /** The copy says "this week": an attestation older than this is stale. */
  maxAgeDays: number | null
}

export interface StageTemplate {
  key: StageKey
  /** Only for the initial stage. */
  version: InitialVersion | null
  /** The PDF's own heading. */
  label: string
  /** The PDF's section number: "1 · Version 1", "2.1", … "4". */
  pdfRef: string
  /** Null: the stage replies in the initial email's thread ("Re: …"). */
  subject: string | null
  body: string
  /** How this stage becomes due. */
  trigger: 'start' | 'no_reply_timer' | 'reply'
  requiredInputs: RequiredInput[]
  attestations: AttestationDef[]
  /** The stage needs 5 confirmed SKUs from the prospect's reply. */
  needsConfirmedSkus: boolean
  /** Carries the expo paragraph (see EXPO). */
  mentionsExpo: boolean
}

/** The event the approved copy invites prospects to. Part of the approved content. */
export const EXPO = {
  name: 'B2B eCommerce World 2026',
  startsOn: '2026-11-02',
  endsOn: '2026-11-03',
  venue: 'JW Marriott, Indianapolis',
  code: 'ALTIUSVIP',
  registrationUrl:
    'https://events.b2becommerceworld.org/v2/registrations/event/696f763a5e592e8a0a92da6e/ticketType/6971a5671dfa01967fe37b30?couponCode=ALTIUSVIP',
} as const

/** The registration block, exactly as the PDF lays it out (minus its outer brackets). */
const REGISTRATION_BLOCK = `Guest registrations

Registration link

Code: ALTIUSVIP

${EXPO.registrationUrl}`

/**
 * The paragraph of 2.1 that is about the expo — from "One more thing" to the
 * booth-demo line. Named so it can be offered for removal once the expo has
 * passed; it is never removed silently.
 */
export const REPLY_FOLLOWUP_EXPO_PARAGRAPH = `One more thing, in case timing works better in person:

We will be at B2B eCommerce World 2026 (Nov 2–3, JW Marriott, Indianapolis).

${REGISTRATION_BLOCK}

Happy to set up a booth demo if you are attending — no pressure either way, the reports coming regardless.`

const AI_TEST_V1_V3: AttestationDef = {
  key: 'ai_test',
  statement:
    'This week I ran buyer-style queries for {Product} through ChatGPT, Claude, Perplexity and Gemini: {Company} was not the one recommended, and two other suppliers were.',
  maxAgeDays: 7,
}

const AI_TEST_V2: AttestationDef = {
  key: 'ai_test',
  statement:
    'I ran {Product} through ChatGPT, Claude, Perplexity and Gemini myself, and {Company} did not come up as the pick in any of the four.',
  maxAgeDays: 7,
}

const AI_TEST_2_3: AttestationDef = {
  key: 'ai_test',
  statement:
    'The AI Discoverability test holds: {Product} was not the one recommended by ChatGPT, Claude, Perplexity or Gemini, and the client company named in this email showed up as a generic buying-group mention.',
  maxAgeDays: null,
}

const REPORT_ATTACHED: AttestationDef = {
  key: 'report_attached',
  statement:
    'The AI Discoverability Report for these 5 SKUs is ready, the numbers in this email come from it, and I will attach it to this email.',
  maxAgeDays: null,
}

export const STAGE_TEMPLATES: StageTemplate[] = [
  // ── 1. Content — Day 0 cold outreach, one version per prospect ──────────
  {
    key: 'initial',
    version: 'v1',
    label: 'Cold outreach — Version 1',
    pdfRef: '1 · Version 1',
    subject: 'Who AI recommends instead of [Company] for [Product]?',
    body: `[Name],

[Sender first name] here, from [Sender company].

I ran a few buyer-style queries for [Product] through ChatGPT, Claude, Perplexity and Gemini this week — the kind a buyer types when shortlisting suppliers. [Company] wasn't the one recommended. Two other suppliers were.

Usually this is not a product issue — it is a data issue. AI engines only recommend listings they can parse with confidence, and most distributor product data isn't structured for that yet.

We have spent 20+ years fixing exactly this for distributors like Vallen, Travers Tool Co Inc, Industrial Sales & Engineering Co, Coastal Farm, SRS Distribution Inc, etc.

If you send over 5 SKUs, I will run the same test on them and send back a before/after, which takes about a day.

[Sender first name]`,
    trigger: 'start',
    requiredInputs: [],
    attestations: [AI_TEST_V1_V3],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },
  {
    key: 'initial',
    version: 'v2',
    label: 'Cold outreach — Version 2',
    pdfRef: '1 · Version 2',
    subject: 'Ran a test on [Product] across the AI LLMs — thought you did want to see it',
    body: `[Name],

[Sender first name] here, from [Sender company].

Before reaching out, I wanted to check something rather than just claim it: how does [Product] show up when someone asks ChatGPT, Claude, Perplexity or Gemini for a recommendation? I ran it myself — [Company] didn't come up as the pick in any of the four.

That's usually not a quality problem. It's a data problem; these engines only surface listings they can parse with confidence, and most distributor catalogs are not structured for that yet.

We have spent 20+ years fixing this for distributors, including Vallen, Travers Tool Co Inc, Industrial Sales & Engineering Co, Coastal Farm, SRS Distribution Inc, etc.

Send me 5 SKUs, and I will run the same test and send back a side-by-side comparison; I should have it back to you within a day.

[Sender first name]`,
    trigger: 'start',
    requiredInputs: [],
    attestations: [AI_TEST_V2],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },
  {
    key: 'initial',
    version: 'v3',
    label: 'Cold outreach — Version 3',
    pdfRef: '1 · Version 3',
    subject: '[Company] vs. the AI LLMs — a quick comparison',
    body: `[Name],

[Sender first name], from [Sender company].

A growing share of B2B buyers now ask ChatGPT, Claude, Perplexity or Gemini directly instead of searching for the best [Product] supplier who carries [Product] near me. I tried a few of those searches for [Company] this week.

[Company / Product] was not the one recommended. Two other suppliers were.

AI engines recommend what they can confidently parse, and a lot of distributor product data is too sparse or inconsistent for that. Every query where you are not the pick is a buyer looking at someone else's page instead.

We have spent 20+ years solving exactly this for distributors - Vallen, Travers Tool Co Inc, Industrial Sales & Engineering Co, Coastal Farm, SRS Distribution Inc, etc.

Send over 5 SKUs, and I will run the comparison and get you a before/after within a business day.

[Sender first name]`,
    trigger: 'start',
    requiredInputs: [],
    attestations: [AI_TEST_V1_V3],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },

  // ── 2. Follow up for replied / no-reply prospects ───────────────────────
  {
    key: 'reply_followup',
    version: null,
    label: 'Follow up for Email-Reply Prospects',
    pdfRef: '2.1',
    subject: null,
    body: `[Name],

Thanks for the quick reply, and for sending over the 5 SKUs.

I will run each one through ChatGPT, Claude, Perplexity and Gemini using the kind of buyer query someone would actually type while shortlisting a [product category] - then send you a before/after AI Discoverability report showing exactly what these engines see today versus what's possible once the data's enriched.

Turnaround is about 1 business day (8–12 hrs).

${REPLY_FOLLOWUP_EXPO_PARAGRAPH}

Talk soon.

[Sender first name]`,
    trigger: 'reply',
    requiredInputs: [],
    attestations: [],
    needsConfirmedSkus: true,
    mentionsExpo: true,
  },
  {
    key: 'sku_report',
    version: null,
    label: 'Delivery of SKUs with Enriched AI Readiness Report',
    pdfRef: '2.2',
    subject: null,
    body: `[Name],

Here is the enriched AI Discoverability Report for the 5 SKUs you sent over: [1st SKU name], [2nd SKU name], [3rd SKU name], [4th SKU name], [5th SKU name].

It shows exactly what ChatGPT, Claude, Perplexity and Gemini return for each product today, and what changes once the data's enriched and structured for these engines to read.

Quick headline: [X of 5 went from not recommended to appearing in the AI answer] - attached is the full before/after for each.

These five span different categories, so it's a fair test of how the same approach would hold up across your wider catalogue.

Want to walk through it together? 20 minutes is enough to cover all 5 examples and how this scales. What is a convenient time for you this week?

[Sender first name]`,
    trigger: 'reply',
    requiredInputs: ['skus', 'xOf5'],
    attestations: [REPORT_ATTACHED],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },
  {
    key: 'noreply_followup',
    version: null,
    label: 'Follow up email for No Reply Prospects',
    pdfRef: '2.3',
    subject: null,
    body: `[Name],

Following up in case this got buried; happy to keep it short.

The AI Discoverability test I mentioned still stands:

[Product] was not the one recommended by ChatGPT, Claude, Perplexity or Gemini, while [Client Company Name] showed up as a generic buying-group mention. That gap tends to widen the longer the underlying data stays unstructured.

If it's useful, send over 5 SKUs (or tell me to pick a representative mix) and I will get you a before/after AI Discoverability Report within a business day — just need the SKU list to get started.

If now is genuinely not the right time, just let me know, and I will check back later.

[Sender first name]`,
    trigger: 'no_reply_timer',
    requiredInputs: ['clientCompanyName'],
    attestations: [AI_TEST_2_3],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },
  {
    key: 'noreply_report',
    version: null,
    label: 'Delivery of AI Report for No Reply Prospects',
    pdfRef: '2.4',
    subject: null,
    body: `[Name],

Haven't heard back, so rather than follow up again with just words, I picked 5 representative SKUs from [Company]'s catalogue and ran the same test I mentioned — the kind of buyer query someone would type into ChatGPT, Claude, Perplexity or Gemini while shortlisting a [product category].

Attached is the full AI Discoverability Report, with before/after for each:

● [1st SKU name]
● [2nd SKU name]
● [3rd SKU name]
● [4th SKU name]
● [5th SKU name]

Headline: [X of 5 were not recommended by any of the four engines] — the report shows exactly what changes once the data's structured for them to read.

These five span different categories, so it is a reasonable proxy for how this would play out across the wider catalogue.

Happy to walk through it — what's the convenient time this week for a 20-minute call?

[Sender first name]`,
    trigger: 'no_reply_timer',
    requiredInputs: ['skus', 'xOf5'],
    attestations: [REPORT_ATTACHED],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },

  // ── 3. Expo ─────────────────────────────────────────────────────────────
  {
    key: 'expo_invite',
    version: null,
    label: 'Expo Invite - Prospect never responded',
    pdfRef: '3',
    subject: null,
    body: `[Name],

We will be at B2B eCommerce World 2026 (Nov 2–3, JW Marriott, Indianapolis) — this year's theme is manufacturers and distributors leading in B2B digital commerce.

Happy to walk you through real before/after product enrichment examples at our booth, including a live AI Discoverability Report demo — no preparation needed on your end.

Booth slots are limited, so if you are planning to attend, let me know and I will hold a time for you.

${REGISTRATION_BLOCK}

[Sender first name]`,
    trigger: 'no_reply_timer',
    requiredInputs: [],
    attestations: [],
    needsConfirmedSkus: false,
    mentionsExpo: true,
  },
  {
    key: 'expo_cannot_attend',
    version: null,
    label: 'Prospect replies as interested, but cant attend the expo',
    pdfRef: '3.1',
    subject: null,
    body: `[Name],

No problem, glad to hear there is still interest, even if the expo timing does not line up.

Easiest next step:

We run the free 5-SKU enrichment demo remotely and send you the before/after AI Discoverability Report, same as we would have shown at the booth. Just need 5 SKUs from you, or I can pick a representative mix.

If you would like to go deeper afterwards, our CEO would be glad to visit your office and walk through the findings in person. But let's start with the report, so you have something concrete to review first.

What would you prefer: I select the 5 SKUs, or you send over the ones you would like us to focus on?

[Sender first name]`,
    trigger: 'reply',
    requiredInputs: [],
    attestations: [],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },

  // ── 4. Break up email ───────────────────────────────────────────────────
  {
    key: 'breakup',
    version: null,
    label: 'Break up email',
    pdfRef: '4',
    subject: null,
    body: `[Name],

Haven't heard back, so I will take that as timing not being right for [Company] — completely understand.

Before I close this out:

The AI Discoverability gap I flagged earlier does not stay static — the engines re-index every few weeks, so distributors who fix their product data now are the ones that get recommended by default going forward. Worth knowing even if it's not a priority today.

If there is someone else at [Company] who owns product data or digital, or any team, I am happy to loop them in instead. Otherwise, no worries at all the offer stands whenever it's useful.

[Sender first name]`,
    trigger: 'no_reply_timer',
    requiredInputs: [],
    attestations: [],
    needsConfirmedSkus: false,
    mentionsExpo: false,
  },
]

/** Where these templates came from, recorded on every message. */
export const TEMPLATE_SET_VERSION = 'usa-pdf-2026-09-25'

export function templateFor(stage: StageKey, version: InitialVersion | null = null): StageTemplate {
  const t = STAGE_TEMPLATES.find((s) => s.key === stage && (stage !== 'initial' || s.version === version))
  if (!t) throw new Error(`No approved template for stage "${stage}"${version ? ` (${version})` : ''}.`)
  return t
}

/** The template key stored on OutreachMessage, e.g. "usa.initial.v2" or "usa.2.3". */
export function templateKeyFor(t: StageTemplate): string {
  return t.key === 'initial' ? `usa.initial.${t.version}` : `usa.${t.pdfRef}`
}

/** Fixed step numbers per stage, so CRM Sync's "first 10 actions" ordering reads naturally. */
export const STAGE_STEP_NUMBER: Record<StageKey, number> = {
  initial: 10,
  reply_followup: 21,
  sku_report: 22,
  noreply_followup: 23,
  noreply_report: 24,
  expo_invite: 30,
  expo_cannot_attend: 31,
  breakup: 40,
}
export const CALL_POINTS_STEP_NUMBER = 90
