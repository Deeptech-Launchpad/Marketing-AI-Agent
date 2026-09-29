import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'

// WHERE A SELECTED COMPANY COMES FROM — asked of the sources, not assumed.
//
// A company Prospects found was being shown as an "NXT Sales company" with a
// "CRM record" id that was really this platform's own id. The identity route
// answers from the CRM and the discovery rows at the moment it is asked.

const findFirst = vi.fn()
const getCompany = vi.fn()
vi.mock('../../src/platform/db.js', () => ({ prisma: { discoveredCompany: { findFirst: (...a: unknown[]) => findFirst(...a) } } }))
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ getCompany: (...a: unknown[]) => getCompany(...a) }) }))
vi.mock('../../src/api/middleware/rbac.js', () => ({ requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))

const { companyRoutes } = await import('../../src/api/routes/companies.routes.js')

let server: Server
let base = ''
beforeAll(async () => {
  const app = express()
  app.use((req, _res, next) => {
    ;(req as unknown as { principal: unknown }).principal = { tenantId: 't1', crmUserId: 'u1' }
    next()
  })
  app.use('/companies', companyRoutes)
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})
afterAll(() => server.close())
beforeEach(() => {
  findFirst.mockReset()
  getCompany.mockReset()
})

const identity = async (id: string) => (await fetch(`${base}/companies/${id}/identity`)).json() as Promise<Record<string, unknown>>
const crmRecord = (id: string) => ({ id, name: 'Acme Medical Supplies', domain: 'acmemed.com.mt', email: null, emails: [], linkedProfiles: [] })

describe('company identity — checked live against NXT Sales', () => {
  it('a company Prospects found is "discovered", with no CRM id', async () => {
    findFirst.mockResolvedValue({ id: 'disc1', companyName: 'Europharma Ltd.', websiteUrl: 'https://europharma.com.mt/', domain: 'europharma.com.mt', crmCompanyId: null, search: { objective: 'medical supply companies in Malta' } })
    const r = await identity('disc1')
    expect(r).toMatchObject({ kind: 'discovered', crmCompanyId: null, discoveredCompanyId: 'disc1', searchObjective: 'medical supply companies in Malta' })
    expect(getCompany).not.toHaveBeenCalled()
  })

  it('a discovered company linked to a CRM record that NXT Sales no longer holds stays "discovered" — a stale link is not trusted', async () => {
    findFirst.mockResolvedValue({ id: 'disc1', companyName: 'Europharma Ltd.', websiteUrl: null, domain: 'europharma.com.mt', crmCompanyId: 'crm-gone', search: null })
    getCompany.mockResolvedValue(null)
    const r = await identity('disc1')
    expect(getCompany).toHaveBeenCalledWith('crm-gone')
    expect(r).toMatchObject({ kind: 'discovered', crmCompanyId: null })
  })

  it('a discovered company matched to a record NXT Sales holds shows that CRM id', async () => {
    findFirst.mockResolvedValue({ id: 'disc1', companyName: 'Acme', websiteUrl: null, domain: null, crmCompanyId: 'crm1', search: null })
    getCompany.mockResolvedValue(crmRecord('crm1'))
    expect(await identity('disc1')).toMatchObject({ kind: 'crm', crmCompanyId: 'crm1' })
  })

  it('a real NXT Sales company is "crm", with its CRM id and name from the CRM', async () => {
    findFirst.mockResolvedValue(null)
    getCompany.mockResolvedValue(crmRecord('crm1'))
    expect(await identity('crm1')).toMatchObject({ kind: 'crm', crmCompanyId: 'crm1', name: 'Acme Medical Supplies' })
  })

  it('an id NXT Sales does not hold, and Prospects never found, is "not_in_crm"', async () => {
    findFirst.mockResolvedValue(null)
    getCompany.mockResolvedValue(null)
    expect(await identity('stale-id')).toMatchObject({ kind: 'not_in_crm', crmCompanyId: null })
  })

  it('when NXT Sales cannot be reached nothing is claimed — "unverified", no CRM id', async () => {
    findFirst.mockResolvedValue(null)
    getCompany.mockRejectedValue(new Error('CRM timed out'))
    const r = await identity('crm1')
    expect(r).toMatchObject({ kind: 'unverified', crmCompanyId: null })
    expect(r.reason).toMatch(/CRM timed out/)
  })
})
