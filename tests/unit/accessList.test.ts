import { beforeEach, describe, expect, it, vi } from 'vitest'

// WHO MAY BE HERE, AND AS WHAT (2026-09-30).
//
// Two separate questions, both answered from configuration rather than from
// anything stored:
//
//   · MAY THIS ADDRESS BE HERE AT ALL — AUTH_ALLOWED_EMAIL_DOMAINS, plus the
//     named admins, who are allowed whatever their domain. Empty means nobody
//     but those admins: this platform reads the whole CRM, so it is never open
//     by default.
//   · IS IT AN ADMIN — AUTH_ADMIN_EMAILS and nothing else. Read at every
//     sign-in, so adding or removing an address takes effect without any other
//     action and without touching the database.
//
// This file drives those rules through the only sign-in path there is: an
// address, a code sent to it, and a password. tests/unit/emailOtpAuth.test.ts
// covers that path's own mechanics; this one is about the two lists.

type Row = Record<string, any>
const db: Record<string, Row[]> = { tenant: [], appUser: [], tenantMember: [], emailOtp: [] }

const match = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'tenantId_email') return r.tenantId === v.tenantId && r.email === v.email
    return (r[k] ?? null) === (v ?? null)
  })

const apply = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) {
    row[k] =
      v && typeof v === 'object' && 'increment' in (v as Row) ? Number(row[k] ?? 0) + Number((v as Row).increment) : v
  }
  return row
}

const DEFAULTS: Record<string, Row> = {
  emailOtp: { attempts: 0, usedAt: null, createdAt: new Date() },
  appUser: { signInCount: 0, emailVerified: false, status: 'active', passwordHash: null, googleSub: null },
}

const model = (t: string) => ({
  findUnique: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  findFirst: vi.fn(async ({ where, orderBy }: Row) => {
    const found = db[t]!.filter((r) => match(r, where))
    return (orderBy?.createdAt === 'desc' ? found[found.length - 1] : found[0]) ?? null
  }),
  findMany: vi.fn(async ({ where }: Row = {}) => db[t]!.filter((r) => match(r, where))),
  create: vi.fn(async ({ data }: Row) => {
    const made = { ...(DEFAULTS[t] ?? {}), ...data }
    db[t]!.push(made)
    return made
  }),
  update: vi.fn(async ({ where, data }: Row) => apply(db[t]!.find((r) => match(r, where))!, data)),
  updateMany: vi.fn(async ({ where, data }: Row) => {
    const rows = db[t]!.filter((r) => match(r, where))
    rows.forEach((r) => apply(r, data))
    return { count: rows.length }
  }),
  upsert: vi.fn(async ({ where, create, update }: Row) => {
    const row = db[t]!.find((r) => match(r, where))
    if (row) return apply(row, update)
    const made = { ...(DEFAULTS[t] ?? {}), ...create }
    db[t]!.push(made)
    return made
  }),
})

const prisma: Record<string, any> = {
  tenant: model('tenant'),
  appUser: model('appUser'),
  tenantMember: model('tenantMember'),
  emailOtp: model('emailOtp'),
}
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => `id_${Math.random().toString(36).slice(2, 10)}` }))

const ADMINS = 'manoj@altiusnxt.com,mohanapriya@altiusnxt.com,govind@altiusnxt.com,dtlpmanikandan@gmail.com'
const env: Record<string, any> = {
  DEFAULT_TENANT_SLUG: 'altiusnxt',
  AUTH_JWT_SECRET: 'a-test-signing-secret-of-sufficient-length',
  AUTH_SESSION_HOURS: 12,
  AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com',
  AUTH_ADMIN_EMAILS: ADMINS,
  AUTH_OTP_TTL_MINUTES: 10,
  AUTH_OTP_MAX_ATTEMPTS: 5,
  AUTH_DEV_RETURN_OTP: false,
  SMTP_HOST: '',
}
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async () => undefined) }))
const crmUsers: Row[] = []
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ listUsers: vi.fn(async () => crmUsers) }) }))

