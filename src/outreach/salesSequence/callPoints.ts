import { z } from 'zod'
import { getLlm } from '../../llm/index.js'
import { logger } from '../../platform/logger.js'
import { checkLine } from './compose.js'
import type { Fact, ProspectFacts } from './facts.js'

// CALL TALKING POINTS — WHAT TO RAISE, FROM WHAT IS VERIFIED.
//
// When Sales picks up the phone they need a short brief, not another email.
// A model writes a few concise points from the verified facts and the
// outreach so far; each point must cite the facts it rests on and pass the
// same checks as the email's personal line (no number or name the cited facts
// do not contain, claim guard). A point that fails is dropped. If none
// survive — or the model is unavailable — the points are built from the
// facts directly, so the brief is never empty and never invented.
//
// Talking points never replace the approved email copy; they sit beside it.

const Points = z.object({
  points: z
    .array(z.object({ text: z.string(), factIds: z.array(z.string()).max(4) }))
    .max(8)
    .default([]),
})

export interface CallPoint {
  text: string
  factIds: string[]
  source: 'ai' | 'facts'
}

export interface CallPointsResult {
  points: CallPoint[]
  dropped: Array<{ text: string; reason: string }>
  model: string | null
}

/** The outreach so far, as facts a talking point may cite. */
export function historyFacts(lines: string[]): Fact[] {
  return lines.map((value, i) => ({ id: `history.${i + 1}`, label: 'Outreach so far', value, source: 'Outreach history', sourceUrl: null }))
}

/** Points built straight from the facts, used when the model's are unavailable. */
export function factPoints(facts: ProspectFacts, history: Fact[]): CallPoint[] {
  const out: CallPoint[] = []
  const dm = facts.decisionMaker
  if (dm) out.push({ text: `Ask for ${dm.fullName}${dm.title ? ` (${dm.title})` : ''}.`, factIds: ['dm.name'], source: 'facts' })
  if (facts.companySummary) out.push({ text: `What they do: ${facts.companySummary}`, factIds: ['company.summary'], source: 'facts' })
  if (facts.product) {
    out.push({ text: `Product we looked at: ${facts.product.name}${facts.product.url ? ` — ${facts.product.url}` : ''}.`, factIds: ['product.name'], source: 'facts' })
    facts.product.gaps.slice(0, 3).forEach((g, i) => out.push({ text: `Gap on that page: ${g.title} — ${g.detail}`, factIds: [`product.gap.${i + 1}`], source: 'facts' }))
  }
  for (const s of facts.signals.slice(0, 3)) {
    out.push({ text: `Signal (${s.category}${s.observedAt ? `, ${s.observedAt}` : ''}): ${s.summary}`, factIds: [`signal.${s.id}`], source: 'facts' })
  }
  for (const h of history.slice(-3)) out.push({ text: h.value, factIds: [h.id], source: 'facts' })
  return out
}

export async function generateCallPoints(input: {
  facts: ProspectFacts
  historyLines: string[]
  currentStage: string
  tenantId: string
}): Promise<CallPointsResult> {
  const history = historyFacts(input.historyLines)
  const all = [...input.facts.facts, ...history]
  const dropped: CallPointsResult['dropped'] = []
  try {
    const result = await getLlm().generate({
      promptKey: 'outreach.call_talking_points',
      variables: {
        currentStage: input.currentStage,
        facts: all.map((f) => `${f.id} | ${f.label}: ${f.value}`).join('\n') || '(none)',
      },
      schema: Points,
      feature: 'outreach.sales_sequence',
      tenantId: input.tenantId,
    })
    const parsed = Points.safeParse(result.data)
    const allowed = [input.facts.companyName, input.facts.decisionMaker?.fullName ?? '']
    const points: CallPoint[] = []
    for (const p of parsed.success ? parsed.data.points : []) {
      const check = checkLine({ text: p.text, factIds: p.factIds }, all, allowed)
      if (check.ok) points.push({ text: p.text.trim(), factIds: p.factIds, source: 'ai' })
      else dropped.push({ text: p.text, reason: check.reason })
    }
    if (points.length) return { points, dropped, model: result.model }
    return { points: factPoints(input.facts, history), dropped, model: result.model }
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'call talking points: model unavailable; built from the facts')
    return { points: factPoints(input.facts, history), dropped, model: null }
  }
}
