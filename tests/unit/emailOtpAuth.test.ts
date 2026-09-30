import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

// CREATING AND RECOVERING AN ACCOUNT WITH A CODE (2026-09-30).
//
// What these tests hold in place is the part that would be expensive to get
// wrong, because an account here can read the whole CRM:
//
//   · the code is never stored in plain text, only as a hash;
//   · it expires, and expiry is judged when it is USED;
//   · it works once — spent on success, and spent by asking for a new one;
//   · guessing is limited, and running out of guesses spends the code;
//   · no account exists until the code has been entered correctly;
//   · the configured allow-list decides who may register at all;
//   · a wrong password and a missing account answer identically;
//   · a reset says the same thing whether or not the address has an account.

type Row = Record<string, any>
const db: Record<string, Row[]> = { tenant: [], appUser: [], tenantMember: [], emailOtp: [] }

const match = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'tenantId_email') return r.tenantId === v.tenantId && r.email === v.email
    if (k === 'tenantId_googleSub') return r.tenantId === v.tenantId && r.googleSub === v.googleSub
    return (r[k] ?? null) === (v ?? null)
  })

const apply = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) {
    row[k] =
      v && typeof v === 'object' && 'increment' in (v as Row) ? Number(row[k] ?? 0) + Number((v as Row).increment) : v
  }
  return row
}

/** The column defaults the real schema applies on insert. */
const DEFAULTS: Record<string, Row> = {
  emailOtp: { attempts: 0, usedAt: null, createdAt: new Date() },
  appUser: { signInCount: 0, emailVerified: false, status: 'active', passwordHash: null, googleSub: null },
}

const model = (t: string) => ({
  findUnique: vi.fn(async ({ where }: Row) => db[t]!.find((r) => match(r, where)) ?? null),
  findFirst: vi.fn(async ({ where, orderBy }: Row) => {
    const found = db[t]!.filter((r) => match(r, where))
    // Only createdAt desc is used, and the newest row is the last one pushed.
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
const audited: Row[] = []
vi.mock('../../src/platform/audit.js', () => ({ audit: vi.fn(async (a: Row) => audited.push(a)) }))
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => ({ listUsers: vi.fn(async () => []) }) }))

/** The mailer, stood in for so nothing is ever actually sent from a test. */
const sent: Row[] = []
let mailWorks = true
vi.mock('../../src/auth/mailer.js', () => ({
  mailConfigured: () => mailWorks,
  sendVerificationCode: vi.fn(async (m: Row) => {
    sent.push(m)
    return mailWorks ? { sent: true, messageId: 'test' } : { sent: false, reason: 'no mail server' }
  }),
}))

const auth = await import('../../src/auth/service.js')
const { hashCode, issueCode, newCode, useCode } = await import('../../src/auth/otp.js')

const PERSON = 'newstarter@altiusnxt.com'
const GOOD_PASSWORD = 'correct-horse-9'

/** Runs a registration up to the point where the code is known. */
async function startAndReadCode(email = PERSON): Promise<string> {
  await auth.startRegistration({ email })
  const code = sent[sent.length - 1]!.code as string
  return code
}

beforeEach(() => {
  vi.clearAllMocks()
  audited.length = 0
  sent.length = 0
  mailWorks = true
  Object.assign(env, {
    AUTH_ALLOWED_EMAIL_DOMAINS: 'altiusnxt.com',
    AUTH_ADMIN_EMAILS: ADMINS,
    AUTH_OTP_TTL_MINUTES: 10,
    AUTH_OTP_MAX_ATTEMPTS: 5,
    AUTH_DEV_RETURN_OTP: false,
  })
  db.tenant = [{ id: 't1', slug: 'altiusnxt' }]
  db.appUser = []
  db.tenantMember = []
  db.emailOtp = []
})

describe('the code itself', () => {
  it('is six digits', () => {
    for (let i = 0; i < 200; i += 1) expect(newCode()).toMatch(/^\d{6}$/)
  })

  it('is stored only as a hash, never in plain text', async () => {
    const { code } = await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    const row = db.emailOtp[0]!
    expect(row.codeHash).toBe(createHash('sha256').update(code).digest('hex'))
    // Nothing anywhere in the row equals the code, under any key.
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('works once and is spent', async () => {
    const { code } = await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    expect(await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code })).toEqual({ ok: true })
    const again = await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code })
    expect(again.ok).toBe(false)
    expect(again).toMatchObject({ reason: expect.stringContaining('already been used') })
  })

  it('is refused once it has expired, judged when it is used', async () => {
    const { code } = await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    // Valid a moment ago; the clock, not the row, is what changed.
    db.emailOtp[0]!.expiresAt = new Date(Date.now() - 1_000)
    const result = await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('expired') })
    expect(db.emailOtp[0]!.usedAt).toBeInstanceOf(Date)
  })

  it('counts wrong guesses and spends the code when they run out', async () => {
    env.AUTH_OTP_MAX_ATTEMPTS = 3
    const { code } = await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    const wrong = code === '000000' ? '999999' : '000000'

    for (const expected of ['not right', 'not right']) {
      const r = await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code: wrong })
      expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(expected) })
    }
    const last = await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code: wrong })
    expect(last).toMatchObject({ ok: false, reason: expect.stringContaining('already been used') })

    // And now the real code is worthless too, which is the point.
    expect(await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code })).toMatchObject({ ok: false })
  })

  it('spends every earlier code when a new one is asked for', async () => {
    const first = await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    expect(await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code: first.code })).toMatchObject({
      ok: false,
    })
  })

  it('keeps registration and reset codes apart', async () => {
    const { code } = await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    expect(await useCode({ tenantId: 't1', email: PERSON, purpose: 'reset', code })).toMatchObject({ ok: false })
  })

  it('answers the same way when no code was ever issued', async () => {
    const result = await useCode({ tenantId: 't1', email: PERSON, purpose: 'register', code: '123456' })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('expired or has already been used') })
  })

  it('hashes with no regard to surrounding whitespace, and differs per code', () => {
    expect(hashCode(' 123456 ')).toBe(hashCode('123456'))
    expect(hashCode('123456')).not.toBe(hashCode('123457'))
  })
})

