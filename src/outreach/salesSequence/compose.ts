import { findUnsupportedClaims } from '../../websiteaudit/claimGuard.js'
import type { Fact, ProspectFacts } from './facts.js'
import type { MessageInputs } from './gates.js'
import {
  companyDisplayName,
  fill,
  findUnresolved,
  firstName,
  placeholdersIn,
  type PlaceholderKey,
  type PlaceholderValues,
} from './placeholders.js'
import type { SenderConfig } from './sender.js'
import { EXPO, PRODUCT_PAGE_LINE, type StageKey, type StageTemplate } from './templates.js'

// FROM AN APPROVED TEMPLATE TO A PERSONAL DRAFT — WITHOUT REWRITING IT.
//
// Two steps, in this order:
//
//   1. FILL. Every placeholder the approved copy uses is filled from a
//      verified fact (the decision maker Decision Makers shortlisted, the
//      product Prospects analysed, the company), from a value Sales entered,
//      or from Settings (the sender). One with no source stays visibly
//      unfilled — "[Product]" — and blocks approval until Sales fills it.
//
//   2. NO MODEL AT ALL (2026-10-07). [Product] is the product's name exactly
//      as the company's own product page states it, and [Company] the
//      company's name — Sales asked for the approved copy with only those
//      replaced, so the model that used to pick a shorter product word is no
//      longer called. The sign-off is the sender's name, with their email on
//      the line below; nothing else is added.
//
// NO AI-WRITTEN SENTENCE EVER REACHES THE EMAIL (2026-09-30).
//
// The model used to be allowed one personal line, inserted between two
// approved paragraphs and marked as AI-added. Sales asked for it to go: an
// outreach email is now the approved copy and nothing else. Every sentence a
// customer reads was written by Sales, and (since 2026-10-07) no model is
// involved in composing an email at all.

// Sales asked for the AI's personal line to be removed, so there is no slot
// for one any more. The shape below is kept on the stored personalisation so
// existing drafts still read, and it now always says the same thing.
const NO_AI_LINE: AiLine = {
  status: 'not_offered',
  text: null,
  factIds: [],
  reason: 'Personal lines are switched off — every sentence is the approved copy.',
}

export interface Resolution {
  placeholder: PlaceholderKey
  value: string | null
  source: string
  factId: string | null
}

export interface AiLine {
  status: 'added' | 'none' | 'rejected' | 'not_offered'
  text: string | null
  factIds: string[]
  reason: string | null
}

export interface ComposeResult {
  subject: string | null
  body: string
  resolution: Resolution[]
  aiLine: AiLine
  signalsConsidered: string[]
  signalsUsed: string[]
  unresolved: PlaceholderKey[]
  model: string | null
}

export interface ComposeInput {
  template: StageTemplate
  facts: ProspectFacts
  sender: SenderConfig
  inputs: MessageInputs
  /** The subject the initial email was approved with, for "Re: …" on later stages. */
  initialSubject: string | null
  tenantId: string
  /** False on a plain regenerate with the AI step switched off (tests, fallbacks). */
  personalise?: boolean
}

