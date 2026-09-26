import { describe, expect, it } from 'vitest'
import { parseProspectObjective, resolveGeography } from '../../src/prospects/objectiveParser.js'
import type { LlmPort } from '../../src/llm/llmPort.js'

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

describe('prospecting objective — filter vs hypothesis', () => {
  it('keeps a stated need OUT of the targeting concept', async () => {
    // "Find 100 manufacturing companies that may need product-data improvement"
    const parsed = await parseProspectObjective({
      objective: 'Find 100 manufacturing companies that may need product-data improvement',
      llm: stubLlm({
        targetConcept: 'manufacturing',
        geography: [],
        requestedCount: 100,
        statedNeedHypothesis: 'may need product-data improvement',
        companyCharacteristics: [],
        includeExistingOpportunities: false,
        ambiguities: ['geography'],
      }),
      tenantId: 't1',
    })

    expect(parsed.targetConcept).toBe('manufacturing')
    expect(parsed.requestedCount).toBe(100)
    // The hypothesis is captured separately and must never leak into the
    // concept that drives filtering.
    expect(parsed.statedNeedHypothesis).toBe('may need product-data improvement')
    expect(parsed.targetConcept).not.toContain('product-data')
  })

  it('accepts a bare concept with no count and no hypothesis', async () => {
    const parsed = await parseProspectObjective({
      objective: 'Find infrastructure prospects',
      llm: stubLlm({
        targetConcept: 'infrastructure',
        geography: [],
        requestedCount: null,
        statedNeedHypothesis: null,
        companyCharacteristics: [],
        includeExistingOpportunities: false,
        ambiguities: ['geography', 'company size', 'volume'],
      }),
      tenantId: 't1',
    })

    expect(parsed.targetConcept).toBe('infrastructure')
    expect(parsed.requestedCount).toBeNull()
    expect(parsed.statedNeedHypothesis).toBeNull()
    expect(parsed.ambiguities.length).toBeGreaterThan(0)
  })

  it('rejects a malformed parse rather than coercing it', async () => {
    await expect(
      parseProspectObjective({
        objective: 'anything',
        // requestedCount must be a positive integer or null, never a string.
        llm: stubLlm({
          targetConcept: 'x',
          geography: [],
          requestedCount: 'one hundred',
          statedNeedHypothesis: null,
          companyCharacteristics: [],
          includeExistingOpportunities: false,
          ambiguities: [],
        }),
        tenantId: 't1',
      }),
    ).rejects.toThrow()
  })
})

describe('resolveGeography', () => {
  const VOCAB = ['UNITED STATES', 'UNITED KINGDOM', 'IRELAND', 'AUSTRALIA', 'MALTA']

  it('matches case-insensitively', () => {
    // The CRM stores "UNITED STATES"; a user writes "United States".
    expect(resolveGeography(['united states'], VOCAB).matched).toEqual(['UNITED STATES'])
    expect(resolveGeography(['Ireland'], VOCAB).matched).toEqual(['IRELAND'])
  })

  it('resolves common aliases to the one country they name', () => {
    expect(resolveGeography(['US'], VOCAB).matched).toEqual(['UNITED STATES'])
    expect(resolveGeography(['U.S.A.'], VOCAB).matched).toEqual(['UNITED STATES'])
    expect(resolveGeography(['UK'], VOCAB).matched).toEqual(['UNITED KINGDOM'])
    expect(resolveGeography(['Great Britain'], VOCAB).matched).toEqual(['UNITED KINGDOM'])
    expect(resolveGeography(['UAE'], ['UNITED ARAB EMIRATES', 'OMAN'])).toEqual({
      matched: ['UNITED ARAB EMIRATES'],
      unmatched: [],
    })
  })

  it('never matches a country by substring', () => {
    const WIDE = ['UNITED STATES', 'AUSTRALIA', 'RUSSIA', 'CYPRUS', 'ROMANIA', 'OMAN', 'INDIA', 'BRITISH INDIAN OCEAN TERRITORY']
    expect(resolveGeography(['US'], WIDE).matched).toEqual(['UNITED STATES'])
    expect(resolveGeography(['Oman'], WIDE).matched).toEqual(['OMAN'])
    expect(resolveGeography(['India'], WIDE).matched).toEqual(['INDIA'])
    // A partial name is not a country: reported unmatched, not widened.
    expect(resolveGeography(['Austral'], WIDE)).toEqual({ matched: [], unmatched: ['Austral'] })
  })

  it('handles accents, punctuation and a leading "the"', () => {
    expect(resolveGeography(['Côte d’Ivoire'], ["COTE D'IVOIRE"]).matched).toEqual(["COTE D'IVOIRE"])
    expect(resolveGeography(['the Netherlands'], ['NETHERLANDS']).matched).toEqual(['NETHERLANDS'])
    expect(resolveGeography(['Holland'], ['Netherlands', 'Norway']).matched).toEqual(['Netherlands'])
  })

  it('reports an unmatched term instead of dropping it', () => {
    // A silently ignored geography would widen the audience unnoticed.
    const r = resolveGeography(['Ireland', 'Atlantis'], VOCAB)
    expect(r.matched).toEqual(['IRELAND'])
    expect(r.unmatched).toEqual(['Atlantis'])
  })

  it('de-duplicates when two terms resolve to the same value', () => {
    expect(resolveGeography(['UK', 'united kingdom'], VOCAB).matched).toEqual(['UNITED KINGDOM'])
  })

  it('returns nothing for an empty request', () => {
    expect(resolveGeography([], VOCAB)).toEqual({ matched: [], unmatched: [] })
    expect(resolveGeography(['   '], VOCAB)).toEqual({ matched: [], unmatched: [] })
  })
})
