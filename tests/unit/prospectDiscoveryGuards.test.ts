import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stage 1 must never widen a search silently. When the target or place cannot
// be matched to CRM values — or the CRM's own value lists cannot be read — the
// search stops with a reason instead of exporting the unfiltered CRM.

type Row = Record<string, unknown>
const rows = new Map<string, Row>()
const db = {
  prospectSearch: {
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    findFirst: vi.fn(async (_args: unknown): Promise<Row | null> => null),
    create: async ({ data }: { data: Row }) => {
      rows.set(String(data.id), { ...data })
      return data
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const next = { ...(rows.get(where.id) ?? {}), ...data }
      rows.set(where.id, next)
      return next
    },
  },
  segment: { create: async () => ({}) },
}
let idSeq = 0
vi.mock('../../src/platform/db.js', () => ({ prisma: db, newId: () => `id_${++idSeq}` }))
vi.mock('../../src/platform/audit.js', () => ({ audit: async () => undefined }))

let parsedObjective: Record<string, unknown>
let mappingReply: Record<string, unknown>
vi.mock('../../src/llm/index.js', () => ({
  getLlm: () => ({
    name: 'stub',
    generate: async ({ promptKey }: { promptKey: string }) => ({
      data: promptKey === 'prospect.parse_objective' ? parsedObjective : mappingReply,
    }),
  }),
}))

let industries: string[] | Error
let countries: string[] | Error
const exportCompanies = vi.fn()
vi.mock('../../src/crm/index.js', () => ({
  getCrm: () => ({
    getDropdownOptions: async (key: string) => {
      const v = key === 'company.industry' ? industries : countries
      if (v instanceof Error) throw v
      return v.map((value) => ({ value, label: value }))
    },
    exportCompanies,
  }),
}))

const resolveAudience = vi.fn(async (_input: Record<string, unknown>) => ({
  snapshotId: 'snap_1',
  totalMatched: 3,
  totalSuppressed: 0,
  totalIncluded: 3,
  truncated: false,
  capApplied: 25,
  sample: [],
}))
vi.mock('../../src/campaign/audienceResolver.js', () => ({ resolveAudience }))

const { runProspectDiscovery, queueProspectSearch } = await import('../../src/prospects/prospectDiscovery.js')

const parse = (over: Record<string, unknown>) => ({
  targetConcept: null,
  geography: [],
  requestedCount: null,
  statedNeedHypothesis: null,
  companyCharacteristics: [],
  includeExistingOpportunities: false,
  ambiguities: [],
  ...over,
})

function seed(objective: string): string {
  const id = `search_${++idSeq}`
  rows.set(id, { id, tenantId: 't1', objective, requestedCount: null, status: 'queued' })
  return id
}

const errorMessage = (id: string) => String((rows.get(id)!.error as { message?: string }).message)

beforeEach(() => {
  rows.clear()
  exportCompanies.mockReset()
  resolveAudience.mockClear()
  db.prospectSearch.findFirst.mockReset()
  db.prospectSearch.findFirst.mockResolvedValue(null)
  industries = ['Veterinary Clinics', 'Marine Equipment', 'Dental Supplies']
  countries = ['NORWAY', 'PORTUGAL', 'ROMANIA']
  mappingReply = { direct: [], related: [], interpretation: 'x' }
})

