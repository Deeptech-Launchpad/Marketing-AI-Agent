import { beforeEach, describe, expect, it, vi } from 'vitest'

// SIGNING IN WITH GOOGLE (2026-09-30).
//
// The rules that would be expensive to get wrong:
//
//   · only work domains and the named admins may sign in at all;
//   · admin comes from the configured list and nothing else can grant it;
//   · the list is re-read at every sign-in, so removing somebody takes effect;
//   · what Google returns about a person is stored as given, and nothing the
//     browser claims is believed;
//   · a disabled account is refused even with a valid Google token.

type Row = Record<string, any>
const db: Record<string, Row[]> = { tenant: [], appUser: [], tenantMember: [] }
const match = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'tenantId_email') return r.tenantId === v.tenantId && r.email === v.email
    if (k === 'tenantId_googleSub') return r.tenantId === v.tenantId && r.googleSub === v.googleSub
    return (r[k] ?? null) === (v ?? null)
  })
const model = (t: string) => ({
  findUnique: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  findFirst: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  findMany: vi.fn(async ({ where }: Row = {}) => db[t]!.filter((r) => match(r, where))),
  create: vi.fn(async ({ data }: Row) => {
    db[t]!.push({ ...data })
    return data
  }),
  update: vi.fn(async ({ where, data }: Row) => {
    const row = db[t]!.find((r) => match(r, where))!
    Object.assign(row, data)
    return row
  }),
  upsert: vi.fn(async ({ where, create, update }: Row) => {
    const row = db[t]!.find((r) => match(r, where))
    if (row) {
      for (const [k, v] of Object.entries(update)) {
        row[k] =
          v && typeof v === 'object' && 'increment' in (v as Row)
            ? Number(row[k] ?? 0) + Number((v as Row).increment)
            : v
      }
      return row
    }
    const made = { ...create }
    db[t]!.push(made)
    return made
  }),
})
const prisma: Record<string, any> = {
  tenant: model('tenant'),
  appUser: model('appUser'),
  tenantMember: model('tenantMember'),
}
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => `id_${Math.random().toString(36).slice(2, 10)}` }))

const ADMINS = 'manoj@altiusnxt.com,mohanapriya@altiusnxt.com,govind@altiusnxt.com,dtlpmanikandan@gmail.com'
const env: Record<string, any> = {
  DEFAULT_TENANT_SLUG: 'altiusnxt',
  AUTH_JWT_SECRET: 'a-test-signing-secret-of-sufficient-length',
  AUTH_SESSION_HOURS: 12,
  AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com',
  AUTH_ADMIN_EMAILS: ADMINS,
  GOOGLE_CLIENT_ID: 'test-client-id',
}
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
const audited: Row[] = []
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async (a: Row) => audited.push(a)) }))
const crmUsers: Row[] = []
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ listUsers: vi.fn(async () => crmUsers) }) }))
const verifyGoogle = vi.fn()
vi.mock('../../src/auth/google.js', () => ({ verifyGoogleIdToken: (...a: unknown[]) => verifyGoogle(...a) }))

const auth = await import('../../src/auth/service.js')
const { readSessionToken } = await import('../../src/auth/tokens.js')
const { signInProblem, roleFor, isAdminEmail } = await import('../../src/auth/accessList.js')

/** What Google says about a person, as the verified token would give it. */
const google = (email: string, over: Row = {}) => ({
  sub: `sub-${email}`,
  email,
  emailVerified: true,
  name: 'A Person',
  givenName: 'A',
  familyName: 'Person',
  pictureUrl: 'https://lh3.googleusercontent.com/a/photo',
  locale: 'en',
  ...over,
})

const signIn = (email: string, over: Row = {}) => {
  verifyGoogle.mockResolvedValue(google(email, over))
  return auth.signInWithGoogle({ credential: 'a-google-id-token' })
}

