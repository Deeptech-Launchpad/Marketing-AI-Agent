import { beforeEach, describe, expect, it, vi } from 'vitest'

// THIS PLATFORM'S OWN SIGN-IN (2026-09-30).
//
// The rules under test are the ones that would be expensive to get wrong:
//
//   · creating an account grants NOTHING — a role is a separate, human act;
//   · only allowed email domains may register, and an empty list means nobody;
//   · a failed sign-in never says which part was wrong;
//   · a reset link is single-use, expiring, and stored only as a hash;
//   · passwords are never stored, returned or logged;
//   · the two sign-in paths cannot be confused for one another.

type Row = Record<string, any>
const db: Record<string, Row[]> = { tenant: [], appUser: [], tenantMember: [], passwordResetToken: [] }

const match = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'tenantId_email') return r.tenantId === v.tenantId && r.email === v.email
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(r[k])
      if ('not' in v) return r[k] !== v.not
      return true
    }
    return (r[k] ?? null) === (v ?? null)
  })

const model = (t: string) => ({
  findUnique: vi.fn(async ({ where, include }: Row) => {
    const row = db[t]!.find((r) => match(r, where)) ?? null
    if (row && include?.user) return { ...row, user: db.appUser!.find((u) => u.id === row.appUserId) ?? null }
    return row
  }),
  findFirst: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  findMany: vi.fn(async ({ where }: Row = {}) => db[t]!.filter((r) => match(r, where))),
  create: vi.fn(async ({ data }: Row) => {
    const row = { createdAt: new Date(), updatedAt: new Date(), ...data }
    db[t]!.push(row)
    return row
  }),
  update: vi.fn(async ({ where, data }: Row) => {
    const row = db[t]!.find((r) => match(r, where))!
    Object.assign(row, data)
    return row
  }),
  updateMany: vi.fn(async ({ where, data }: Row) => {
    const rows = db[t]!.filter((r) => match(r, where))
    rows.forEach((r) => Object.assign(r, data))
    return { count: rows.length }
  }),
  upsert: vi.fn(async ({ where, create, update }: Row) => {
    const row = db[t]!.find((r) => match(r, where))
    if (row) {
      Object.assign(row, update)
      return row
    }
    const made = { createdAt: new Date(), updatedAt: new Date(), ...create }
    db[t]!.push(made)
    return made
  }),
})

const prisma: Record<string, any> = {
  tenant: model('tenant'),
  appUser: model('appUser'),
  tenantMember: model('tenantMember'),
  passwordResetToken: model('passwordResetToken'),
  $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
}
vi.mock('../../src/platform/db.js', () => ({ prisma, newId: () => `id_${Math.random().toString(36).slice(2, 10)}` }))

const env: Record<string, any> = {
  DEFAULT_TENANT_SLUG: 'altiusnxt',
  AUTH_JWT_SECRET: 'a-test-signing-secret-of-sufficient-length',
  AUTH_SESSION_HOURS: 12,
  AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com,deeptechskills.com',
  AUTH_RESET_TTL_MINUTES: 60,
  AUTH_PUBLIC_BASE_URL: 'http://localhost:5174',
  AUTH_DEV_RETURN_RESET_LINK: true,
  GOOGLE_CLIENT_ID: '',
  BOOTSTRAP_ADMIN_EMAIL: '',
  SMTP_HOST: '',
  SMTP_FROM: '',
  SMTP_USER: '',
}
vi.mock('../../src/config/env.js', () => ({ env }))
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
const audited: Row[] = []
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async (a: Row) => audited.push(a)) }))
// The CRM is read only to link an account to its NXT Sales user, if any.
const crmUsers: Row[] = []
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ listUsers: vi.fn(async () => crmUsers) }) }))
const verifyGoogle = vi.fn()
vi.mock('../../src/auth/google.js', () => ({
  verifyGoogleIdToken: (...a: unknown[]) => verifyGoogle(...a),
  googleConfigured: () => Boolean(env.GOOGLE_CLIENT_ID),
}))

const auth = await import('../../src/auth/service.js')
const { readSessionToken } = await import('../../src/auth/tokens.js')
const { registrationProblem } = await import('../../src/auth/emailDomains.js')
const { passwordProblem, hashPassword, verifyPassword } = await import('../../src/auth/passwords.js')

