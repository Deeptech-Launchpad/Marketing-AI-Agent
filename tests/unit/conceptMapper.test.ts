import { describe, expect, it } from 'vitest'
import { mapConceptToIndustries } from '../../src/campaign/conceptMapper.js'
import type { LlmPort } from '../../src/llm/llmPort.js'

// The mapper turns what the USER asked for into values the CRM actually holds.
// Its contract is: never invent a value, and never quietly widen a concept that
// does not map cleanly.

const VOCAB = [
  'Construction, Building Materials',
  'Plumbing & PVF (Pipe, Valve, Fitting)',
  'Electrical Supplies & Lighting',
  'Fasteners & Hardwares',
  'Safety & PPE',
  'Janitorial & Sanitation Supplies',
]

function stubLlm(data: unknown): LlmPort {
  return {
    name: 'stub',
    generate: async () => ({
      data,
      text: JSON.stringify(data),
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, hasUsageData: false },
      model: 'stub',
      modelRequested: 'stub',
      fellBack: false,
      costUsd: 0,
      priced: false,
      latencyMs: 0,
    }),
    embed: async () => ({
      vectors: [],
      model: 'stub',
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, hasUsageData: false },
    }),
    health: async () => ({ ok: true }),
  } as unknown as LlmPort
}

const run = (data: unknown, concept = 'infrastructure', vocabulary = VOCAB) =>
  mapConceptToIndustries({ concept, vocabulary, llm: stubLlm(data), tenantId: 't1' })

describe('concept mapping — resolved', () => {
  it('applies direct matches and withholds adjacent ones', async () => {
    const m = await run({
      direct: [
        { value: 'Construction, Building Materials', reason: 'core infrastructure supply' },
        { value: 'Plumbing & PVF (Pipe, Valve, Fitting)', reason: 'infrastructure piping' },
      ],
      related: [{ value: 'Safety & PPE', reason: 'used on infrastructure sites' }],
      interpretation: 'Physical built-environment supply.',
    })

    expect(m.status).toBe('resolved')
    expect(m.applied).toEqual(['Construction, Building Materials', 'Plumbing & PVF (Pipe, Valve, Fitting)'])
    // Adjacent values are identified but NOT silently folded into the audience.
    expect(m.applied).not.toContain('Safety & PPE')
    expect(m.requiresApproval).toBe(false)
    expect(m.note).toMatch(/adjacent value\(s\) were identified but NOT applied/i)
  })
})

describe('concept mapping — ambiguous', () => {
  it('flags for approval and never presents a loose match as settled', async () => {
    const m = await run({
      direct: [],
      related: [
        { value: 'Fasteners & Hardwares', reason: 'sometimes used in infrastructure' },
        { value: 'Safety & PPE', reason: 'site equipment' },
      ],
      interpretation: 'No clean match; adjacent categories only.',
    })

    expect(m.status).toBe('ambiguous')
    expect(m.requiresApproval).toBe(true)
    expect(m.applied).toEqual(['Fasteners & Hardwares', 'Safety & PPE'])
    expect(m.note).toMatch(/does not map cleanly/i)
    expect(m.note).toMatch(/REQUIRE APPROVAL/)
  })
})

describe('concept mapping — unmapped', () => {
  it('applies no filter rather than stretching to the nearest value', async () => {
    const m = await run(
      { direct: [], related: [], interpretation: 'Nothing in this vocabulary relates to veterinary care.' },
      'veterinary clinics',
    )

    expect(m.status).toBe('unmapped')
    expect(m.applied).toEqual([])
    expect(m.requiresApproval).toBe(true)
    expect(m.note).toMatch(/could not be mapped/i)
    // The note must not present running without a filter as acceptable.
    expect(m.note).not.toMatch(/No industry filter was applied/i)
    expect(m.note).toMatch(/do not run the audience without one/i)
  })

  it('is unmapped when every proposed value is absent from the CRM', async () => {
    const m = await run(
      { direct: [{ value: 'Online Catalogues', reason: 'invented' }], related: [], interpretation: 'x' },
      'companies with online catalogues',
    )
    expect(m.status).toBe('unmapped')
    expect(m.applied).toEqual([])
    expect(m.rejected).toEqual(['Online Catalogues'])
  })

  it('reports an empty CRM vocabulary instead of calling the model', async () => {
    const m = await run({ direct: [], related: [], interpretation: '' }, 'infrastructure', [])
    expect(m.status).toBe('unmapped')
    expect(m.vocabularySize).toBe(0)
    expect(m.note).toMatch(/no industry vocabulary/i)
  })
})

describe('concept mapping — vocabulary enforcement', () => {
  it('discards values the CRM does not have, and records them', async () => {
    const m = await run({
      direct: [
        { value: 'Construction, Building Materials', reason: 'real value' },
        { value: 'Infrastructure & Civil Engineering', reason: 'INVENTED — not in the CRM' },
      ],
      related: [],
      interpretation: 'x',
    })

    // A hallucinated value matches nothing and would produce an empty audience
    // that looks like a real one, so it is dropped and reported.
    expect(m.applied).toEqual(['Construction, Building Materials'])
    expect(m.rejected).toEqual(['Infrastructure & Civil Engineering'])
  })

  it('does not list the same value as both direct and related', async () => {
    const m = await run({
      direct: [{ value: 'Safety & PPE', reason: 'a' }],
      related: [{ value: 'Safety & PPE', reason: 'b' }],
      interpretation: 'x',
    })
    expect(m.direct).toHaveLength(1)
    expect(m.related).toHaveLength(0)
  })
})
