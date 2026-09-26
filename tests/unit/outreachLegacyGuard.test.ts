import { describe, expect, it, vi } from 'vitest'

// The legacy executor behind /release, /execute and the outreach worker must
// never act on a Sales-sequence email: those are sent by a person, by hand.

const update = vi.fn()
const findUnique = vi.fn()
vi.mock('../../src/platform/db.js', () => ({
  prisma: new Proxy({}, { get: () => ({ findUnique, update, updateMany: update, create: update, findFirst: findUnique, findMany: vi.fn(async () => []) }) }),
  newId: () => 'id',
}))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

const generate = vi.fn()
vi.mock('../../src/llm/index.js', () => ({ getLlm: () => ({ generate }) }))

const { executeAction } = await import('../../src/outreach/engine.js')
const { generateCallPoints } = await import('../../src/outreach/salesSequence/callPoints.js')

describe('call talking points', () => {
  const facts = {
    companyName: 'Acme Safety',
    companySummary: null,
    decisionMaker: { fullName: 'Jane Smith', title: 'Head of eCommerce' },
    product: { name: 'Titan Hard Hat X200', url: null, gaps: [] },
    signals: [],
    facts: [
      { id: 'company.name', label: 'Company', value: 'Acme Safety', source: 'NXT Sales', sourceUrl: null },
      { id: 'dm.name', label: 'Decision maker', value: 'Jane Smith', source: 'Decision Makers', sourceUrl: null },
      { id: 'product.name', label: 'Product analysed', value: 'Titan Hard Hat X200', source: 'Prospects', sourceUrl: null },
    ],
  } as never

  it('keeps a cited point and drops one that cites nothing or adds a number', async () => {
    generate.mockResolvedValueOnce({
      model: 'm',
      data: {
        points: [
          { text: 'Mention the Titan Hard Hat X200 page we reviewed.', factIds: ['product.name'] },
          { text: 'They grew revenue 40% last year.', factIds: [] },
        ],
      },
    })
    const r = await generateCallPoints({ facts, historyLines: [], currentStage: 'initial', tenantId: 't1' })
    expect(r.points.map((p) => p.text)).toEqual(['Mention the Titan Hard Hat X200 page we reviewed.'])
    expect(r.dropped).toHaveLength(1)
  })

  it('falls back to points built from the facts when the model fails', async () => {
    generate.mockRejectedValueOnce(new Error('down'))
    const r = await generateCallPoints({ facts, historyLines: [], currentStage: 'initial', tenantId: 't1' })
    expect(r.model).toBeNull()
    expect(r.points.every((p) => p.source === 'facts')).toBe(true)
    expect(r.points[0]!.text).toBe('Ask for Jane Smith (Head of eCommerce).')
  })
})

describe('legacy executor guard', () => {
  it('refuses an action from the Sales sequence and changes nothing', async () => {
    findUnique.mockResolvedValueOnce({
      id: 'a1',
      status: 'ready_to_send',
      retryCount: 0,
      channel: 'email',
      message: { subject: 'S', body: 'B' },
      campaign: { id: 'c1', flow: 'sales_sequence_v1', status: 'active' },
    })
    const r = await executeAction('a1')
    expect(r).toMatchObject({ actionId: 'a1', status: 'ready_to_send', delivered: false })
    expect(r.reason).toMatch(/sends manually/)
    expect(update).not.toHaveBeenCalled()
  })
})
