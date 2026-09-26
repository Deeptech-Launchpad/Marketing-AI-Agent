import { z } from 'zod'
import { GEMINI_REASONING_PRIORITY } from '../llm/gemini/modelFallback.js'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'

// A CAREFUL READER FOR ONE PRODUCT PAGE.
//
// The rule-based extractor reads declared structure — spec tables, definition
// lists, JSON-LD. Many real product pages put their description and specs in
// their own layout (divs, spans, tab panels), and a reader that misses them
// would report "no description" or "no attributes" about a page that has
// them: a false finding put in front of Sales.
//
// So a model is asked to READ the page text, and nothing else. It does not
// judge the page. Every value it returns is checked against the text we
// fetched and dropped unless it appears there literally — a model is allowed
// to find what the page says, never to supply it.

const Read = z.object({
  productName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  attributes: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .max(80)
    .default([]),
  featureBullets: z.array(z.string()).max(20).default([]),
})

export interface VerifiedRead {
  description: string | null
  attributes: Array<{ name: string; value: string }>
  featureBullets: string[]
  /** How many values the model returned that were NOT on the page, and so were dropped. */
  dropped: number
}

export type ProductReader = (input: { pageText: string; url: string; tenantId?: string }) => Promise<VerifiedRead | null>

/** Letters and digits only, lower-cased — so spacing and punctuation differences do not hide a real match. */
export function squash(s: string): string {
  return s.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, '')
}

/**
 * Keeps only what the page literally states.
 *
 * A description must appear as written (its first 120 characters, ignoring
 * spacing and punctuation); an attribute's value must appear on the page, and
 * so must a meaningful part of its name.
 */
export function verifyRead(raw: z.infer<typeof Read>, pageText: string): VerifiedRead {
  const page = squash(pageText)
  let dropped = 0

  let description: string | null = null
  const desc = raw.description?.trim()
  if (desc && desc.split(/\s+/).length >= 8) {
    if (page.includes(squash(desc.slice(0, 120)))) description = desc.slice(0, 900)
    else dropped++
  }

  const attributes: VerifiedRead['attributes'] = []
  const seen = new Set<string>()
  for (const a of raw.attributes) {
    const name = a.name.trim().replace(/\s*[:：]\s*$/, '')
    const value = a.value.trim()
    const v = squash(value)
    const n = squash(name)
    if (!name || !value || !v) continue
    if (!page.includes(v) || (n.length >= 3 && !page.includes(n.slice(0, 12)))) {
      dropped++
      continue
    }
    const k = `${n}\u0000${v}`
    if (seen.has(k)) continue
    seen.add(k)
    attributes.push({ name: name.slice(0, 80), value: value.slice(0, 200) })
  }

  const featureBullets = raw.featureBullets
    .map((b) => b.trim())
    .filter((b) => {
      const ok = b.length >= 6 && page.includes(squash(b.slice(0, 80)))
      if (!ok && b) dropped++
      return ok
    })
    .slice(0, 12)

  return { description, attributes, featureBullets, dropped }
}

/** The default reader: one structured Gemini call over the page text. Never throws. */
export const readProductWithModel: ProductReader = async ({ pageText, url, tenantId }) => {
  // Usage is recorded per tenant; a read with no tenant to charge is not made.
  if (!tenantId) return null
  try {
    const result = await getLlm().generate({
      promptKey: 'prospect.read_product_page',
      variables: { sourceUrl: url, pageText: pageText.slice(0, 15_000) },
      schema: Read,
      feature: 'prospect.read_product_page',
      tenantId,
      // The flash tier answers this copy-exactly task with empty lists (seen
      // live, 2026-09-25); the pro tier reads it reliably. Still falls back
      // through the gateway's chain if pro is unavailable.
      model: GEMINI_REASONING_PRIORITY[0],
    })
    const parsed = Read.safeParse(result.data)
    if (!parsed.success) return null
    return verifyRead(parsed.data, pageText)
  } catch (err) {
    logger.info({ err: (err as Error).message, url }, 'product page model read failed; rule-based reading only')
    return null
  }
}