/** The last segment of a breadcrumb-style category ("Safety > Head Protection > Hard Hats" → "Hard Hats"). */
export function categoryLeaf(category: string | null | undefined): string | null {
  if (!category?.trim()) return null
  const parts = category.split(/\s*(?:>|›|»|\/|\|)\s*/).map((p) => p.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? null
}

/** A term counts as verified only if it appears, word for word, in a verified fact. */
export function appearsIn(term: string, sources: Array<string | null | undefined>): boolean {
  const t = term.trim().toLowerCase().replace(/\s+/g, ' ')
  if (t.length < 3) return false
  return sources.some((s) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').includes(t))
}

/**
 * Checks the one line the model may add.
 *
 * Every cited fact must exist; every number and every capitalised name in the
 * line must appear in those facts (or be the company or the person being
 * written to); the claim guard must pass. Anything else is dropped.
 */
export function checkLine(
  line: { text: string; factIds: string[] },
  facts: Fact[],
  allowedNames: string[],
): { ok: true } | { ok: false; reason: string } {
  const text = line.text.trim()
  if (!text) return { ok: false, reason: 'Empty line.' }
  if (text.length > 240) return { ok: false, reason: 'Longer than one short sentence.' }
  if ((text.match(/[.!?](\s|$)/g) ?? []).length > 2) return { ok: false, reason: 'More than two sentences.' }
  if (/\[[^\]]+\]/.test(text)) return { ok: false, reason: 'Contains a placeholder.' }

  const cited = line.factIds.map((id) => facts.find((f) => f.id === id))
  if (cited.length === 0) return { ok: false, reason: 'Cites no fact.' }
  if (cited.some((f) => !f)) return { ok: false, reason: 'Cites a fact that was not supplied.' }
  const citedText = [...cited.map((f) => `${f!.label} ${f!.value}`), ...allowedNames].join(' \n ').toLowerCase()

  for (const n of text.match(/\d[\d,.]*/g) ?? []) {
    if (!citedText.includes(n.replace(/[.,]$/, '').toLowerCase())) return { ok: false, reason: `States "${n}", which the cited facts do not.` }
  }
  // Capitalised words after the first word of each sentence are names, brands
  // or products: each must come from the cited facts.
  const sentences = text.split(/(?<=[.!?])\s+/)
  for (const s of sentences) {
    const words = s.split(/\s+/).slice(1)
    for (const raw of words) {
      const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      if (!w || !/^[A-Z]/.test(w) || w === 'I') continue
      if (!citedText.includes(w.toLowerCase())) return { ok: false, reason: `Names "${w}", which the cited facts do not.` }
    }
  }
  const claims = findUnsupportedClaims(text)
  if (claims.length) return { ok: false, reason: `Claim guard: ${claims[0]!.why}` }
  return { ok: true }
}

export async function composeStage(input: ComposeInput): Promise<ComposeResult> {
  const { template, facts, sender, inputs } = input
  const used = new Set([...placeholdersIn(template.subject), ...placeholdersIn(template.body)])
  const resolution: Resolution[] = []

  // No model is called: the email is the approved copy with its placeholders
  // filled, and nothing else (2026-10-07).
  const aiLine: AiLine = NO_AI_LINE
  const model: string | null = null

  // ── 1. Fill every placeholder from a verified source ───────────────────
  const values: PlaceholderValues = {}
  const set = (key: PlaceholderKey, value: string | null, source: string, factId: string | null = null) => {
    if (!used.has(key)) return
    values[key] = value
    resolution.push({ placeholder: key, value: value?.trim() ? value.trim() : null, source: value?.trim() ? source : 'Not available — Sales to fill', factId })
  }

  const company = companyDisplayName(facts.companyName)
  set('name', inputs.name?.trim() || firstName(facts.decisionMaker?.fullName), inputs.name?.trim() ? 'Entered by Sales' : 'Decision Makers', inputs.name?.trim() ? null : 'dm.name')
  set('company', company, 'Company record', 'company.name')
  set('companyOrProduct', company, 'Company record', 'company.name')

  const leaf = categoryLeaf(facts.product?.category)
  // The product's own name, exactly as its product page states it.
  if (inputs.product?.trim()) set('product', inputs.product, 'Entered by Sales')
  else set('product', facts.product?.name ?? null, 'Product name as the company’s product page states it', facts.product ? 'product.name' : null)

  if (inputs.productCategory?.trim()) set('productCategory', inputs.productCategory, 'Entered by Sales')
  else set('productCategory', leaf, 'Product category from the analysed product page', leaf ? 'product.category' : null)

  set('clientCompanyName', inputs.clientCompanyName ?? null, 'Entered by Sales')
  const skus = inputs.skus ?? []
  ;(['sku1', 'sku2', 'sku3', 'sku4', 'sku5'] as const).forEach((k, i) => set(k, skus[i] ?? null, 'Entered by Sales'))
  const x = typeof inputs.xOf5 === 'number' ? inputs.xOf5 : null
  set('xOf5Recommended', x === null ? null : `${x} of 5 went from not recommended to appearing in the AI answer`, 'Entered by Sales (from the report)')
  set('xOf5NotRecommended', x === null ? null : `${x} of 5 were not recommended by any of the four engines`, 'Entered by Sales (from the report)')
  set('senderFirstName', sender.firstName || null, 'The person who started this outreach (their NXT Sales login)')
  set('senderCompany', sender.companyName || null, 'Settings → Outreach sender')

  // NO PRODUCT URL IN AN EMAIL, EVER (2026-09-30).
  //
  // Versions 1–3 used to end with "For reference, this is the product page I
  // checked: [Product page URL]". Sales asked for it to go, so the line is
  // taken out of every email rather than filled. That also closes the last
  // route by which a wrong or stale link could reach a customer.
  let approvedBody = template.body
  if (used.has('productPageUrl')) {
    approvedBody = withoutProductPageLine(approvedBody)
    resolution.push({
      placeholder: 'productPageUrl',
      value: null,
      source: 'The product page line is not included in any email.',
      factId: null,
    })
  }

  // The approved copy with its placeholders filled, and nothing inserted into
  // it. Under the sign-off (the sender's name), the sender's own email —
  // the person who sends it (2026-10-07). Nothing else is added.
  let body = fill(approvedBody, values)
  if (sender.email.trim()) body = `${body}\n${sender.email.trim()}`

  const subject = template.subject
    ? fill(template.subject, values)
    : input.initialSubject
      ? `Re: ${input.initialSubject.replace(/^re:\s*/i, '')}`
      : null

  const signalsConsidered = facts.signals.map((s) => s.id)
  // Signals are shown to a reviewer as context. None of them reaches the email
  // now that there is no written line for one to appear in.
  const signalsUsed: string[] = []

  return {
    subject,
    body,
    resolution,
    aiLine,
    signalsConsidered,
    signalsUsed,
    unresolved: [...new Set([...findUnresolved(subject), ...findUnresolved(body)])],
    model,
  }
}

/**
 * The placeholder values that come from what Sales typed in. Used when Sales
 * enters a value after the draft was prepared: the value fills the token
 * still visible in the (possibly edited) draft, and nothing else changes.
 */
export function valuesFromInputs(inputs: MessageInputs): PlaceholderValues {
  const v: PlaceholderValues = {}
  if (inputs.name?.trim()) v.name = inputs.name
  if (inputs.product?.trim()) v.product = inputs.product
  if (inputs.productCategory?.trim()) v.productCategory = inputs.productCategory
  if (inputs.clientCompanyName?.trim()) v.clientCompanyName = inputs.clientCompanyName
  const skus = inputs.skus ?? []
  ;(['sku1', 'sku2', 'sku3', 'sku4', 'sku5'] as const).forEach((k, i) => {
    if (skus[i]?.trim()) v[k] = skus[i]
  })
  if (typeof inputs.xOf5 === 'number') {
    v.xOf5Recommended = `${inputs.xOf5} of 5 went from not recommended to appearing in the AI answer`
    v.xOf5NotRecommended = `${inputs.xOf5} of 5 were not recommended by any of the four engines`
  }
  return v
}

/** The approved copy without the product page line, as it was before the line was added. */
export function withoutProductPageLine(body: string): string {
  return body.replace(`\n\n${PRODUCT_PAGE_LINE}`, '').replace(PRODUCT_PAGE_LINE, '').replace(/\n{3,}/g, '\n\n')
}

/** Removes the expo paragraph from a 2.1 draft — only when Sales asks, and logged by the caller. */
export function withoutExpoParagraph(body: string): string {
  const start = body.indexOf('One more thing, in case timing works better in person:')
  const endMarker = 'the reports coming regardless.'
  const end = body.indexOf(endMarker)
  if (start < 0 || end < 0) return body
  return `${body.slice(0, start).trimEnd()}\n\n${body.slice(end + endMarker.length).trimStart()}`.replace(/\n{3,}/g, '\n\n')
}

export { EXPO }
