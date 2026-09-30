import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE GATE ON EVERY REQUEST (2026-09-30).
//
// Signing in issues a token. This is what that token can and cannot buy, and
// the load-bearing rule is the last one: admin is granted only when the
// address is on the configured list, checked on EVERY request. A stored role
// cannot hand somebody admin on its own, whoever wrote it.
//
// How the person signed in is of no interest here. The middleware verifies one
// kind of token, whatever produced it.

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
})
const prisma: Record<string, any> = {
  tenant: model('tenant'),
  appUser: model('appUser'),
  tenantMember: model('tenantMember'),
}
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => 'generated-id' }))

const env: Record<string, any> = {
  DEFAULT_TENANT_SLUG: 'altiusnxt',
  AUTH_JWT_SECRET: 'this-platforms-own-secret-long-enough',
  AUTH_SESSION_HOURS: 12,
  AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com',
  AUTH_ADMIN_EMAILS: 'manoj@altiusnxt.com,dtlpmanikandan@gmail.com',
}
vi.mock('../../src/config/env.js', () => ({ env }))

const { authenticate } = await import('../../src/api/middleware/auth.js')
const { issueSessionToken } = await import('../../src/auth/tokens.js')
const jwt = (await import('jsonwebtoken')).default

async function run(token: string | null): Promise<{ principal?: Row; error?: string; status?: number }> {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} } as Row
  return new Promise((resolve) => {
    void authenticate(req as never, {} as never, ((err?: Row) => {
      if (err) resolve({ error: String(err.message), status: err.status })
      else resolve({ principal: req.principal })
    }) as never)
  })
}
const tokenFor = (id: string, email: string) => issueSessionToken({ id, email }).token

const user = (over: Row = {}) => ({
  id: 'u1',
  tenantId: 't1',
  email: 'someone@altiusnxt.com',
  name: 'A Person',
  status: 'active',
  crmUserId: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(env, { AUTH_ADMIN_EMAILS: 'manoj@altiusnxt.com,dtlpmanikandan@gmail.com' })
  db.tenant = [{ id: 't1', slug: 'altiusnxt' }]
  db.appUser = [user()]
  db.tenantMember = [{ id: 'm1', tenantId: 't1', email: 'someone@altiusnxt.com', role: 'operator', name: null }]
})

describe('an ordinary user', () => {
  it('may run the engines, and may not approve, see cost or administer', async () => {
    const r = await run(tokenFor('u1', 'someone@altiusnxt.com'))
    expect(r.principal).toMatchObject({ email: 'someone@altiusnxt.com', role: 'operator' })
    expect(r.principal!.permissions).toEqual(['view', 'operate'])
    expect(r.principal!.permissions).not.toContain('approve')
    expect(r.principal!.permissions).not.toContain('admin')
  })

  it('carries a marked local id when there is no NXT Sales user for them', async () => {
    const r = await run(tokenFor('u1', 'someone@altiusnxt.com'))
    expect(r.principal!.crmUserId).toBe('local:u1')
  })

  it('carries the NXT Sales id when there is one', async () => {
    db.appUser = [user({ crmUserId: 'crm-42' })]
    const r = await run(tokenFor('u1', 'someone@altiusnxt.com'))
    expect(r.principal!.crmUserId).toBe('crm-42')
  })
})

describe('a configured admin', () => {
  it('gets every permission', async () => {
    db.appUser = [user({ id: 'u2', email: 'manoj@altiusnxt.com' })]
    db.tenantMember = [{ id: 'm2', tenantId: 't1', email: 'manoj@altiusnxt.com', role: 'admin', name: null }]
    const r = await run(tokenFor('u2', 'manoj@altiusnxt.com'))
    expect(r.principal!.permissions).toEqual(['view', 'operate', 'approve', 'admin'])
  })
})

describe('the admin list outranks anything stored', () => {
  it('refuses admin to somebody the list does not name, however the row was written', async () => {
    // A row claiming admin for an address that is not on the list — however it
    // got there, by an older configuration, a manual edit, or a restored backup.
    db.tenantMember = [{ id: 'm1', tenantId: 't1', email: 'someone@altiusnxt.com', role: 'admin', name: null }]
    const r = await run(tokenFor('u1', 'someone@altiusnxt.com'))
    expect(r.principal!.role).toBe('operator')
    expect(r.principal!.permissions).not.toContain('admin')
    expect(r.principal!.permissions).not.toContain('approve')
  })

  it('takes admin away the moment the address leaves the list — no sign-in needed', async () => {
    db.appUser = [user({ id: 'u2', email: 'manoj@altiusnxt.com' })]
    db.tenantMember = [{ id: 'm2', tenantId: 't1', email: 'manoj@altiusnxt.com', role: 'admin', name: null }]
    const token = tokenFor('u2', 'manoj@altiusnxt.com')
    expect((await run(token)).principal!.permissions).toContain('admin')

    // Still holding a valid token from before the change.
    env.AUTH_ADMIN_EMAILS = 'someoneelse@altiusnxt.com'
    const after = await run(token)
    expect(after.principal!.role).toBe('operator')
    expect(after.principal!.permissions).not.toContain('admin')
  })

  it('keeps a lesser stored role as it is', async () => {
    db.tenantMember = [{ id: 'm1', tenantId: 't1', email: 'someone@altiusnxt.com', role: 'viewer', name: null }]
    const r = await run(tokenFor('u1', 'someone@altiusnxt.com'))
    expect(r.principal!.permissions).toEqual(['view'])
  })

  it('defaults to an ordinary user when no role was ever written', async () => {
    db.tenantMember = []
    const r = await run(tokenFor('u1', 'someone@altiusnxt.com'))
    expect(r.principal!.role).toBe('operator')
  })
})

describe('tokens that must not be accepted', () => {
  it('refuses no token at all', async () => {
    expect((await run(null)).status).toBe(401)
  })

  it('refuses a token signed with another secret', async () => {
    const forged = jwt.sign({ email: 'someone@altiusnxt.com', iss: 'altiusnxt-marketing-agent' }, 'not-our-secret', {
      subject: 'u1',
    })
    expect((await run(forged)).error).toMatch(/invalid or expired/i)
  })

  it('refuses an expired one', async () => {
    const expired = jwt.sign({ email: 'someone@altiusnxt.com', iss: 'altiusnxt-marketing-agent' }, env.AUTH_JWT_SECRET, {
      subject: 'u1',
      expiresIn: -10,
    })
    expect((await run(expired)).error).toMatch(/invalid or expired/i)
  })

  it('refuses one whose account has been deleted or disabled', async () => {
    db.appUser = []
    expect((await run(tokenFor('u1', 'someone@altiusnxt.com'))).error).toMatch(/no longer exists/i)

    db.appUser = [user({ status: 'disabled' })]
    expect((await run(tokenFor('u1', 'someone@altiusnxt.com'))).error).toMatch(/disabled/i)
  })

  it('does not accept an NXT Sales token — that path was removed', async () => {
    // The old implementation trusted a token signed with NXT Sales' secret.
    // Nothing here does any more, and this is the test that keeps it that way.
    const nxtSales = jwt.sign({ id: 'crm-1', email: 'someone@altiusnxt.com', name: 'X' }, 'the-nxt-sales-secret')
    expect((await run(nxtSales)).error).toMatch(/invalid or expired/i)
  })
})
