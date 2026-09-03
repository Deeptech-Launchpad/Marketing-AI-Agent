import { beforeEach, describe, expect, it, vi } from 'vitest'

// PRODUCTION CLOSURE — REGION-WISE round-robin owner assignment.
//
// The confirmed rule: a qualified lead is assigned by finding the sales group
// for the company's region, then rotating within that group. Explicitly not a
// global rotation.
//
// The rule this file protects is unchanged from Task #985: NEVER GUESS A
// SALESPERSON. Region-wise rotation adds a way to choose between named,
// verified reps who are responsible for that region; it does not add a way to
// invent one. A region with no configured group therefore ends in "nobody",
// which several tests below assert directly — that outcome is the rule
// working, not a gap in it.

const groupBy = vi.fn()
vi.mock('../../src/platform/db.js', () => ({
  prisma: { salesQualification: { groupBy: (...a: unknown[]) => groupBy(...a) } },
}))

const getCompany = vi.fn()
const listUsers = vi.fn()
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ getCompany, listUsers }) }))

const envMock: Record<string, unknown> = {
  SALES_REGION_ROUND_ROBIN: '',
  SALES_FALLBACK_OWNER_CRM_USER_ID: '',
  SALES_QUEUE_NAME: '',
}
vi.mock('../../src/config/env.js', async (orig) => {
  const actual = (await orig()) as { env: Record<string, unknown> }
  return { env: new Proxy(envMock, { get: (t, k: string) => (k in t ? t[k] : actual.env[k]) }) }
})

const { SalesOwnerResolver } = await import('../../src/salesqualification/providers/ownerResolver.js')

// The two real reps the Team Answer names, with their real NXT Sales ids.
const MANOJ = { id: 'cmrela8ow0001mgntynarnkw8', name: 'Manoj s', email: 'manoj@altiusnxt.com' }
const PRIYA = { id: 'cmreneaz8006313psmiykgmf0', name: 'Mohana Priya', email: 'mohanapriya@altiusnxt.com' }
const OTHER = { id: 'cmrbxjemj000d11g6nwg239xz', name: 'Govind', email: 'govind@altiusnxt.com' }

beforeEach(() => {
  vi.clearAllMocks()
  envMock.SALES_REGION_ROUND_ROBIN = ''
  envMock.SALES_FALLBACK_OWNER_CRM_USER_ID = ''
  envMock.SALES_QUEUE_NAME = ''
  getCompany.mockResolvedValue({ id: 'co_1', name: '1st Ayd', ownerId: null, country: 'USA' })
  listUsers.mockResolvedValue([MANOJ, PRIYA, OTHER])
  groupBy.mockResolvedValue([])
})

const resolve = () => new SalesOwnerResolver().resolve('co_1')

describe('an existing account owner always wins', () => {
  it('never rotates past the company\'s own owner', async () => {
    getCompany.mockResolvedValue({ id: 'co_1', name: '1st Ayd', ownerId: OTHER.id, country: 'USA' })
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id},${PRIYA.id}`
    const r = await resolve()
    expect(r.source).toBe('crm_account_owner')
    expect(r.crmUserId).toBe(OTHER.id)
    expect(groupBy).not.toHaveBeenCalled()
  })
})

describe('region-wise round-robin', () => {
  beforeEach(() => {
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id},${PRIYA.id}`
  })

  it('assigns to the rep carrying the fewest open leads', async () => {
    groupBy.mockResolvedValue([
      { ownerCrmUserId: MANOJ.id, _count: { _all: 4 } },
      { ownerCrmUserId: PRIYA.id, _count: { _all: 1 } },
    ])
    const r = await resolve()
    expect(r.source).toBe('round_robin')
    expect(r.crmUserId).toBe(PRIYA.id)
    expect(r.name).toBe('Mohana Priya')
  })

  it('rotates to the other rep as load shifts', async () => {
    groupBy.mockResolvedValue([
      { ownerCrmUserId: MANOJ.id, _count: { _all: 1 } },
      { ownerCrmUserId: PRIYA.id, _count: { _all: 6 } },
    ])
    expect((await resolve()).crmUserId).toBe(MANOJ.id)
  })

  it('breaks a tie on the configured order, so it is deterministic', async () => {
    groupBy.mockResolvedValue([
      { ownerCrmUserId: MANOJ.id, _count: { _all: 3 } },
      { ownerCrmUserId: PRIYA.id, _count: { _all: 3 } },
    ])
    const a = await resolve()
    const b = await resolve()
    expect(a.crmUserId).toBe(MANOJ.id)
    expect(b.crmUserId).toBe(a.crmUserId)
  })

  it('counts a rep with no open leads as zero, not as missing', async () => {
    groupBy.mockResolvedValue([{ ownerCrmUserId: MANOJ.id, _count: { _all: 2 } }])
    expect((await resolve()).crmUserId).toBe(PRIYA.id)
  })

  it('states in plain words how the rep was chosen', async () => {
    const r = await resolve()
    expect(r.reason).toMatch(/round-robin within the "US" sales group \(2 rep\(s\)\)/)
    expect(r.reason).toContain('1st Ayd')
  })
})