describe('creating an account', () => {
  it('writes no account until the code has been entered', async () => {
    await auth.startRegistration({ email: PERSON })
    expect(db.appUser).toHaveLength(0)
    expect(db.emailOtp).toHaveLength(1)
  })

  it('creates a verified, active account once the code is right', async () => {
    const code = await startAndReadCode()
    const result = await auth.completeRegistration({ email: PERSON, code, password: GOOD_PASSWORD, name: 'New Starter' })

    expect(result).toMatchObject({ email: PERSON, name: 'New Starter', role: 'operator', isAdmin: false })
    expect(result.token).toBeTruthy()

    const row = db.appUser[0]!
    expect(row).toMatchObject({ email: PERSON, emailVerified: true, status: 'active', signInCount: 1 })
    // The password is kept as a bcrypt hash and nothing resembling the
    // plaintext is stored.
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/)
    expect(JSON.stringify(row)).not.toContain(GOOD_PASSWORD)
  })

  it('refuses a weak password before spending anything', async () => {
    const code = await startAndReadCode()
    await expect(auth.completeRegistration({ email: PERSON, code, password: 'short1' })).rejects.toThrow(
      /at least 10 characters|too short/i,
    )
    expect(db.appUser).toHaveLength(0)
    // The code survives a rejected password, so the person can simply retype it.
    expect(db.emailOtp[0]!.usedAt ?? null).toBeNull()
  })

  it('refuses a wrong code, and creates nothing', async () => {
    const code = await startAndReadCode()
    const wrong = code === '000000' ? '999999' : '000000'
    await expect(auth.completeRegistration({ email: PERSON, code: wrong, password: GOOD_PASSWORD })).rejects.toThrow(
      /not right/,
    )
    expect(db.appUser).toHaveLength(0)
  })

  it('refuses an address outside the configured domains, at both steps', async () => {
    await expect(auth.startRegistration({ email: 'someone@gmail.com' })).rejects.toThrow()
    // Not even with a code: the list is checked again on the second step.
    await expect(
      auth.completeRegistration({ email: 'someone@gmail.com', code: '123456', password: GOOD_PASSWORD }),
    ).rejects.toThrow()
    expect(db.emailOtp).toHaveLength(0)
    expect(db.appUser).toHaveLength(0)
  })

  it('gives a listed admin address admin, and nobody else', async () => {
    const admin = 'dtlpmanikandan@gmail.com'
    await auth.startRegistration({ email: admin })
    const code = sent[sent.length - 1]!.code as string
    const result = await auth.completeRegistration({ email: admin, code, password: GOOD_PASSWORD })
    expect(result).toMatchObject({ role: 'admin', isAdmin: true })
    expect(db.tenantMember.find((m) => m.email === admin)!.role).toBe('admin')
  })

  it('refuses a second account for an address that already has a password', async () => {
    const code = await startAndReadCode()
    await auth.completeRegistration({ email: PERSON, code, password: GOOD_PASSWORD })
    await expect(auth.startRegistration({ email: PERSON })).rejects.toThrow(/already exists/i)
  })

  it('gives a password to an existing account without one, rather than a second account', async () => {
    // An account with no password cannot arise from the current sign-in path.
    // It is still what an imported or part-created row looks like, and the
    // answer must be "this is the same person", not a unique-index collision.
    db.appUser.push({
      id: 'u-existing',
      tenantId: 't1',
      email: PERSON,
      name: 'Already Known',
      passwordHash: null,
      emailVerified: true,
      status: 'active',
      signInCount: 3,
    })
    const code = await startAndReadCode()
    await auth.completeRegistration({ email: PERSON, code, password: GOOD_PASSWORD })

    expect(db.appUser).toHaveLength(1)
    expect(db.appUser[0]).toMatchObject({ id: 'u-existing', signInCount: 4 })
    expect(db.appUser[0]!.passwordHash).toMatch(/^\$2[aby]\$/)
    expect(audited.map((a) => a.action)).toContain('auth.password_added')
  })

  it('normalises the address, so case and spacing cannot make a second account', async () => {
    await auth.startRegistration({ email: '  NewStarter@AltiusNxt.com ' })
    const code = sent[sent.length - 1]!.code as string
    const result = await auth.completeRegistration({ email: 'NEWSTARTER@altiusnxt.com', code, password: GOOD_PASSWORD })
    expect(result.email).toBe(PERSON)
    expect(db.appUser).toHaveLength(1)
  })

  it('hands back the code only in development, and only with no mail server', async () => {
    mailWorks = false
    const refused = await auth.startRegistration({ email: PERSON })
    expect(refused.devCode).toBeUndefined()
    expect(refused.message).toMatch(/could not be emailed/i)

    env.AUTH_DEV_RETURN_OTP = true
    const dev = await auth.startRegistration({ email: PERSON })
    expect(dev.devCode).toMatch(/^\d{6}$/)

    // With a working mail server it is never handed back, development or not.
    mailWorks = true
    const posted = await auth.startRegistration({ email: PERSON })
    expect(posted.devCode).toBeUndefined()
  })
})