describe('an unmatched target stops the search instead of returning the whole CRM', () => {
  it('fails with a reason naming the concept (bakery objective)', async () => {
    parsedObjective = parse({ targetConcept: 'artisan bakeries' })
    const id = seed('artisan bakeries with online ordering')
    await runProspectDiscovery(id)

    const row = rows.get(id)!
    expect(row.status).toBe('failed')
    expect(errorMessage(id)).toMatch(/"artisan bakeries" could not be matched/)
    expect(errorMessage(id)).toMatch(/Rephrase/)
    expect(row.mappingStatus).toBe('unmapped')
    expect(resolveAudience).not.toHaveBeenCalled()
    expect(exportCompanies).not.toHaveBeenCalled()
  })

  it('fails when the model only proposes values the CRM does not hold (software objective)', async () => {
    parsedObjective = parse({ targetConcept: 'SaaS vendors' })
    mappingReply = { direct: [{ value: 'Software', reason: 'invented' }], related: [], interpretation: 'x' }
    const id = seed('SaaS vendors in Norway')
    await runProspectDiscovery(id)

    expect(rows.get(id)!.status).toBe('failed')
    expect(errorMessage(id)).toMatch(/"SaaS vendors" could not be matched/)
    expect(resolveAudience).not.toHaveBeenCalled()
  })

  it('fails when the industry list cannot be read, rather than treating it as empty', async () => {
    parsedObjective = parse({ targetConcept: 'marine equipment' })
    industries = new Error('CRM timed out')
    const id = seed('marine equipment dealers')
    await runProspectDiscovery(id)

    expect(rows.get(id)!.status).toBe('failed')
    expect(errorMessage(id)).toMatch(/Could not read the list of industries/)
    expect(errorMessage(id)).toMatch(/CRM timed out/)
    expect(resolveAudience).not.toHaveBeenCalled()
  })

  it('fails when a named place matches no CRM country', async () => {
    parsedObjective = parse({ targetConcept: 'dental supplies', geography: ['Atlantis'] })
    mappingReply = { direct: [{ value: 'Dental Supplies', reason: 'exact' }], related: [], interpretation: 'x' }
    const id = seed('dental suppliers in Atlantis')
    await runProspectDiscovery(id)

    expect(rows.get(id)!.status).toBe('failed')
    expect(errorMessage(id)).toMatch(/"Atlantis" could not be matched to any country/)
    expect(resolveAudience).not.toHaveBeenCalled()
  })

  it('fails when the country list cannot be read and a place was named', async () => {
    parsedObjective = parse({ geography: ['Portugal'] })
    countries = new Error('503')
    const id = seed('any company in Portugal')
    await runProspectDiscovery(id)
    expect(rows.get(id)!.status).toBe('failed')
    expect(errorMessage(id)).toMatch(/Could not read the list of countries/)
  })

  it('still runs a resolvable search, with the filters applied', async () => {
    parsedObjective = parse({ targetConcept: 'dental supplies', geography: ['portugal'] })
    mappingReply = { direct: [{ value: 'Dental Supplies', reason: 'exact' }], related: [], interpretation: 'x' }
    const id = seed('dental suppliers in portugal')
    await runProspectDiscovery(id)

    expect(rows.get(id)!.status).toBe('completed')
    const input = resolveAudience.mock.calls[0]![0] as { query: Record<string, unknown>; includeOpenDeals: boolean }
    expect(input.query.industries).toEqual(['Dental Supplies'])
    expect(input.query.countries).toEqual(['PORTUGAL'])
    expect(input.includeOpenDeals).toBe(false)
  })
})

describe('includeExistingOpportunities reaches the resolver', () => {
  it('passes includeOpenDeals=true and sends no hasDeal filter', async () => {
    parsedObjective = parse({ targetConcept: 'marine equipment', includeExistingOpportunities: true })
    mappingReply = { direct: [{ value: 'Marine Equipment', reason: 'exact' }], related: [], interpretation: 'x' }
    const id = seed('marine equipment companies including existing opportunities')
    await runProspectDiscovery(id)

    const input = resolveAudience.mock.calls[0]![0] as { query: Record<string, unknown>; includeOpenDeals: boolean }
    expect(input.includeOpenDeals).toBe(true)
    expect(input.query).not.toHaveProperty('hasDeal')
  })
})

describe('queueProspectSearch', () => {
  it('marks the search failed and rethrows when enqueue fails', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('queue unavailable')
    })
    await expect(
      queueProspectSearch({ tenantId: 't1', objective: 'marine equipment', requestedByCrmUserId: 'u1', enqueue }),
    ).rejects.toThrow('queue unavailable')

    const [row] = [...rows.values()]
    expect(row!.status).toBe('failed')
    expect(String((row!.error as { message: string }).message)).toMatch(/queue unavailable/)
    expect(row!.finishedAt).toBeInstanceOf(Date)
  })

  it('returns the identical in-flight search instead of creating a duplicate', async () => {
    db.prospectSearch.findFirst.mockResolvedValue({ id: 'existing_1', status: 'running' })
    const enqueue = vi.fn(async () => undefined)
    const r = await queueProspectSearch({
      tenantId: 't1',
      objective: '  dental supplies in Portugal ',
      requestedByCrmUserId: 'u1',
      enqueue,
    })
    expect(r).toEqual({ id: 'existing_1', status: 'running', reused: true })
    expect(enqueue).not.toHaveBeenCalled()
    expect(rows.size).toBe(0)
    const where = (db.prospectSearch.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.objective).toBe('dental supplies in Portugal')
    expect(where.tenantId).toBe('t1')
  })

  it('creates and enqueues when nothing identical is in flight', async () => {
    const enqueue = vi.fn(async () => undefined)
    const r = await queueProspectSearch({
      tenantId: 't1',
      objective: 'veterinary clinics',
      requestedCount: 10,
      requestedByCrmUserId: 'u1',
      enqueue,
    })
    expect(r.reused).toBe(false)
    expect(r.status).toBe('queued')
    expect(enqueue).toHaveBeenCalledWith(r.id)
    expect(rows.get(r.id)!.requestedCount).toBe(10)
  })
})
