import type { OutreachChannel } from './types.js'

// TASK #982 — channel templates.
//
// Structured blocks rather than one giant string, for two reasons. A reviewer
// can diff a hook without re-reading a whole email, and the claim guard can be
// run per block so a violation names the block it came from.
//
// Every template is versioned. A version is part of the idempotency key, so
// changing wording does not silently re-send to people who already received the
// old version — it is a different message, and the engine treats it as one.

export interface TemplateBlock {
  key: string
  /** Required blocks must render to non-empty text or the template is invalid. */
  required: boolean
}

export interface OutreachTemplate {
  key: string
  version: string
  channel: OutreachChannel
  /** Null for channels with no subject line. */
  subjectBlocks: TemplateBlock[] | null
  bodyBlocks: TemplateBlock[]
  /** Separator between rendered body blocks. */
  joiner: string
  description: string
}

/**
 * The template set.
 *
 * Wording is deliberately plain. The audit's own findings are the interesting
 * part of any of these messages, and dressing them up is what turns a
 * defensible observation into a sales claim.
 */
export const TEMPLATES: OutreachTemplate[] = [
  {
    key: 'email.audit_intro',
    version: 'v1',
    channel: 'email',
    subjectBlocks: [{ key: 'subject', required: true }],
    bodyBlocks: [
      { key: 'greeting', required: true },
      { key: 'auditHook', required: true },
      { key: 'finding', required: true },
      { key: 'value', required: false },
      { key: 'cta', required: true },
      { key: 'signature', required: true },
      { key: 'compliance', required: true },
    ],
    joiner: '\n\n',
    description: 'First contact. Leads with what the audit actually found on their own pages.',
  },
  {
    key: 'email.workbench_followup',
    version: 'v1',
    channel: 'email_followup',
    subjectBlocks: [{ key: 'subject', required: true }],
    bodyBlocks: [
      { key: 'greeting', required: true },
      { key: 'reference', required: true },
      { key: 'workbench', required: true },
      { key: 'cta', required: true },
      { key: 'signature', required: true },
      { key: 'compliance', required: true },
    ],
    joiner: '\n\n',
    description: 'Follow-up carrying the personalised Workbench link.',
  },
  {
    key: 'linkedin.connection_note',
    version: 'v1',
    channel: 'linkedin',
    subjectBlocks: null,
    // 300 characters total, so the blocks are short by construction.
    bodyBlocks: [
      { key: 'greeting', required: true },
      { key: 'auditHook', required: true },
      { key: 'cta', required: true },
    ],
    joiner: ' ',
    description: 'A connection note, within the platform 300-character limit.',
  },
  {
    key: 'call.sdr_task',
    version: 'v1',
    channel: 'call',
    subjectBlocks: [{ key: 'subject', required: true }],
    bodyBlocks: [
      { key: 'context', required: true },
      { key: 'askFor', required: true },
      { key: 'talkingPoints', required: true },
      { key: 'evidenceNote', required: true },
      { key: 'cta', required: true },
    ],
    joiner: '\n\n',
    description: 'Internal SDR call task with talking points drawn from the approved audit.',
  },
  {
    key: 'whatsapp.brief_intro',
    version: 'v1',
    channel: 'whatsapp',
    subjectBlocks: null,
    bodyBlocks: [
      { key: 'greeting', required: true },
      { key: 'auditHook', required: true },
      { key: 'cta', required: true },
    ],
    joiner: ' ',
    description: 'Short alternative-channel message. Disabled unless explicitly configured.',
  },
]

export function templateFor(channel: OutreachChannel): OutreachTemplate {
  const t = TEMPLATES.find((x) => x.channel === channel)
  if (!t) throw new Error(`No template is registered for channel "${channel}".`)
  return t
}

export function templateByKey(key: string, version: string): OutreachTemplate | null {
  return TEMPLATES.find((t) => t.key === key && t.version === version) ?? null
}

/** Assembles rendered blocks in template order, dropping empty optional ones. */
export function renderTemplate(
  template: OutreachTemplate,
  blocks: Record<string, string>,
): { subject: string | null; body: string; missing: string[] } {
  const missing: string[] = []

  const take = (defs: TemplateBlock[]): string[] =>
    defs
      .map((d) => {
        const value = (blocks[d.key] ?? '').trim()
        if (!value && d.required) missing.push(d.key)
        return value
      })
      .filter(Boolean)

  const subject = template.subjectBlocks ? take(template.subjectBlocks).join(' ') : null
  const body = take(template.bodyBlocks).join(template.joiner)

  return { subject: subject || null, body, missing }
}