beforeEach(() => {
  vi.clearAllMocks()
  audited.length = 0
  crmUsers.length = 0
  Object.assign(env, { AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com', AUTH_ADMIN_EMAILS: ADMINS, GOOGLE_CLIENT_ID: 'test-client-id' })
  db.tenant = [{ id: 't1', slug: 'altiusnxt' }]
  db.appUser = []
  db.tenantMember = []
})

describe('who may sign in', () => {
  it('lets a work account in as an ordinary user', async () => {
    const r = await signIn('someone@altiusnxt.com')
    expect(r).toMatchObject({ email: 'someone@altiusnxt.com', role: 'operator', isAdmin: false })
  })

  it('lets each named admin in as an admin, whatever their domain', async () => {
    for (const email of ADMINS.split(',')) {
      db.appUser = []
      db.tenantMember = []
      const r = await signIn(email)
      expect(r, email).toMatchObject({ role: 'admin', isAdmin: true })
    }
  })

  it('refuses any other Google account, and says why', async () => {
    await expect(signIn('stranger@gmail.com')).rejects.toThrow(/altiusnxt\.com/)
    expect(db.appUser).toHaveLength(0)
    expect(db.tenantMember).toHaveLength(0)
  })

  it('accepts a subdomain of a work domain, and nothing that merely resembles one', () => {
    expect(signInProblem('a@mail.altiusnxt.com')).toBeNull()
    expect(signInProblem('a@altiusnxt.com.evil.net')).not.toBeNull()
    expect(signInProblem('a@notaltiusnxt.com')).not.toBeNull()
  })

  it('with no domains configured, only the named admins may sign in', async () => {
    env.AUTH_ALLOWED_EMAIL_DOMAINS = ''
    await expect(signIn('someone@altiusnxt.com')).rejects.toThrow(/not open on this server/)
    await expect(signIn('govind@altiusnxt.com')).resolves.toMatchObject({ isAdmin: true })
  })

  it('refuses a disabled account even with a valid Google token', async () => {
    await signIn('someone@altiusnxt.com')
    db.appUser[0]!.status = 'disabled'
    await expect(signIn('someone@altiusnxt.com')).rejects.toThrow(/disabled/)
  })
})

describe('what is stored about the person', () => {
  it('keeps what Google returned, as given', async () => {
    await signIn('someone@altiusnxt.com')
    expect(db.appUser[0]).toMatchObject({
      googleSub: 'sub-someone@altiusnxt.com',
      email: 'someone@altiusnxt.com',
      emailVerified: true,
      name: 'A Person',
      givenName: 'A',
      familyName: 'Person',
      pictureUrl: 'https://lh3.googleusercontent.com/a/photo',
      locale: 'en',
      status: 'active',
      signInCount: 1,
    })
  })

  it('stores no password, because there is none', async () => {
    await signIn('someone@altiusnxt.com')
    expect(Object.keys(db.appUser[0]!)).not.toContain('passwordHash')
  })

  it('counts sign-ins and keeps one account per person', async () => {
    await signIn('someone@altiusnxt.com')
    await signIn('someone@altiusnxt.com')
    expect(db.appUser).toHaveLength(1)
    expect(db.appUser[0]!.signInCount).toBe(2)
  })

  it('follows the person by Google id when their email changes', async () => {
    await signIn('old@altiusnxt.com')
    verifyGoogle.mockResolvedValue({ ...google('new@altiusnxt.com'), sub: 'sub-old@altiusnxt.com' })
    await auth.signInWithGoogle({ credential: 'token' })
    expect(db.appUser).toHaveLength(1)
    expect(db.appUser[0]!.email).toBe('new@altiusnxt.com')
  })

  it('links to the NXT Sales user with the same email when there is one', async () => {
    crmUsers.push({ id: 'crm-7', email: 'Someone@AltiusNxt.com', name: 'S', role: 'member' })
    await signIn('someone@altiusnxt.com')
    expect(db.appUser[0]!.crmUserId).toBe('crm-7')
  })

  it('signs in anyway when the CRM cannot be reached', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    vi.mocked(getCrm().listUsers).mockRejectedValueOnce(new Error('CRM down'))
    await expect(signIn('someone@altiusnxt.com')).resolves.toMatchObject({ role: 'operator' })
    expect(db.appUser[0]!.crmUserId).toBeNull()
  })
})

describe('the admin list is the only thing that grants admin', () => {
  it('writes the role the list says, at every sign-in', async () => {
    await signIn('govind@altiusnxt.com')
    expect(db.tenantMember[0]).toMatchObject({ email: 'govind@altiusnxt.com', role: 'admin' })
  })

  it('takes admin away once the address is removed from the list', async () => {
    await signIn('govind@altiusnxt.com')
    expect(db.tenantMember[0]!.role).toBe('admin')

    env.AUTH_ADMIN_EMAILS = 'manoj@altiusnxt.com'
    const r = await signIn('govind@altiusnxt.com')
    expect(r).toMatchObject({ role: 'operator', isAdmin: false })
    expect(db.tenantMember[0]!.role).toBe('operator')
  })

  it('grants admin as soon as an address is added, with no other action', async () => {
    await signIn('newadmin@altiusnxt.com')
    expect(db.tenantMember[0]!.role).toBe('operator')

    env.AUTH_ADMIN_EMAILS = `${ADMINS},newadmin@altiusnxt.com`
    expect(await signIn('newadmin@altiusnxt.com')).toMatchObject({ isAdmin: true })
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
    const r = await signIn('someone@altiusnxt.com')
    expect(readSessionToken(r.token)).toMatchObject({ email: 'someone@altiusnxt.com' })

    expect(() => jwtLib.verify(r.token, 'some-other-secret')).toThrow()
    const wrongIssuer = jwtLib.sign({ email: 'x@altiusnxt.com', iss: 'somewhere-else' }, env.AUTH_JWT_SECRET, {
      subject: 'u1',
    })
    expect(readSessionToken(wrongIssuer)).toBeNull()
  })

  it('reports sign-in as unavailable, rather than insecure, when unconfigured', async () => {
    env.GOOGLE_CLIENT_ID = ''
    await expect(signIn('someone@altiusnxt.com')).rejects.toThrow(/not configured/)
    env.GOOGLE_CLIENT_ID = 'test-client-id'

    env.AUTH_JWT_SECRET = ''
    await expect(signIn('someone@altiusnxt.com')).rejects.toThrow(/not configured/)
    env.AUTH_JWT_SECRET = 'a-test-signing-secret-of-sufficient-length'
  })

  it('tells the sign-in screen what it may draw, without naming the admins', () => {
    const c = auth.authCapabilities()
    expect(c).toMatchObject({
      ready: true,
      googleClientId: 'test-client-id',
      allowedDomains: ['altiusnxt.com'],
      adminCount: 4,
    })
    expect(JSON.stringify(c)).not.toContain('manoj@altiusnxt.com')
  })
})
