import { beforeEach, describe, expect, it, vi } from 'vitest'

// WHO SIGNS AN EMAIL (2026-10-06).
//
// Every outreach email is signed with the name of the person who started it.
// Somebody with no NXT Sales user is identified as "local:<account id>", and
// no member row carries that id — so they used to get an empty name, and
// every email they started failed the "sender's name is known" check with
// nothing on screen able to fix it.

type Row = Record<string, any>
const db: Record<string, Row[]> = { tenant: [], tenantMember: [], appUser: [] }
const match = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => r[k] === v)
const prisma = {
  tenant: { findUnique: vi.fn(async ({ where }: Row) => db.tenant!.find((r) => match(r, where)) ?? null) },
  tenantMember: { findFirst: vi.fn(async ({ where }: Row) => db.tenantMember!.find((r) => match(r, where)) ?? null) },
  appUser: { findFirst: vi.fn(async ({ where }: Row) => db.appUser!.find((r) => match(r, where)) ?? null) },
}
vi.mock('../../src/platform/db.js', () => ({ prisma }))

const { readSenderFor, senderReady } = await import('../../src/outreach/salesSequence/sender.js')

beforeEach(() => {
  db.tenant = [{ id: 't1', settings: { outreachSender: { companyName: 'AltiusNxt', signature: '' } } }]
  db.tenantMember = []
  db.appUser = []
})

describe('the sender of an email', () => {
  it('is the NXT Sales-linked member, as before', async () => {
    db.tenantMember = [{ tenantId: 't1', crmUserId: 'crm-7', name: 'Priya Raman', email: 'priya@altiusnxt.com' }]
    const s = await readSenderFor('t1', 'crm-7')
    expect(s).toMatchObject({ firstName: 'Priya', fullName: 'Priya Raman', email: 'priya@altiusnxt.com', companyName: 'AltiusNxt' })
    expect(senderReady(s)).toBe(true)
  })

  it('is found for somebody with no NXT Sales user, from their own account', async () => {
    db.tenantMember = [{ tenantId: 't1', crmUserId: null, name: null, email: 'new@altiusnxt.com' }]
    db.appUser = [{ tenantId: 't1', id: 'acc1', name: 'Dev Kumar', email: 'new@altiusnxt.com' }]
    const s = await readSenderFor('t1', 'local:acc1')
    expect(s).toMatchObject({ firstName: 'Dev', fullName: 'Dev Kumar', email: 'new@altiusnxt.com' })
    // Before the fix this was false, and approval was blocked for good.
    expect(senderReady(s)).toBe(true)
  })

  it('fills a linked member’s missing name from their account', async () => {
    db.tenantMember = [{ tenantId: 't1', crmUserId: 'crm-9', name: null, email: 'sam@altiusnxt.com' }]
    db.appUser = [{ tenantId: 't1', id: 'acc9', name: 'Sam Lee', email: 'sam@altiusnxt.com' }]
    expect((await readSenderFor('t1', 'crm-9')).firstName).toBe('Sam')
  })

  it('still invents nothing when no name exists anywhere', async () => {
    db.appUser = [{ tenantId: 't1', id: 'acc2', name: null, email: 'noname@altiusnxt.com' }]
    const s = await readSenderFor('t1', 'local:acc2')
    expect(s.firstName).toBe('')
    expect(senderReady(s)).toBe(false)
  })

  it('never reads another tenant’s account', async () => {
    db.appUser = [{ tenantId: 't2', id: 'acc1', name: 'Other Tenant', email: 'x@other.test' }]
    expect((await readSenderFor('t1', 'local:acc1')).firstName).toBe('')
  })
})