describe('signing in with a password', () => {
  const makeAccount = async (email = PERSON) => {
    await auth.startRegistration({ email })
    const code = sent[sent.length - 1]!.code as string
    await auth.completeRegistration({ email, code, password: GOOD_PASSWORD })
  }

  it('lets the right password in and counts the sign-in', async () => {
    await makeAccount()
    const result = await auth.signInWithPassword({ email: PERSON, password: GOOD_PASSWORD })
    expect(result).toMatchObject({ email: PERSON, role: 'operator' })
    expect(db.appUser[0]!.signInCount).toBe(2)
  })

  it('says the same thing for a wrong password, a missing account and one with no password', async () => {
    await makeAccount()
    db.appUser.push({
      id: 'u-nopass',
      tenantId: 't1',
      email: 'nopassword@altiusnxt.com',
      passwordHash: null,
      status: 'active',
    })

    const reasons: string[] = []
    for (const attempt of [
      { email: PERSON, password: 'wrong-password-1' },
      { email: 'nobody@altiusnxt.com', password: GOOD_PASSWORD },
      { email: 'nopassword@altiusnxt.com', password: GOOD_PASSWORD },
    ]) {
      await auth.signInWithPassword(attempt).then(
        () => expect.unreachable('that sign-in should have been refused'),
        (err: Error) => reasons.push(err.message),
      )
    }
    expect(new Set(reasons).size).toBe(1)
    expect(reasons[0]).toBe('That email and password do not match an account here.')
  })

  it('refuses a disabled account', async () => {
    await makeAccount()
    db.appUser[0]!.status = 'disabled'
    await expect(auth.signInWithPassword({ email: PERSON, password: GOOD_PASSWORD })).rejects.toThrow(/disabled/i)
  })

  it('refuses an address that has since left the allow-list', async () => {
    await makeAccount()
    env.AUTH_ALLOWED_EMAIL_DOMAINS = 'someoneelse.com'
    await expect(auth.signInWithPassword({ email: PERSON, password: GOOD_PASSWORD })).rejects.toThrow()
  })
})

