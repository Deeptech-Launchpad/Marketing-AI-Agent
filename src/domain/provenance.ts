// Provenance labelling.
//
// Every substantive statement the agent produces must say where it came from.
// This matters most when the sources disagree in reliability: "these 2,658
// companies are in the CRM" and "infrastructure probably means these industries"
// are not the same kind of claim, and a reader must not have to guess which is
// which.
//
// The convention is carried over from NXT Sales' own Customer Intelligence
// prompt, which already requires each claim to be tagged. This module makes the
// same idea structural rather than a prompt instruction the model may forget.

export const PROVENANCE = ['user_intent', 'crm_data', 'knowledge', 'research', 'ai_inference'] as const
export type Provenance = (typeof PROVENANCE)[number]

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  user_intent: '[User intent]',
  crm_data: '[CRM data]',
  knowledge: '[Knowledge]',
  research: '[Research]',
  ai_inference: '[AI inference]',
}

export interface Claim {
  label: Provenance
  statement: string
}

// The safety preamble tells the model to label its claims, so model-supplied
// strings often already start with "[AI inference] ...". When such a string is
// wrapped in a Claim the label gets applied twice — "[AI inference] [AI
// inference] ...". Strip any leading label so the structural one is the only
// one, and a doubled label never reaches an approval payload.
const LEADING_LABEL = /^\s*\[(User intent|CRM data|Knowledge|Research|AI inference|Page data|Email summary)\]\s*/i

/**
 * Removes a provenance label the model wrote into its own text.
 *
 * Exported because stripping at claim() time is not enough: model fragments get
 * interpolated into a larger sentence ("Interpretation: [AI inference] ..."),
 * which puts the stray label mid-string where a leading-anchor regex cannot see
 * it. Callers strip the fragment before composing.
 */
export function stripLabel(text: string): string {
  return String(text ?? '')
    .replace(LEADING_LABEL, '')
    .replace(/\[(User intent|CRM data|Knowledge|Research|AI inference|Page data|Email summary)\]\s*/gi, '')
    .trim()
}

export function claim(label: Provenance, statement: string): Claim {
  return { label, statement: stripLabel(statement) }
}

/** Renders claims for display or for inclusion in an approval payload. */
export function renderClaims(claims: Claim[]): string[] {
  return claims.map((c) => `${PROVENANCE_LABEL[c.label]} ${c.statement}`)
}
