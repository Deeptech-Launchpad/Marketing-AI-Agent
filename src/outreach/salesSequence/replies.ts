import { z } from 'zod'
import { getLlm } from '../../llm/index.js'
import { logger } from '../../platform/logger.js'
import { REPLY_CLASSES, type ReplyClass } from './stageMachine.js'

// READING A PROSPECT'S REPLY — AND NOT ASSUMING.
//
// Sales pastes the reply; a model proposes what kind of reply it is, quotes
// the words that show it, and lists any SKUs the prospect named. Then this
// file checks the model against the reply itself:
//
//   · the quote must be in the reply, word for word — otherwise the reading is
//     unsupported and becomes "unclear";
//   · every SKU must be in the reply, word for word — one that is not was
//     invented, and is dropped;
//   · "sent SKUs" with no SKU that survives is not a SKU reply — "unclear".
//
// Nothing changes on the prospect until Sales confirms (or overrides) the
// classification. "Unclear" cannot be confirmed: a person picks what it is.

export const REPLY_LABELS: Record<ReplyClass, string> = {
  sent_skus: 'Sent SKUs',
  interested_cannot_attend_expo: 'Interested, but cannot attend the expo',
  interested_no_skus: 'Interested (no SKUs yet)',
  wants_more_info: 'Wants more information',
  not_interested: 'Not interested',
  follow_up_later: 'Asked to follow up later',
  unclear: 'Unclear — Sales to decide',
}

const Classified = z.object({
  classification: z.enum(REPLY_CLASSES),
  evidenceQuote: z.string().nullable().optional(),
  skus: z.array(z.string()).max(30).default([]),
})

export interface ReplyReading {
  classification: ReplyClass
  evidenceQuote: string | null
  skus: string[]
  checks: string[]
  model: string | null
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Holds the model's reading to what the reply actually says. Pure. */
export function verifyReading(raw: z.infer<typeof Classified>, replyText: string): Omit<ReplyReading, 'model'> {
  const text = norm(replyText)
  const checks: string[] = []
  let classification: ReplyClass = raw.classification

  const quote = raw.evidenceQuote?.trim() || null
  if (classification !== 'unclear') {
    if (!quote) {
      checks.push('The reading quoted nothing from the reply, so it is not supported.')
      classification = 'unclear'
    } else if (!text.includes(norm(quote))) {
      checks.push('The quoted words are not in the reply, so the reading is not supported.')
      classification = 'unclear'
    }
  }

  const skus: string[] = []
  for (const s of raw.skus) {
    const v = s.trim()
    if (!v) continue
    if (text.includes(norm(v))) {
      if (!skus.some((x) => norm(x) === norm(v))) skus.push(v)
    } else {
      checks.push(`"${v}" is not in the reply, so it was dropped as a SKU.`)
    }
  }
  if (classification === 'sent_skus' && skus.length === 0) {
    checks.push('No SKU named in the reply, so this is not a SKU reply.')
    classification = 'unclear'
  }
  return { classification, evidenceQuote: classification === 'unclear' && checks.length ? null : quote, skus, checks }
}

export async function classifyReply(input: { text: string; stageContext: string; tenantId: string }): Promise<ReplyReading> {
  try {
    const result = await getLlm().generate({
      promptKey: 'outreach.classify_reply',
      variables: { stageContext: input.stageContext, replyText: input.text.slice(0, 8_000) },
      schema: Classified,
      feature: 'outreach.sales_sequence',
      tenantId: input.tenantId,
    })
    const parsed = Classified.safeParse(result.data)
    if (!parsed.success) {
      return { classification: 'unclear', evidenceQuote: null, skus: [], checks: ['The reading did not have the expected shape.'], model: result.model }
    }
    return { ...verifyReading(parsed.data, input.text), model: result.model }
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'reply classification failed; Sales decides')
    return { classification: 'unclear', evidenceQuote: null, skus: [], checks: ['The reply could not be read automatically. Choose its type yourself.'], model: null }
  }
}