const sent: Row[] = []
vi.mock('../../src/auth/mailer.js', () => ({
  mailConfigured: () => true,
  sendVerificationCode: vi.fn(async (m: Row) => {
    sent.push(m)
    return { sent: true, messageId: 'test' }
  }),
}))

const auth = await import('../../src/auth/service.js')
const { readSessionToken } = await import('../../src/auth/tokens.js')
const { signInProblem, roleFor, isAdminEmail } = await import('../../src/auth/accessList.js')

const PASSWORD = 'a-good-password-9'

/** Creates an account the only way there is, and returns the session. */
async function register(email: string) {
  await auth.startRegistration({ email })
  const code = sent[sent.length - 1]!.code as string
  return auth.completeRegistration({ email, code, password: PASSWORD })
}

/** Signs in again, so a changed list can be seen taking effect. */
const signInAgain = (email: string) => auth.signInWithPassword({ email, password: PASSWORD })

beforeEach(() => {
  vi.clearAllMocks()
  sent.length = 0
  crmUsers.length = 0
  Object.assign(env, { AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com', AUTH_ADMIN_EMAILS: ADMINS })
  db.tenant = [{ id: 't1', slug: 'altiusnxt' }]
  db.appUser = []
  db.tenantMember = []
  db.emailOtp = []
})

describe('who may be here', () => {
  it('lets a work address in as an ordinary user', async () => {
    const r = await register('someone@altiusnxt.com')
    expect(r).toMatchObject({ email: 'someone@altiusnxt.com', role: 'operator', isAdmin: false })
  })

  it('lets each named admin in as an admin, whatever their domain', async () => {
    for (const email of ADMINS.split(',')) {
      db.appUser = []
      db.tenantMember = []
      db.emailOtp = []
      const r = await register(email)
      expect(r, email).toMatchObject({ role: 'admin', isAdmin: true })
    }
  })

  it('refuses any other address, and says why', async () => {
    await expect(register('stranger@gmail.com')).rejects.toThrow(/altiusnxt\.com/)
    expect(db.appUser).toHaveLength(0)
    expect(db.tenantMember).toHaveLength(0)
    // And no code was even sent, so an outsider cannot make this platform email
    // an arbitrary address.
    expect(sent).toHaveLength(0)
  })

  it('accepts a subdomain of a work domain, and nothing that merely resembles one', () => {
    expect(signInProblem('a@mail.altiusnxt.com')).toBeNull()
    expect(signInProblem('a@altiusnxt.com.evil.net')).not.toBeNull()
    expect(signInProblem('a@notaltiusnxt.com')).not.toBeNull()
  })

  it('with no domains configured, only the named admins may be here', async () => {
    env.AUTH_ALLOWED_EMAIL_DOMAINS = ''
    await expect(register('someone@altiusnxt.com')).rejects.toThrow(/not open on this server/)
    await expect(register('govind@altiusnxt.com')).resolves.toMatchObject({ isAdmin: true })
  })

  it('lets more people in only when the list is widened, and then immediately', async () => {
    await expect(register('newstarter@partner.example')).rejects.toThrow()
    env.AUTH_ALLOWED_EMAIL_DOMAINS = 'altiusnxt.com,partner.example'
    await expect(register('newstarter@partner.example')).resolves.toMatchObject({ role: 'operator' })
  })

  it('refuses a disabled account, whatever the password', async () => {
    await register('someone@altiusnxt.com')
    db.appUser[0]!.status = 'disabled'
    await expect(signInAgain('someone@altiusnxt.com')).rejects.toThrow(/disabled/)
  })

  it('refuses an address that has since left the allow-list, account or not', async () => {
    await register('someone@altiusnxt.com')
    env.AUTH_ALLOWED_EMAIL_DOMAINS = 'someoneelse.com'
    await expect(signInAgain('someone@altiusnxt.com')).rejects.toThrow()
  })
})

describe('what is stored about the person', () => {
  it('records a verified address and nothing from any third party', async () => {
    await register('someone@altiusnxt.com')
    expect(db.appUser[0]).toMatchObject({
      email: 'someone@altiusnxt.com',
      emailVerified: true,
      status: 'active',
      signInCount: 1,
    })
    // Nothing writes googleSub any more; the column is reserved, not used.
    expect(db.appUser[0]!.googleSub ?? null).toBeNull()
  })

  it('counts sign-ins and keeps one account per person', async () => {
    await register('someone@altiusnxt.com')
    await signInAgain('someone@altiusnxt.com')
    expect(db.appUser).toHaveLength(1)
    expect(db.appUser[0]!.signInCount).toBe(2)
  })

  it('links to the NXT Sales user with the same email when there is one', async () => {
    crmUsers.push({ id: 'crm-7', email: 'Someone@AltiusNxt.com', name: 'S', role: 'member' })
    await register('someone@altiusnxt.com')
    expect(db.appUser[0]!.crmUserId).toBe('crm-7')
  })

  it('signs in anyway when the CRM cannot be reached', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    vi.mocked(getCrm().listUsers).mockRejectedValueOnce(new Error('CRM down'))
    await expect(register('someone@altiusnxt.com')).resolves.toMatchObject({ role: 'operator' })
    expect(db.appUser[0]!.crmUserId).toBeNull()
  })
})

describe('the admin list is the only thing that grants admin', () => {
  it('writes the role the list says, at every sign-in', async () => {
    await register('govind@altiusnxt.com')
    expect(db.tenantMember[0]).toMatchObject({ email: 'govind@altiusnxt.com', role: 'admin' })
  })

  it('takes admin away once the address is removed from the list', async () => {
    await register('govind@altiusnxt.com')
    expect(db.tenantMember[0]!.role).toBe('admin')

    env.AUTH_ADMIN_EMAILS = 'manoj@altiusnxt.com'
    const r = await signInAgain('govind@altiusnxt.com')
    expect(r).toMatchObject({ role: 'operator', isAdmin: false })
    expect(db.tenantMember[0]!.role).toBe('operator')
  })

  it('grants admin as soon as an address is added, with no other action', async () => {
    await register('newadmin@altiusnxt.com')
    expect(db.tenantMember[0]!.role).toBe('operator')

    env.AUTH_ADMIN_EMAILS = `${ADMINS},newadmin@altiusnxt.com`
    expect(await signInAgain('newadmin@altiusnxt.com')).toMatchObject({ isAdmin: true })
  })

  it('reads the list rather than any stored row', () => {
    expect(roleFor('manoj@altiusnxt.com')).toBe('admin')
    expect(roleFor('someone@altiusnxt.com')).toBe('operator')
    expect(isAdminEmail('MANOJ@ALTIUSNXT.COM')).toBe(true)
    expect(isAdminEmail('manoj@altiusnxt.com.evil.net')).toBe(false)
  })
})

describe('the session token', () => {
  it('is readable only with this platform’s own secret and issuer', async () => {
    const jwtLib = (await import('jsonwebtoken')).default
    const r = await register('someone@altiusnxt.com')
    expect(readSessionToken(r.token)).toMatchObject({ email: 'someone@altiusnxt.com' })

    expect(() => jwtLib.verify(r.token, 'some-other-secret')).toThrow()
    const wrongIssuer = jwtLib.sign({ email: 'x@altiusnxt.com', iss: 'somewhere-else' }, env.AUTH_JWT_SECRET, {
      subject: 'u1',
    })
    expect(readSessionToken(wrongIssuer)).toBeNull()
  })

  it('reports sign-in as unavailable, rather than insecure, when unconfigured', async () => {
    env.AUTH_JWT_SECRET = ''
    await expect(register('someone@altiusnxt.com')).rejects.toThrow(/not configured/)
    env.AUTH_JWT_SECRET = 'a-test-signing-secret-of-sufficient-length'
  })

  it('tells the sign-in screen what it may draw, without naming the admins', () => {
    const c = auth.authCapabilities()
    expect(c).toMatchObject({
      ready: true,
      emailSignIn: true,
      allowedDomains: ['altiusnxt.com'],
      adminCount: 4,
    })
    expect(JSON.stringify(c)).not.toContain('manoj@altiusnxt.com')
    // No third-party sign-in is advertised, because there is none to offer.
    expect(JSON.stringify(c).toLowerCase()).not.toContain('google')
  })
})
