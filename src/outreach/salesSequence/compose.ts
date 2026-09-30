import { z } from 'zod'
import { getLlm } from '../../llm/index.js'
import { logger } from '../../platform/logger.js'
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
//   2. CHOOSE THE PRODUCT WORD. A model picks a short, natural term for
//      [Product] — "safety helmets" rather than "DEWALT DPG22 Type II Class E
//      Safety Helmet" — and that term must appear WORD FOR WORD in the
//      verified product facts or it is thrown away. It writes nothing.
//
// NO AI-WRITTEN SENTENCE EVER REACHES THE EMAIL (2026-09-30).
//
// The model used to be allowed one personal line, inserted between two
// approved paragraphs and marked as AI-added. Sales asked for it to go: an
// outreach email is now the approved copy and nothing else. Every sentence a
// customer reads was written by Sales; the model's only remaining job is to
// decide which of the company's own words fills a placeholder.

// Sales asked for the AI's personal line to be removed, so there is no slot
// for one any more. The shape below is kept on the stored personalisation so
// existing drafts still read, and it now always says the same thing.
const NO_AI_LINE: AiLine = {
  status: 'not_offered',
  text: null,
  factIds: [],
  reason: 'Personal lines are switched off — every sentence is the approved copy.',
}

const PersonalizeOut = z.object({
  productTerm: z.string().nullable().optional(),
  productCategoryTerm: z.string().nullable().optional(),
  line: z
    .object({ text: z.string(), factIds: z.array(z.string()).max(4) })
    .nullable()
    .optional(),
})

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

function productSources(facts: ProspectFacts): string[] {
  return [facts.product?.name, facts.product?.category].filter((s): s is string => Boolean(s))
}

export async function composeStage(input: ComposeInput): Promise<ComposeResult> {
  const { template, facts, sender, inputs } = input
  const used = new Set([...placeholdersIn(template.subject), ...placeholdersIn(template.body)])
  const resolution: Resolution[] = []
  let model: string | null = null

  // ── 2 (first, because 1 needs its product term). Choosing the word. ────
  let aiTerm: string | null = null
  let aiCategory: string | null = null
  const aiLine: AiLine = NO_AI_LINE
  const wantsProduct = used.has('product') || used.has('productCategory')
  // Only worth a model call when the email actually has a product placeholder
  // AND there is a verified product for a term to come from.
  const personalise = input.personalise !== false && wantsProduct && Boolean(facts.product)
  if (personalise) {
    try {
      const result = await getLlm().generate({
        promptKey: 'outreach.personalize_stage',
        variables: {
          stageLabel: `${template.pdfRef} ${template.label}`,
          approvedBody: template.body,
          // Never. The model chooses a word; it does not write a sentence.
          allowLine: 'no',
          productName: facts.product?.name ?? '(none)',
          productCategory: facts.product?.category ?? '(none)',
          facts: facts.facts.map((f) => `${f.id} | ${f.label}: ${f.value}`).join('\n') || '(none)',
        },
        schema: PersonalizeOut,
        feature: 'outreach.sales_sequence',
        tenantId: input.tenantId,
      })
      model = result.model
      const out = PersonalizeOut.safeParse(result.data)
      if (out.success) {
        const sources = productSources(facts)
        // A term is taken only if the company's own verified product data
        // contains it word for word. Anything the model made up is dropped.
        if (out.data.productTerm && appearsIn(out.data.productTerm, sources)) aiTerm = out.data.productTerm.trim()
        if (out.data.productCategoryTerm && appearsIn(out.data.productCategoryTerm, sources)) aiCategory = out.data.productCategoryTerm.trim()
        // out.data.line is ignored on purpose: nothing the model writes goes
        // into an email any more.
      }
    } catch (err) {
      // Nothing is lost that a person cannot supply: [Product] simply stays
      // visible and unfilled, and Sales types the word before approving.
      logger.info({ err: (err as Error).message, stage: template.key }, 'product term step failed; the approved copy is filled without it')
    }
  }

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
  if (inputs.product?.trim()) set('product', inputs.product, 'Entered by Sales')
  else if (aiTerm) set('product', aiTerm, 'Product page analysed in Prospects (term chosen by AI, checked word for word)', 'product.name')
  else if (leaf) set('product', leaf, 'Product category from the analysed product page', 'product.category')
  else set('product', facts.product?.name ?? null, 'Product page analysed in Prospects', facts.product ? 'product.name' : null)

  if (inputs.productCategory?.trim()) set('productCategory', inputs.productCategory, 'Entered by Sales')
  else if (aiCategory) set('productCategory', aiCategory, 'Product page analysed in Prospects (term chosen by AI, checked word for word)', 'product.category')
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
  // it. The signature is the sender's own, from Settings.
  let body = fill(approvedBody, values)
  if (sender.signature.trim()) body = `${body}\n${sender.signature.trim()}`

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
