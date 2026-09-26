import { z } from 'zod'
import { env } from '../config/env.js'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'
import { assertSupported } from '../websiteaudit/claimGuard.js'
import { renderTemplate, templateFor } from './templates.js'
import { CHANNEL_LIMITS, type ComposedMessage, type MessageEvidence, type OutreachChannel, type OutreachTarget } from './types.js'

// TASK #982 — writing the message.
//
// Every sentence that makes a claim about the prospect is built from a row we
// can point at: a CatalogFinding, a PageObservation, a WorkbenchField. The
// evidence list travels with the message, so "why was this sent to this person"
// has an answer that is not "the model wrote it".
//
// No Gemini call is made here — this is the LEGACY, audit-basis path
// (composeMessage below). The audit already produced defensible sentences
// under a claim guard in Task #979, and the strongest thing an outreach email
// can say is a quotation of a finding rather than a paraphrase of one. Every
// composed block still passes back through that same guard, so a percentage, a
// revenue figure or a catalogue-wide generalisation cannot reach a prospect
// even if a future template author writes one in.
//
// The 2026-09-24 restructure's DEFAULT path is composeFromTemplate, near the
// bottom of this file: a Sales-approved OutreachTemplate personalized by
// Gemini, grounded in Intent Signals rather than audit findings. It is a
// second function, not a rewrite of this one, so a campaign already built
// from an approved audit keeps behaving exactly as it always has.

export interface PersonalizationInput {
  channel: OutreachChannel
  target: OutreachTarget
  companyName: string
  /** The single strongest finding, already claim-guarded by Task #979. */
  topFinding: {
    id: string
    title: string
    metric: string
    finding: string
    recommendation: string
    sourceUrl: string | null
  } | null
  /** Sample scope, so any number in the message names its denominator. */
  sample: { pagesInspected: number; productPagesInspected: number } | null
  /**
   * The audit run itself, which is evidence in its own right.
   *
   * It matters most when there is NO finding: for a prospect whose site was
   * unreachable, "we tried to review your product pages and could not reach the
   * site" is a real conversation, and the run is what backs it. Without this the
   * evidence check blocked the one channel that works for exactly the prospects
   * where a human conversation is most warranted.
   */
  auditRunId: string
  /** A live Workbench link belonging to THIS prospect's audit, or null. */
  workbenchUrl: string | null
  workbenchProductName: string | null
  /** Intent signals, used only for the call task's context. */
  intentSignals: Array<{ id: string; summary: string; sourceUrl: string | null }>
  senderName: string
  senderCompany: string
}

const CTA_LINE = 'Would a 15-minute walkthrough be useful?'

/** First name only where a full name is available; never a guessed nickname. */
function firstName(full: string | null): string | null {
  if (!full) return null
  const cleaned = full.replace(/\([^)]*\)/g, ' ').replace(/["'"'][^"'"']*["'"']/g, ' ').trim()
  const first = cleaned.split(/\s+/)[0]
  return first && first.length > 1 ? first : null
}

function greeting(target: OutreachTarget): string {
  const name = firstName(target.contactName)
  return name ? `Hi ${name},` : 'Hello,'
}

