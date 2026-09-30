import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE GATE ITSELF (2026-09-30).
//
// Two ways to sign in now reach the same middleware. What matters is that
// neither of them is a way IN by itself: a token proves who somebody is, and a
// TenantMember role is what lets them do anything. This checks the gate holds
// for both paths, and that an account with no role is refused with a sentence
// that tells them what to do next.

type Row = Record<string, any>
const db: Record<string, Row[]> = { tenant: [], appUser: [], tenantMember: [] }
const match = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'tenantId_email') return r.tenantId === v.tenantId && r.email === v.email
    return (r[k] ?? null) === (v ?? null)
  })
const model = (t: string) => ({
  findUnique: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  findFirst: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  create: vi.fn(async ({ data }: Row) => {
    db[t]!.push({ ...data })
    return data
  }),
  update: vi.fn(async ({ where, data }: Row) => {
    const row = db[t]!.find((r) => match(r, where))!
    Object.assign(row, data)
    return row
  }),
})
const prisma: Record<string, any> = { tenant: model('tenant'), appUser: model('appUser'), tenantMember: model('tenantMember') }
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => 'generated-id' }))

const env: Record<string, any> = {
  DEFAULT_TENANT_SLUG: 'altiusnxt',
  JWT_SECRET: 'the-nxt-sales-secret',
  AUTH_JWT_SECRET: 'this-platforms-own-secret-long-enough',
  AUTH_SESSION_HOURS: 12,
  BOOTSTRAP_ADMIN_EMAIL: '',
}
vi.mock('../../src/config/env.js', () => ({ env }))

const { authenticate } = await import('../../src/api/middleware/auth.js')
const { issueSessionToken } = await import('../../src/auth/tokens.js')
const jwt = (await import('jsonwebtoken')).default

/** Runs the middleware and reports what it did. */
async function run(token: string | null): Promise<{ principal?: Row; error?: string; status?: number }> {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} } as Row
  return new Promise((resolve) => {
    void authenticate(req as never, {} as never, ((err?: Row) => {
      if (err) resolve({ error: String(err.message), status: err.status })
      else resolve({ principal: req.principal })
    }) as never)
  })
}

const appToken = (id: string, email: string) => issueSessionToken({ id, email }).token
const crmToken = (id: string, email: string) => jwt.sign({ id, email, name: 'CRM Person' }, env.JWT_SECRET)

beforeEach(() => {
  vi.clearAllMocks()
  env.BOOTSTRAP_ADMIN_EMAIL = ''
  db.tenant = [{ id: 't1', slug: 'altiusnxt' }]
  db.appUser = [{ id: 'u1', tenantId: 't1', email: 'person@altiusnxt.com', name: 'A Person', status: 'active', crmUserId: null }]
  db.tenantMember = []
})

