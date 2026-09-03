import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

// One zod schema per step drives three things: the Gemini responseSchema, the
// runtime validation of what came back, and the TypeScript type of the result.
// Keeping them from drifting apart is the entire point.

const UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$ref',
  'definitions',
  '$defs',
  'additionalProperties',
  'default',
  'const',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
  'oneOf',
  'allOf',
  'not',
  'anyOf',
])

/**
 * Gemini's responseSchema accepts a restricted OpenAPI-3 subset. Anything it
 * does not understand is rejected outright, so unsupported keywords are
 * stripped rather than passed through and hoped for.
 */
function sanitise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitise)
  if (node === null || typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYS.has(key)) continue
    out[key] = sanitise(value)
  }
  return out
}

/** zod schema -> Gemini responseSchema. $refs are inlined; nothing is shared. */
export function toGeminiSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' })
  return sanitise(json) as Record<string, unknown>
}

/**
 * Models occasionally wrap JSON in a fenced code block despite
 * responseMimeType. Unwrapping is cheap and avoids failing an otherwise-valid
 * response; anything beyond that is a real schema failure and is allowed to be
 * one.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced?.[1] ?? trimmed
  return JSON.parse(candidate)
}