describe('recovering an account', () => {
  const makeAccount = async (email = PERSON) => {
    await auth.startRegistration({ email })
    await auth.completeRegistration({
      email,
      code: sent[sent.length - 1]!.code as string,
      password: GOOD_PASSWORD,
    })
    sent.length = 0
  }

  it('sends a code and lets a new password be set', async () => {
    await makeAccount()
    const started = await auth.startPasswordReset({ email: PERSON })
    expect(started.message).toMatch(/If an account exists/i)

    const code = sent[sent.length - 1]!.code as string
    const result = await auth.completePasswordReset({ email: PERSON, code, password: 'a-new-password-7' })
    expect(result.email).toBe(PERSON)

    // The new password works and the old one no longer does.
    await expect(auth.signInWithPassword({ email: PERSON, password: 'a-new-password-7' })).resolves.toMatchObject({
      email: PERSON,
    })
    await expect(auth.signInWithPassword({ email: PERSON, password: GOOD_PASSWORD })).rejects.toThrow()
  })

  it('says the same thing for an address with no account, and sends nothing', async () => {
    const known = await (async () => {
      await makeAccount()
      return auth.startPasswordReset({ email: PERSON })
    })()
    sent.length = 0
    const unknown = await auth.startPasswordReset({ email: 'nobody@altiusnxt.com' })

    expect(unknown.message.replace(/nobody@altiusnxt\.com/, PERSON)).toBe(known.message)
    expect(sent).toHaveLength(0)
    expect(db.emailOtp.filter((o) => o.email === 'nobody@altiusnxt.com')).toHaveLength(0)
  })

  it('sends nothing for a disabled account, and still says the same thing', async () => {
    await makeAccount()
    db.appUser[0]!.status = 'disabled'
    const result = await auth.startPasswordReset({ email: PERSON })
    expect(result.message).toMatch(/If an account exists/i)
    expect(sent).toHaveLength(0)
  })

  it('will not take a registration code as a reset code', async () => {
    await makeAccount()
    const { code } = await issueCode({ tenantId: 't1', email: PERSON, purpose: 'register' })
    await expect(auth.completePasswordReset({ email: PERSON, code, password: 'a-new-password-7' })).rejects.toThrow()
  })

  it('refuses a weak new password', async () => {
    await makeAccount()
    await auth.startPasswordReset({ email: PERSON })
    const code = sent[sent.length - 1]!.code as string
    await expect(auth.completePasswordReset({ email: PERSON, code, password: 'nonumbershere' })).rejects.toThrow(
      /number/i,
    )
  })

  it('records the reset in the audit trail without the password in it', async () => {
    await makeAccount()
    audited.length = 0
    await auth.startPasswordReset({ email: PERSON })
    const code = sent[sent.length - 1]!.code as string
    await auth.completePasswordReset({ email: PERSON, code, password: 'a-new-password-7' })

    const entry = audited.find((a) => a.action === 'auth.password_reset')
    expect(entry).toBeTruthy()
    expect(JSON.stringify(audited)).not.toContain('a-new-password-7')
    expect(JSON.stringify(audited)).not.toContain(code)
  })
})

describe('what the sign-in screen is told', () => {
  it('says email sign-in is available and never lists the administrators', () => {
    const caps = auth.authCapabilities()
    expect(caps).toMatchObject({ ready: true, emailSignIn: true, otpMinutes: 10, adminCount: 4 })
    expect(JSON.stringify(caps)).not.toContain('dtlpmanikandan@gmail.com')
  })

  it('offers no third-party sign-in, because there is none to offer', () => {
    const caps = auth.authCapabilities()
    expect(caps).toMatchObject({ ready: true, emailSignIn: true })
    expect(JSON.stringify(caps).toLowerCase()).not.toContain('google')
  })
})