describe('an account created on this platform', () => {
  it('is refused until an admin grants a role, and told so', async () => {
    const r = await run(appToken('u1', 'person@altiusnxt.com'))
    expect(r.principal).toBeUndefined()
    expect(r.error).toMatch(/administrator has to grant you a role/i)
    expect(r.status).toBe(403)
  })

  it('is let in once a role exists, with exactly that role’s permissions', async () => {
    db.tenantMember.push({ id: 'm1', tenantId: 't1', email: 'person@altiusnxt.com', role: 'operator', name: null })
    const r = await run(appToken('u1', 'person@altiusnxt.com'))
    expect(r.principal).toMatchObject({ email: 'person@altiusnxt.com', role: 'operator' })
    expect(r.principal!.permissions).toEqual(['view', 'operate'])
    expect(r.principal!.permissions).not.toContain('approve')
  })

  it('carries a clearly local id when the account has no NXT Sales user', async () => {
    db.tenantMember.push({ id: 'm1', tenantId: 't1', email: 'person@altiusnxt.com', role: 'admin', name: null })
    const r = await run(appToken('u1', 'person@altiusnxt.com'))
    // Marked as local, so audit records read honestly and the one action that
    // needs a real CRM user refuses instead of naming somebody else.
    expect(r.principal!.crmUserId).toBe('local:u1')
  })

  it('uses the linked NXT Sales user when there is one', async () => {
    db.appUser[0]!.crmUserId = 'crm-42'
    db.tenantMember.push({ id: 'm1', tenantId: 't1', email: 'person@altiusnxt.com', role: 'admin', name: null })
    const r = await run(appToken('u1', 'person@altiusnxt.com'))
    expect(r.principal!.crmUserId).toBe('crm-42')
  })

  it('is refused once disabled, even with a role and a valid token', async () => {
    db.tenantMember.push({ id: 'm1', tenantId: 't1', email: 'person@altiusnxt.com', role: 'admin', name: null })
    db.appUser[0]!.status = 'disabled'
    const r = await run(appToken('u1', 'person@altiusnxt.com'))
    expect(r.error).toMatch(/disabled/i)
  })

  it('is refused once the account is gone, even with a still-valid token', async () => {
    db.appUser = []
    const r = await run(appToken('u1', 'person@altiusnxt.com'))
    expect(r.error).toMatch(/no longer exists/i)
  })

  it('becomes an admin on first sign-in only for the configured bootstrap email', async () => {
    env.BOOTSTRAP_ADMIN_EMAIL = 'person@altiusnxt.com'
    const r = await run(appToken('u1', 'person@altiusnxt.com'))
    expect(r.principal).toMatchObject({ role: 'admin' })
    expect(db.tenantMember).toHaveLength(1)

    // Anyone else still waits for approval.
    db.appUser.push({ id: 'u2', tenantId: 't1', email: 'other@altiusnxt.com', status: 'active', crmUserId: null, name: null })
    expect((await run(appToken('u2', 'other@altiusnxt.com'))).error).toMatch(/grant you a role/i)
  })
})

describe('the NXT Sales path still works, unchanged', () => {
  it('lets a CRM user in when they hold a role', async () => {
    db.tenantMember.push({ id: 'm1', tenantId: 't1', email: 'crm@altiusnxt.com', crmUserId: 'crm-1', role: 'approver', name: null })
    const r = await run(crmToken('crm-1', 'crm@altiusnxt.com'))
    expect(r.principal).toMatchObject({ crmUserId: 'crm-1', role: 'approver' })
  })

  it('refuses a CRM user with no role', async () => {
    expect((await run(crmToken('crm-9', 'stranger@altiusnxt.com'))).error).toMatch(/grant you a role/i)
  })
})

describe('tokens that must not be accepted', () => {
  it('refuses no token at all', async () => {
    expect((await run(null)).status).toBe(401)
  })

  it('refuses a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ id: 'u1', email: 'person@altiusnxt.com' }, 'not-either-secret')
    expect((await run(forged)).error).toMatch(/invalid or expired/i)
  })

  it('refuses one of ours that has expired', async () => {
    const expired = jwt.sign({ email: 'person@altiusnxt.com', iss: 'altiusnxt-marketing-agent' }, env.AUTH_JWT_SECRET, {
      subject: 'u1',
      expiresIn: -10,
    })
    // Not readable as ours, and not an NXT Sales token either.
    expect((await run(expired)).error).toMatch(/invalid or expired/i)
  })

  it('does not let a token for one system be used on the other', async () => {
    // Signed with the NXT Sales secret but shaped like one of ours.
    const crossed = jwt.sign({ email: 'person@altiusnxt.com', iss: 'altiusnxt-marketing-agent' }, env.JWT_SECRET, {
      subject: 'u1',
    })
    db.tenantMember.push({ id: 'm1', tenantId: 't1', email: 'person@altiusnxt.com', role: 'admin', name: null })
    const r = await run(crossed)
    // It is read as an NXT Sales token, so it must carry NXT Sales' claims —
    // which it does not, because `sub` is not `id`.
    expect(r.principal).toBeUndefined()
    expect(r.error).toMatch(/missing required claims/i)
  })
})
