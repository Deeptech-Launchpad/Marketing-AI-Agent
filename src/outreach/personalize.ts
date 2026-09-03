import { env } from '../config/env.js'
import { assertSupported } from '../websiteaudit/claimGuard.js'
import { renderTemplate, templateFor } from './templates.js'
import type { ComposedMessage, MessageEvidence, OutreachChannel, OutreachTarget } from './types.js'

// TASK #982 — writing the message.
//
// Every sentence that makes a claim about the prospect is built from a row we
// can point at: a CatalogFinding, a PageObservation, a WorkbenchField. The
// evidence list travels with the message, so "why was this sent to this person"
// has an answer that is not "the model wrote it".
//
// No Gemini call is made here. The audit already produced defensible sentences
// under a claim guard in Task #979, and the strongest thing an outreach email
// can say is a quotation of a finding rather than a paraphrase of one. Every
// composed block still passes back through that same guard, so a percentage, a
// revenue figure or a catalogue-wide generalisation cannot reach a prospect
// even if a future template author writes one in.

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