export function composeMessage(input: PersonalizationInput): ComposedMessage {
  const template = templateFor(input.channel)
  const evidence: MessageEvidence[] = []
  const blocks: Record<string, string> = {}

  const { topFinding, sample, companyName } = input

  if (topFinding) {
    evidence.push({
      kind: 'catalog_finding',
      referenceId: topFinding.id,
      summary: topFinding.metric,
      sourceUrl: topFinding.sourceUrl,
    })
  }
  // Always present: every message is traceable to the audit that licensed it,
  // whether or not that audit produced a finding.
  evidence.push({
    kind: 'audit_run',
    referenceId: input.auditRunId,
    summary: sample
      ? `An approved website audit covering ${sample.pagesInspected} inspected page(s), ${sample.productPagesInspected} of them product pages.`
      : 'An approved website audit of this company.',
    sourceUrl: null,
  })

  if (input.workbenchUrl) {
    evidence.push({
      kind: 'workbench_demo',
      referenceId: null,
      summary: `A personalised before/after view of ${input.workbenchProductName ?? 'a product page'}.`,
      sourceUrl: input.workbenchUrl,
    })
  }

  // The sample sentence is the honest frame for everything else in the message.
  const scope = sample
    ? `We looked at ${sample.pagesInspected} page(s) on your website, including ${sample.productPagesInspected} product page(s).`
    : 'We looked at a sample of pages on your website.'

  const thirdPersonScope = sample
    ? `We reviewed ${sample.pagesInspected} page(s) on their website, including ${sample.productPagesInspected} product page(s).`
    : 'We reviewed a sample of pages on their website.'

  switch (input.channel) {
    case 'email': {
      blocks.subject = topFinding
        ? `${companyName} — what we found on your product pages`
        : `${companyName} — a short product data review`
      blocks.greeting = greeting(input.target)
      blocks.auditHook = `${scope} This is a short note about what we found, not a pitch.`
      blocks.finding = topFinding
        ? `${topFinding.finding} ${topFinding.metric}`
        : 'We did not find a product page we could assess from the public site, which is itself worth a conversation.'
      blocks.value = topFinding ? topFinding.recommendation : ''
      blocks.cta = CTA_LINE
      blocks.signature = `${input.senderName}\n${input.senderCompany}`
      blocks.compliance = complianceFooter()
      break
    }

    case 'email_followup': {
      blocks.subject = `${companyName} — your product page, before and after`
      blocks.greeting = greeting(input.target)
      blocks.reference = `Following up on my note about the product pages we reviewed on your site. ${scope}`
      blocks.workbench = input.workbenchUrl
        ? `I put together a short interactive view of ${
            input.workbenchProductName ? `"${input.workbenchProductName}"` : 'one of your product pages'
          } showing what is published today next to what the same page could carry, built only from what we actually found: ${input.workbenchUrl}`
        : 'I can put together a short before/after view of one of your product pages if that would help.'
      blocks.cta = CTA_LINE
      blocks.signature = `${input.senderName}\n${input.senderCompany}`
      blocks.compliance = complianceFooter()
      break
    }

    case 'linkedin': {
      // 300 characters total, so this is deliberately terse.
      blocks.greeting = greeting(input.target)
      blocks.auditHook = topFinding
        ? `we reviewed a sample of ${companyName}'s product pages and noticed that ${shortFinding(topFinding.title)}.`
        : `we reviewed a sample of ${companyName}'s website product pages.`
      blocks.cta = 'Happy to share what we found.'
      break
    }

    case 'call': {
      blocks.subject = `Call ${companyName}${input.target.contactName ? ` — ask for ${input.target.contactName}` : ''}`
      // Third person: this task is read by an SDR about a prospect, and
      // "your website" in an internal task is confusing at best.
      blocks.context = `${thirdPersonScope} The audit for this company has been reviewed and approved.`
      blocks.askFor = input.target.contactName
        ? `Ask for ${input.target.contactName}${input.target.contactTitle ? ` (${input.target.contactTitle})` : ''}.`
        : 'No product-data owner was identified for this company, so ask who looks after product information on the website.'
      blocks.talkingPoints = callTalkingPoints(input)
      blocks.evidenceNote = topFinding
        ? `Strongest evidence to quote: ${topFinding.metric}${topFinding.sourceUrl ? ` (${topFinding.sourceUrl})` : ''}`
        : 'No product page was assessable from the public site — lead with that.'
      blocks.cta = `Offer the 15-minute walkthrough${input.workbenchUrl ? ` and the before/after view: ${input.workbenchUrl}` : ''}.`
      break
    }

    case 'whatsapp': {
      blocks.greeting = greeting(input.target)
      blocks.auditHook = `we reviewed a sample of ${companyName}'s product pages.`
      blocks.cta = 'Happy to share what we found if useful.'
      break
    }
  }

  const rendered = renderTemplate(template, blocks)
  if (rendered.missing.length) {
    throw new Error(
      `Template "${template.key}@${template.version}" is missing required block(s): ${rendered.missing.join(', ')}.`,
    )
  }

  // Every block passes the Task #979 guard. A template author who writes a
  // percentage or a revenue promise gets an error naming the block, rather than
  // a prospect getting the claim.
  Object.entries(blocks).forEach(([key, value]) => {
    if (value.trim()) assertSupported(`outreach.${input.channel}.${key}`, value)
  })

  return {
    channel: input.channel,
    templateKey: template.key,
    templateVersion: template.version,
    subject: rendered.subject,
    body: rendered.body,
    blocks,
    ctaUrl: env.WORKBENCH_CTA_URL,
    workbenchUrl: input.workbenchUrl,
    evidence,
    length: rendered.body.length,
  }
}

/**
 * Turns a finding TITLE into a clause that reads inside a sentence.
 *
 * The titles are written as headlines ("Brand not stated on inspected product
 * pages"), and dropping the tail alone left "noticed brand not stated", which
 * is not a sentence. This restores the verb.
 */