const GOOD = 'correct-horse9'

beforeEach(() => {
  vi.clearAllMocks()
  audited.length = 0
  crmUsers.length = 0
  Object.assign(env, {
    AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com,deeptechskills.com',
    AUTH_DEV_RETURN_RESET_LINK: true,
    BOOTSTRAP_ADMIN_EMAIL: '',
    SMTP_HOST: '',
  })
  db.tenant = [{ id: 't1', slug: 'altiusnxt' }]
  db.appUser = []
  db.tenantMember = []
  db.passwordResetToken = []
})

// ── Creating an account ────────────────────────────────────────────────────

describe('creating an account', () => {
  it('creates it, signs the person in, and grants them nothing at all', async () => {
    const r = await auth.register({ email: 'New.Person@AltiusNxt.com', password: GOOD, name: 'New Person' })
    expect(r.email).toBe('new.person@altiusnxt.com')
    // Signed in, but no role: this is the whole point of the approval step.
    expect(r.hasAccess).toBe(false)
    expect(db.tenantMember).toHaveLength(0)
    expect(readSessionToken(r.token)).toMatchObject({ email: 'new.person@altiusnxt.com' })
    expect(audited.some((a) => a.action === 'auth.account_created')).toBe(true)
  })

  it('never stores the password itself', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    const stored = JSON.stringify(db.appUser[0])
    expect(stored).not.toContain(GOOD)
    expect(await verifyPassword(GOOD, db.appUser[0]!.passwordHash)).toBe(true)
    expect(await verifyPassword('something-else9', db.appUser[0]!.passwordHash)).toBe(false)
  })

  it('refuses an email outside the allowed domains, naming them', async () => {
    await expect(auth.register({ email: 'someone@gmail.com', password: GOOD })).rejects.toThrow(
      /altiusnxt\.com, deeptechskills\.com/,
    )
    expect(db.appUser).toHaveLength(0)
  })

  it('accepts a subdomain of an allowed domain, and nothing else', () => {
    expect(registrationProblem('a@mail.altiusnxt.com')).toBeNull()
    expect(registrationProblem('a@altiusnxt.com.evil.net')).not.toBeNull()
    expect(registrationProblem('a@notaltiusnxt.com')).not.toBeNull()
  })

  it('with no domains configured, nobody may register', async () => {
    env.AUTH_ALLOWED_EMAIL_DOMAINS = ''
    await expect(auth.register({ email: 'a@altiusnxt.com', password: GOOD })).rejects.toThrow(/not open on this server/)
  })

  it('refuses a weak password before anything is written', async () => {
    for (const bad of ['short1', 'alllettersonly', '1234567890123']) {
      await expect(auth.register({ email: 'a@altiusnxt.com', password: bad })).rejects.toThrow()
    }
    expect(passwordProblem(GOOD)).toBeNull()
    expect(db.appUser).toHaveLength(0)
  })

  it('refuses a second account for the same address', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    await expect(auth.register({ email: 'A@altiusnxt.com', password: GOOD })).rejects.toThrow(/already exists/)
    expect(db.appUser).toHaveLength(1)
  })

  it('links the account to its NXT Sales user when the email matches one', async () => {
    crmUsers.push({ id: 'crm-7', email: 'A@altiusnxt.com', name: 'A', role: 'member' })
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    expect(db.appUser[0]!.crmUserId).toBe('crm-7')
  })

  it('works when the CRM cannot be reached — the account is simply unlinked', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    vi.mocked(getCrm().listUsers).mockRejectedValueOnce(new Error('CRM down'))
    const r = await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    expect(r.hasAccess).toBe(false)
    expect(db.appUser[0]!.crmUserId).toBeNull()
  })
})

// ── Signing in ─────────────────────────────────────────────────────────────

