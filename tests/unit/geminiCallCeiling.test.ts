import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/config/env.js'
import { GeminiCallCeilingError, geminiCallStats, geminiCeilingExhausted, reserveGeminiCall, resetGeminiCallStatsForTests } from '../../src/llm/gemini/callCeiling.js'

// A HARD CEILING ON GEMINI CALLS: counted before the request, and the call
// after the ceiling is never sent.

vi.mock('../../src/platform/db.js', () => ({ prisma: {}, newId: () => 'id' }))
const { GeminiGateway } = await import('../../src/llm/gemini/geminiGateway.js')

const saved = env.GEMINI_CALL_CEILING
beforeEach(() => resetGeminiCallStatsForTests())
afterEach(() => {
  env.GEMINI_CALL_CEILING = saved
  resetGeminiCallStatsForTests()
  vi.unstubAllGlobals()
})

describe('the ceiling', () => {
  it('allows exactly the ceiling, then refuses every further call and counts the refusals', () => {
    env.GEMINI_CALL_CEILING = 3
    for (let i = 0; i < 3; i++) expect(() => reserveGeminiCall('generateContent')).not.toThrow()
    expect(geminiCeilingExhausted()).toBe(true)
    for (let i = 0; i < 4; i++) expect(() => reserveGeminiCall('generateContent')).toThrow(GeminiCallCeilingError)
    expect(geminiCallStats()).toMatchObject({ ceiling: 3, attempted: 3, blocked: 4, exhausted: true })
  })

  it('counts by kind, and 0 means no ceiling', () => {
    env.GEMINI_CALL_CEILING = 0
    for (let i = 0; i < 200; i++) reserveGeminiCall(i % 2 ? 'generateContent' : 'embedContent')
    expect(geminiCeilingExhausted()).toBe(false)
    expect(geminiCallStats()).toMatchObject({ attempted: 200, blocked: 0, byKind: { generateContent: 100, embedContent: 100 } })
  })

  it('the 61st call of a 60 ceiling is the first one that is refused', () => {
    env.GEMINI_CALL_CEILING = 60
    for (let i = 0; i < 60; i++) reserveGeminiCall('x')
    expect(geminiCallStats().blocked).toBe(0)
    expect(() => reserveGeminiCall('x')).toThrow(/ceiling \(60\) was reached; this call was not sent/)
  })
})

describe('through the gateway: a refused call never reaches the network', () => {
  it('health() makes the first N requests and then none', async () => {
    env.GEMINI_CALL_CEILING = 3
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const g = new GeminiGateway()
    for (let i = 0; i < 3; i++) expect((await g.health()).ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const refused = await g.health()
    expect(refused.ok).toBe(false)
    expect(refused.detail).toMatch(/ceiling/)
    expect(fetchMock).toHaveBeenCalledTimes(3) // the fourth was never sent
    expect(geminiCallStats()).toMatchObject({ attempted: 3, blocked: 1 })
  })

  it('every fetch() in the gateway is preceded by a reservation (source scan)', () => {
    const src = readFileSync(path.resolve('src/llm/gemini/geminiGateway.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const fetches = [...src.matchAll(/(^|[^A-Za-z_.])fetch\(/g)].map((m) => m.index!)
    const reserves = [...src.matchAll(/reserveGeminiCall(?:Async)?\(/g)].map((m) => m.index!)
    expect(fetches.length).toBeGreaterThan(0)
    expect(reserves.length).toBe(fetches.length)
    fetches.forEach((at, i) => {
      expect(reserves[i]!).toBeLessThan(at) // reserved first
      expect(at - reserves[i]!).toBeLessThan(400) // ...in the same function, immediately before
    })
  })
})