function shortFinding(title: string): string {
  const t = title.replace(/ on inspected product pages$/i, '').trim()
  const lowered = t.charAt(0).toLowerCase() + t.slice(1)
  return lowered
    .replace(/^(.*?) not (stated|present|declared)$/, 'the $1 was not $2')
    .replace(/^no product page could be identified.*$/, 'no product page could be identified')
}

/**
 * The SDR's talking points.
 *
 * Numbered, quotable, and each one traceable. The last point is always the
 * honest caveat about sample size — an SDR who overstates it on a call does
 * more damage than a weak opening.
 */
function callTalkingPoints(input: PersonalizationInput): string {
  const points: string[] = []
  const { topFinding, sample } = input

  points.push(
    sample
      ? `We reviewed ${sample.pagesInspected} page(s) on their website, including ${sample.productPagesInspected} product page(s).`
      : 'We reviewed a sample of pages on their website.',
  )

  if (topFinding) {
    points.push(`${topFinding.finding}`)
    points.push(`Quote the measurement directly: ${topFinding.metric}`)
    points.push(`What we would suggest: ${topFinding.recommendation}`)
  } else {
    points.push('No product page could be assessed from their public site — ask how their catalogue is published.')
  }

  input.intentSignals.slice(0, 2).forEach((s) => points.push(`Context from the CRM: ${s.summary}`))

  if (input.workbenchUrl) {
    points.push(`Offer the personalised before/after view of their own product page: ${input.workbenchUrl}`)
  }

  // Always last: the scope caveat.
  points.push('Be clear this covers the pages we inspected, not their whole catalogue.')

  return points.map((p, i) => `${i + 1}. ${p}`).join('\n')
}

function complianceFooter(): string {
  return (
    `${env.OUTREACH_COMPANY_NAME}, ${env.OUTREACH_COMPANY_ADDRESS}\n` +
    `If you would rather not hear from us, reply with "unsubscribe" and we will remove you.`
  )
}

// ── TEMPLATE-BASIS PERSONALIZATION (2026-09-24 restructure) ────────────────
//
// The default path for a campaign with no approved audit: a Sales-approved
// OutreachTemplate, rewritten by Gemini into a natural, non-spammy message for
// one specific company and person, grounded in Intent Signals rather than
// audit findings.
//
// TWO separate safety nets, not one:
//
//   1. GROUNDING. The model must quote, verbatim, every fact it drew on — see
//      isGroundedInFacts(). A claim it cannot quote from the facts it was
//      actually given is a claim it invented, and the whole personalization is
//      discarded for it: not trimmed, not partially trusted. What is sent
//      instead is the template exactly as Sales wrote it (plainTemplateMessage),
//      which is always a safe message because nobody has personalized anything
//      false into it.
//
//   2. THE CLAIM GUARD. The same one every legacy block already passes
//      through (Task #979's findUnsupportedClaims). It runs on whichever body
//      is actually sent — model-personalized or the plain template — so a
//      percentage or a revenue promise cannot reach a prospect whichever path
//      produced the words, including one a template author wrote in by hand.

export interface OutreachTemplateRow {
  id: string
  key: string
  version: string
  subjectRaw: string | null
  bodyRaw: string
}

export interface TemplatePersonalizationInput {
  channel: OutreachChannel
  target: OutreachTarget
  companyName: string
  /** From a DiscoveredCompany's own fetched page, or a CompanyEnrichment row. Never invented. */
  companySummary: string | null
  /** Up to a few, most recent first. Used only for what the facts actually say. */
  intentSignals: Array<{ id: string; summary: string; sourceUrl: string | null }>
  template: OutreachTemplateRow
  senderName: string
  senderCompany: string
  tenantId: string
}

const PersonalizedMessage = z.object({
  subject: z.string().nullable(),
  body: z.string().min(1),
  /** Verbatim quotes from the facts given — never a paraphrase. See isGroundedInFacts. */
  factsUsed: z.array(z.string()).max(6),
})

/** The facts a personalization is allowed to draw on. */
function factLines(input: TemplatePersonalizationInput): string[] {
  const lines: string[] = [input.companyName]
  if (input.companySummary) lines.push(input.companySummary)
  if (input.target.contactName) lines.push(input.target.contactName)
  if (input.target.contactTitle) lines.push(input.target.contactTitle)
  for (const s of input.intentSignals) lines.push(s.summary)
  return lines
}