describe('signing in', () => {
  const existing = async () => auth.register({ email: 'a@altiusnxt.com', password: GOOD })

  it('accepts the right password and reports whether a role has been granted', async () => {
    await existing()
    expect((await auth.signIn({ email: 'a@altiusnxt.com', password: GOOD })).hasAccess).toBe(false)

    db.tenantMember.push({ id: 'm1', tenantId: 't1', email: 'a@altiusnxt.com', role: 'operator' })
    expect((await auth.signIn({ email: 'a@altiusnxt.com', password: GOOD })).hasAccess).toBe(true)
  })

  it('says the same thing for a wrong password and an account that does not exist', async () => {
    await existing()
    const wrong = await auth.signIn({ email: 'a@altiusnxt.com', password: 'wrong-password1' }).catch((e: Error) => e.message)
    const missing = await auth.signIn({ email: 'nobody@altiusnxt.com', password: GOOD }).catch((e: Error) => e.message)
    expect(wrong).toBe(missing)
    expect(String(wrong)).not.toMatch(/exist|found|unknown/i)
  })

  it('answers a Google-only account the same way rather than revealing it has no password', async () => {
    db.appUser.push({ id: 'u9', tenantId: 't1', email: 'g@altiusnxt.com', passwordHash: null, googleSub: 'sub-9', status: 'active' })
    const refused = await auth.signIn({ email: 'g@altiusnxt.com', password: GOOD }).catch((e: Error) => e.message)
    const missing = await auth.signIn({ email: 'nobody@altiusnxt.com', password: GOOD }).catch((e: Error) => e.message)
    expect(refused).toBe(missing)
  })

  it('refuses a disabled account, and says so plainly', async () => {
    await existing()
    db.appUser[0]!.status = 'disabled'
    await expect(auth.signIn({ email: 'a@altiusnxt.com', password: GOOD })).rejects.toThrow(/disabled/)
  })
})

// ── Google ─────────────────────────────────────────────────────────────────

describe('signing in with Google', () => {
  beforeEach(() => {
    env.GOOGLE_CLIENT_ID = 'test-client-id'
    verifyGoogle.mockResolvedValue({ sub: 'google-123', email: 'g@altiusnxt.com', emailVerified: true, name: 'G Person' })
  })

  it('creates an account on first use, still with no role', async () => {
    const r = await auth.signInWithGoogle({ credential: 'token' })
    expect(r).toMatchObject({ email: 'g@altiusnxt.com', hasAccess: false })
    expect(db.appUser[0]).toMatchObject({ googleSub: 'google-123', emailVerified: true })
    // No password was set: this account signs in with Google only.
    expect(db.appUser[0]!.passwordHash ?? null).toBeNull()
  })

  it('applies the same domain rule as registering', async () => {
    verifyGoogle.mockResolvedValue({ sub: 'x', email: 'someone@gmail.com', emailVerified: true, name: null })
    await expect(auth.signInWithGoogle({ credential: 'token' })).rejects.toThrow(/altiusnxt\.com/)
    expect(db.appUser).toHaveLength(0)
  })

  it('attaches Google to an existing password account instead of making a second one', async () => {
    await auth.register({ email: 'g@altiusnxt.com', password: GOOD })
    await auth.signInWithGoogle({ credential: 'token' })
    expect(db.appUser).toHaveLength(1)
    expect(db.appUser[0]).toMatchObject({ googleSub: 'google-123', emailVerified: true })
    // The password still works: linking Google did not remove it.
    expect(await verifyPassword(GOOD, db.appUser[0]!.passwordHash)).toBe(true)
  })

  it('refuses a disabled account', async () => {
    await auth.register({ email: 'g@altiusnxt.com', password: GOOD })
    db.appUser[0]!.status = 'disabled'
    await expect(auth.signInWithGoogle({ credential: 'token' })).rejects.toThrow(/disabled/)
  })
})

// ── Forgotting and resetting ───────────────────────────────────────────────