describe('it refuses rather than guesses', () => {
  it('assigns nobody when a configured id is not a current user', async () => {
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id},not_a_real_user`
    const r = await resolve()
    expect(r.resolved).toBe(false)
    expect(r.crmUserId).toBeNull()
    expect(r.reason).toMatch(/do not match a current NXT Sales user/)
  })

  it('refuses the WHOLE rotation, not just the bad entry', async () => {
    // Assigning every lead to Manoj because Priya's id was mistyped would look
    // like it worked, and would quietly double one person's workload.
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id},typo_id`
    const r = await resolve()
    expect(r.crmUserId).not.toBe(MANOJ.id)
    expect(r.source).toBe('none')
  })

  it('leaves the lead unassigned when no rotation is configured', async () => {
    const r = await resolve()
    expect(r.resolved).toBe(false)
    expect(r.source).toBe('none')
  })

  it('still falls through to the configured fallback when there is no rotation', async () => {
    envMock.SALES_FALLBACK_OWNER_CRM_USER_ID = OTHER.id
    const r = await resolve()
    expect(r.source).toBe('configured_fallback')
    expect(r.crmUserId).toBe(OTHER.id)
  })

  it('leaves a lead unassigned when its region has no configured group', async () => {
    // The confirmed rule. Routing a South African lead to the US group would
    // be the region-to-user mapping this platform must not invent.
    getCompany.mockResolvedValue({ id: 'co_1', name: 'Acme ZA', ownerId: null, country: 'South Africa' })
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id},${PRIYA.id}`
    const r = await resolve()
    expect(r.resolved).toBe(false)
    expect(r.crmUserId).toBeNull()
    expect(r.reason).toMatch(/No sales group is configured for region "ZA"/)
  })

  it('leaves a lead unassigned when the company has no region at all', async () => {
    getCompany.mockResolvedValue({ id: 'co_1', name: 'Acme', ownerId: null, country: null })
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id}`
    const r = await resolve()
    expect(r.resolved).toBe(false)
    expect(r.reason).toMatch(/no region recorded/)
  })

  it('never rotates globally across regions', async () => {
    // A lead in GB must not reach the US group even though reps are configured.
    getCompany.mockResolvedValue({ id: 'co_1', name: 'Acme UK', ownerId: null, country: 'United Kingdom' })
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id},${PRIYA.id}`
    const r = await resolve()
    expect(r.crmUserId).toBeNull()
  })

  it('routes each region to its own group', async () => {
    envMock.SALES_REGION_ROUND_ROBIN = `US:${MANOJ.id};GB:${PRIYA.id}`
    getCompany.mockResolvedValue({ id: 'co_1', name: 'US Co', ownerId: null, country: 'USA' })
    expect((await resolve()).crmUserId).toBe(MANOJ.id)
    getCompany.mockResolvedValue({ id: 'co_2', name: 'UK Co', ownerId: null, country: 'United Kingdom' })
    expect((await resolve()).crmUserId).toBe(PRIYA.id)
  })
})