/**
 * True only when every claimed fact is a literal substring of what was given.
 *
 * The same discipline decisionmakers/modelReader.ts's isGroundedInSource
 * already applies to a named person: a paraphrase is not verifiable, a
 * verbatim quote is.
 */
export function isGroundedInFacts(factsUsed: string[], facts: string[]): boolean {
  const haystack = facts.join('\n').toLowerCase()
  return factsUsed.every((f) => {
    const needle = f.trim().toLowerCase()
    return needle.length >= 3 && haystack.includes(needle)
  })
}

/** The template exactly as Sales wrote it. The safe fallback: nothing here was personalized. */
function plainTemplateMessage(input: TemplatePersonalizationInput): ComposedMessage {
  const body = input.template.bodyRaw
  return {
    channel: input.channel,
    templateKey: input.template.key,
    templateVersion: input.template.version,
    subject: input.template.subjectRaw,
    body,
    blocks: { body },
    ctaUrl: env.WORKBENCH_CTA_URL,
    workbenchUrl: null,
    evidence: [
      {
        kind: 'outreach_template',
        referenceId: input.template.id,
        summary: `Template "${input.template.key}@${input.template.version}", used exactly as approved — not personalized.`,
        sourceUrl: null,
      },
    ],
    length: body.length,
  }
}

export async function composeFromTemplate(input: TemplatePersonalizationInput): Promise<ComposedMessage> {
  const limits = CHANNEL_LIMITS[input.channel]
  const facts = factLines(input)

  const variables = {
    channel: input.channel,
    maxBody: String(limits.maxBody),
    maxSubjectNote: limits.maxSubject ? `, subject max: ${limits.maxSubject} characters` : '',
    templateSubject: input.template.subjectRaw ?? '(none)',
    templateBody: input.template.bodyRaw,
    companyName: input.companyName,
    companySummary: input.companySummary ?? '(none provided)',
    contactName: input.target.contactName ?? '(none — address generically)',
    contactTitle: input.target.contactTitle ?? '(none)',
    intentSignals: input.intentSignals.length
      ? input.intentSignals.map((s, i) => `${i + 1}. ${s.summary}`).join('\n')
      : '(none)',
  }

  let composed: ComposedMessage | null = null

  for (let attempt = 1; attempt <= 2 && !composed; attempt++) {
    let data: z.infer<typeof PersonalizedMessage>
    try {
      const result = await getLlm().generate({
        promptKey: 'outreach.personalize_template',
        variables,
        schema: PersonalizedMessage,
        feature: 'outreach.personalize_template',
        tenantId: input.tenantId,
      })
      data = result.data
    } catch (err) {
      logger.info(
        { err: (err as Error).message, templateKey: input.template.key },
        'template personalization call failed; using the plain template',
      )
      break
    }

    if (!isGroundedInFacts(data.factsUsed, facts)) {
      logger.info(
        { templateKey: input.template.key, factsUsed: data.factsUsed },
        'personalization claimed a fact not in what was given; using the plain template',
      )
      break
    }
    const overLength = data.body.length > limits.maxBody || Boolean(limits.maxSubject && data.subject && data.subject.length > limits.maxSubject)
    if (overLength) {
      if (attempt < 2) continue // one retry; the prompt already states the limit
      logger.info({ templateKey: input.template.key }, 'personalization stayed over the channel limit after a retry; using the plain template')
      break
    }

    composed = {
      channel: input.channel,
      templateKey: input.template.key,
      templateVersion: input.template.version,
      subject: data.subject,
      body: data.body,
      blocks: { body: data.body },
      ctaUrl: env.WORKBENCH_CTA_URL,
      workbenchUrl: null,
      evidence: [
        {
          kind: 'outreach_template',
          referenceId: input.template.id,
          summary: `Personalized from template "${input.template.key}@${input.template.version}".`,
          sourceUrl: null,
        },
        ...data.factsUsed.map((f) => ({ kind: 'personalization_fact', referenceId: null, summary: f, sourceUrl: null }) as MessageEvidence),
      ],
      length: data.body.length,
    }
  }

  const final = composed ?? plainTemplateMessage(input)

  // The same guard every legacy block already passes through, run on
  // whichever body is actually being sent — so nothing reaches a prospect
  // that states a percentage, a revenue figure, or a claim this guard cannot
  // support, whether the model wrote it or a template author did.
  assertSupported(`outreach.${input.channel}.body`, final.body)
  if (final.subject) assertSupported(`outreach.${input.channel}.subject`, final.subject)

  return final
}