describe('resetting a password', () => {
  const askFor = (email: string) => auth.requestPasswordReset({ email })

  it('answers the same whether or not the address has an account', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    const known = await askFor('a@altiusnxt.com')
    const unknown = await askFor('nobody@altiusnxt.com')
    expect(known.message).toBe(unknown.message)
    // ...but only the real one produced a token.
    expect(db.passwordResetToken).toHaveLength(1)
  })

  it('stores only a hash of the link, never the link itself', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    const r = await askFor('a@altiusnxt.com')
    const token = new URL(r.devResetLink!).searchParams.get('token')!
    expect(token.length).toBeGreaterThan(20)
    expect(JSON.stringify(db.passwordResetToken)).not.toContain(token)
  })

  it('changes the password, and the link cannot be used twice', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    const token = new URL((await askFor('a@altiusnxt.com')).devResetLink!).searchParams.get('token')!

    await auth.resetPassword({ token, password: 'brand-new-pass1' })
    expect(await auth.signIn({ email: 'a@altiusnxt.com', password: 'brand-new-pass1' })).toMatchObject({
      email: 'a@altiusnxt.com',
    })
    await expect(auth.resetPassword({ token, password: 'another-one-99' })).rejects.toThrow(/not valid any more/)
  })

  it('refuses an expired link', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    const token = new URL((await askFor('a@altiusnxt.com')).devResetLink!).searchParams.get('token')!
    db.passwordResetToken[0]!.expiresAt = new Date(Date.now() - 1000)
    await expect(auth.resetPassword({ token, password: 'brand-new-pass1' })).rejects.toThrow(/not valid any more/)
  })

  it('asking again retires the earlier link', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    const first = new URL((await askFor('a@altiusnxt.com')).devResetLink!).searchParams.get('token')!
    await askFor('a@altiusnxt.com')
    await expect(auth.resetPassword({ token: first, password: 'brand-new-pass1' })).rejects.toThrow(/not valid any more/)
  })

  it('refuses a weak new password', async () => {
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    const token = new URL((await askFor('a@altiusnxt.com')).devResetLink!).searchParams.get('token')!
    await expect(auth.resetPassword({ token, password: 'weak' })).rejects.toThrow()
    // Still usable afterwards: a refused attempt does not spend the link.
    await expect(auth.resetPassword({ token, password: 'brand-new-pass1' })).resolves.toMatchObject({
      email: 'a@altiusnxt.com',
    })
  })

  it('never returns a link when the dev flag is off', async () => {
    env.AUTH_DEV_RETURN_RESET_LINK = false
    await auth.register({ email: 'a@altiusnxt.com', password: GOOD })
    expect((await askFor('a@altiusnxt.com')).devResetLink).toBeUndefined()
  })
})

// ── The two sign-in paths stay apart ───────────────────────────────────────

describe('tokens', () => {
  it('a token from this platform is not accepted as an NXT Sales one, or the reverse', async () => {
    const jwt = (await import('jsonwebtoken')).default
    const r = await auth.register({ email: 'a@altiusnxt.com', password: GOOD })

    // An NXT Sales token is signed with a different secret and has no issuer.
    const nxtSales = jwt.sign({ id: 'crm-1', email: 'a@altiusnxt.com' }, 'nxt-sales-secret')
    expect(readSessionToken(nxtSales)).toBeNull()

    // Ours is only readable with our secret.
    expect(readSessionToken(r.token)).not.toBeNull()
    expect(() => jwt.verify(r.token, 'nxt-sales-secret')).toThrow()
  })

  it('refuses a token signed with the right secret but the wrong issuer', async () => {
    const jwt = (await import('jsonwebtoken')).default
    const forged = jwt.sign({ email: 'a@altiusnxt.com', iss: 'somewhere-else' }, env.AUTH_JWT_SECRET, { subject: 'u1' })
    expect(readSessionToken(forged)).toBeNull()
  })

  it('is unavailable, rather than insecure, when no secret is configured', async () => {
    env.AUTH_JWT_SECRET = ''
    await expect(auth.register({ email: 'a@altiusnxt.com', password: GOOD })).rejects.toThrow(/not configured/)
    env.AUTH_JWT_SECRET = 'a-test-signing-secret-of-sufficient-length'
  })
})

describe('password hashing', () => {
  it('produces a different hash each time, and both verify', async () => {
    const a = await hashPassword(GOOD)
    const b = await hashPassword(GOOD)
    expect(a).not.toBe(b)
    expect(await verifyPassword(GOOD, a)).toBe(true)
    expect(await verifyPassword(GOOD, b)).toBe(true)
  })

  it('treats a missing hash as a failed check rather than throwing', async () => {
    expect(await verifyPassword(GOOD, null)).toBe(false)
  })
})
