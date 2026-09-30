import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import jwt from 'jsonwebtoken'

// THE USAGE DASHBOARD'S ONE JOB IS NOT TO LIE.
//
// A usage panel is the classic place for invented numbers, because an empty
// chart looks broken and a full one looks like the feature works. So the
// properties worth pinning are all about absence:
//
//   · "no key configured" and "key configured, nothing used" are different
//     answers and must not collapse into the same zero
//   · a call the provider returned no token counts for is still a call, and
//     the response says how many of those there were
//   · the cost figure covers only the calls that were actually priced
//
// Read-only throughout: this endpoint writes nothing.

// WHO THIS TEST SIGNS IN AS (2026-09-30).
//
// This dashboard is administrators-only, and admin comes from the configured
// list of addresses and nowhere else — a stored role cannot grant it. So the
// test puts its own address on that list, in this process only, before any
// application module is loaded. dotenv does not overwrite a variable that is
// already set, which is what makes this work and also what keeps it from
// touching the real list on any server.
const ADMIN = { id: `usage-admin-${Date.now().toString(36)}`, email: `usage-admin@altiusnxt.test` }
const ORDINARY = { id: `usage-plain-${Date.now().toString(36)}`, email: `usage-plain@altiusnxt.test` }
process.env.AUTH_ADMIN_EMAILS = `${process.env.AUTH_ADMIN_EMAILS ?? ''},${ADMIN.email}`
process.env.AUTH_ALLOWED_EMAIL_DOMAINS = `${process.env.AUTH_ALLOWED_EMAIL_DOMAINS ?? ''},altiusnxt.test`

async function ready(): Promise<string | null> {
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    return `marketing database unavailable: ${(err as Error).message}`
  }
  if (!process.env.AUTH_JWT_SECRET) return 'AUTH_JWT_SECRET is not set'
  return null
}

const skipReason = await ready()
const describeIfReady = skipReason ? describe.skip : describe
if (skipReason) console.warn(`\n[geminiUsage] SKIPPED — ${skipReason}\n`)

const PREFIX = `usage-${Date.now().toString(36)}`

let server: Server
let base = ''
let tenantId = ''

describeIfReady('Gemini usage — counted, never estimated', () => {
  beforeAll(async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
    tenantId = tenant.id

    // An account and a role for each of the two callers. The token names the
    // account; the role and the admin list decide what it may reach.
    for (const [who, role] of [
      [ADMIN, 'admin'],
      [ORDINARY, 'operator'],
    ] as const) {
      await prisma.appUser.upsert({
        where: { id: who.id },
        create: { id: who.id, tenantId, email: who.email, name: who.email, emailVerified: true, status: 'active' },
        update: { status: 'active' },
      })
      await prisma.tenantMember.upsert({
        where: { tenantId_email: { tenantId, email: who.email } },
        create: { id: newId(), tenantId, email: who.email, name: who.email, role },
        update: { role },
      })
    }
    const { createServer } = await import('../../src/server.js')
    const app = createServer()
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 60_000)

  afterAll(async () => {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.llmCall.deleteMany({ where: { feature: { startsWith: PREFIX } } })
    const emails = [ADMIN.email, ORDINARY.email]
    await prisma.tenantMember.deleteMany({ where: { email: { in: emails } } })
    await prisma.appUser.deleteMany({ where: { email: { in: emails } } })
    await new Promise<void>((r) => server.close(() => r()))
  })

  /**
   * A session token of the kind this platform issues, for one of the two
   * accounts above. Signed with AUTH_JWT_SECRET and carrying this platform's
   * own issuer, because a token signed with anything else is refused.
   */
  const get = async (path: string, who = ADMIN) => {
    const { AUTH_ISSUER } = await import('../../src/auth/tokens.js')
    const token = jwt.sign({ email: who.email, iss: AUTH_ISSUER }, process.env.AUTH_JWT_SECRET!, {
      subject: who.id,
      expiresIn: 300,
    })
    const res = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  // Since 2026-09-30 this is an administrators-only dashboard: what Gemini has
  // cost is not something every operator sees.
  it('is refused to somebody who is not an administrator', async () => {
    const r = await get('/usage/gemini?days=30', ORDINARY)
    expect(r.status).toBe(403)
  })

  it('is reachable, and says which provider it is reporting on', async () => {
    const r = await get('/usage/gemini?days=30')
    expect(r.status).toBe(200)
    expect(r.body.provider).toBe('gemini')
  })

  // The load-bearing distinction. Whatever this environment holds, the
  // response must commit to one of the two and give a reason for it.
  it('separates "nothing recorded" from "nothing configured"', async () => {
    const r = await get('/usage/gemini?days=30')
    expect(typeof r.body.available).toBe('boolean')
    expect(typeof r.body.configured).toBe('boolean')
    if (r.body.available === false) {
      expect(String(r.body.unavailableReason).length).toBeGreaterThan(10)
      // No totals object at all, rather than an object full of zeros.
      expect(r.body.totals).toBeUndefined()
    }
  })

  it('never presents an estimate as a count', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    // Two calls: one the provider reported tokens for, one it did not.
    await prisma.llmCall.createMany({
      data: [
        {
          id: newId(),
          tenantId,
          feature: `${PREFIX}_counted`,
          provider: 'gemini',
          modelRequested: 'gemini-2.5-pro',
          model: 'gemini-2.5-pro',
          promptTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          hasUsageData: true,
          costUsd: '0.001200',
          priced: true,
          latencyMs: 900,
        },
        {
          id: newId(),
          tenantId,
          feature: `${PREFIX}_uncounted`,
          provider: 'gemini',
          modelRequested: 'gemini-2.5-pro',
          model: 'gemini-2.5-pro',
          promptTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          hasUsageData: false,
          costUsd: '0',
          priced: false,
          latencyMs: 700,
        },
      ],
    })

    const r = await get('/usage/gemini?days=1')
    expect(r.body.available).toBe(true)
    const totals = r.body.totals as Record<string, number>

    // The uncounted call is counted as a call and contributes zero tokens.
    expect(totals.calls).toBeGreaterThanOrEqual(2)
    expect(totals.callsWithoutUsageData).toBeGreaterThanOrEqual(1)

    // And the response says so in words, rather than leaving the reader to
    // infer it from two numbers that do not reconcile.
    const caveats = (r.body.caveats as string[]) ?? []
    expect(caveats.some((c) => /returned no token counts/i.test(c))).toBe(true)
    expect(caveats.some((c) => /no price recorded/i.test(c))).toBe(true)
  })

  it('names its scope as this project, not the API key', async () => {
    const r = await get('/usage/gemini?days=7')
    expect(r.body.scope).toBe('marketing_ai_project')
    expect(r.body.scopeLabel).toBe('Marketing AI project usage')
    expect(String(r.body.note)).toBe(
      'This dashboard reports Gemini usage recorded by this application only. Usage generated by other projects or ' +
        'applications using the same API key is not included.',
    )
    expect(String(r.body.scopeNote)).toContain('not a Google billing figure')
  })

  // WHY EXTERNAL USAGE CANNOT ENTER THIS DASHBOARD.
  //
  // Not because a WHERE clause excludes it, but because there is nowhere for
  // it to arrive. LlmCall has exactly one writer, and that writer is this
  // application's own Gemini gateway. These two tests pin both halves of that:
  // the singular writer, and the fact that the endpoint reads only that table.
  it('is fed by exactly one writer, which is this application’s own gateway', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry)
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
      })

    // Plain substring matching rather than regex literals: what is being
    // asserted is which files contain which call, and an escape is one more
    // place for this test to be wrong about its own question.
    const writers = walk('src').filter((file) => {
      const src = readFileSync(file, 'utf8')
      return ['.llmCall.create(', '.llmCall.createMany(', '.llmCall.upsert('].some((c) => src.includes(c))
    })

    // If this ever fails, a second path is writing usage rows and the
    // dashboard's promise needs re-examining rather than the test relaxing.
    const norm = (f: string) => f.split('\\').join('/')
    expect(writers.map(norm)).toEqual(['src/llm/tokenLedger.ts'])

    const callers = walk('src').filter((file) => {
      const src = readFileSync(file, 'utf8')
      // An actual call site, not a mention in a comment — this route file
      // documents the writer by name and must not count as one.
      return src.includes('await recordLlmCall(') && !file.endsWith('tokenLedger.ts')
    })
    expect(callers.map(norm)).toEqual(['src/llm/gemini/geminiGateway.ts'])
  })

  it('reads only this application’s ledger, and nothing that could hold another project', async () => {
    const { readFileSync } = await import('node:fs')
    const route = readFileSync('src/api/routes/usage.routes.ts', 'utf8')

    // One data source, and it is the application's own table.
    const reads = [...route.matchAll(/prisma\.([A-Za-z]+)\./g)].map((m) => m[1])
    expect([...new Set(reads)]).toEqual(['llmCall'])

    // No attempt to reach a billing or quota API of any kind.
    for (const forbidden of ['cloudbilling', 'googleapis.com', 'billingAccounts', 'fetch(']) {
      expect(route, forbidden).not.toContain(forbidden)
    }
  })

  it('never counts a row belonging to another tenant', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const before = await get('/usage/gemini?days=1')
    const beforeCalls = ((before.body.totals as { calls: number } | undefined)?.calls ?? 0)

    // A row that exists, is real, is Gemini, and is not ours.
    const foreignTenant = `${PREFIX}-foreign-tenant`
    await prisma.llmCall.create({
      data: {
        id: newId(),
        tenantId: foreignTenant,
        feature: `${PREFIX}_foreign`,
        provider: 'gemini',
        modelRequested: 'gemini-2.5-pro',
        model: 'gemini-2.5-pro',
        promptTokens: 999_999,
        outputTokens: 999_999,
        totalTokens: 1_999_998,
        hasUsageData: true,
        costUsd: '99.999999',
        priced: true,
        latencyMs: 10,
      },
    })

    const after = await get('/usage/gemini?days=1')
    const afterTotals = after.body.totals as { calls: number; totalTokens: number; costUsd: number } | undefined
    expect(afterTotals?.calls ?? 0).toBe(beforeCalls)
    expect(afterTotals?.totalTokens ?? 0).toBeLessThan(1_999_998)
    expect(afterTotals?.costUsd ?? 0).toBeLessThan(99)

    await prisma.llmCall.deleteMany({ where: { tenantId: foreignTenant } })
  })

  it('never counts a provider this dashboard does not report on', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const before = await get('/usage/gemini?days=1')
    const beforeCalls = ((before.body.totals as { calls: number } | undefined)?.calls ?? 0)

    await prisma.llmCall.create({
      data: {
        id: newId(),
        tenantId,
        feature: `${PREFIX}_other_provider`,
        provider: 'openai',
        modelRequested: 'gpt-4o',
        model: 'gpt-4o',
        promptTokens: 500_000,
        outputTokens: 500_000,
        totalTokens: 1_000_000,
        hasUsageData: true,
        costUsd: '50.000000',
        priced: true,
        latencyMs: 10,
      },
    })

    const after = await get('/usage/gemini?days=1')
    const afterTotals = after.body.totals as { calls: number; totalTokens: number } | undefined
    expect(afterTotals?.calls ?? 0).toBe(beforeCalls)
    expect(afterTotals?.totalTokens ?? 0).toBeLessThan(1_000_000)

    await prisma.llmCall.deleteMany({ where: { feature: `${PREFIX}_other_provider` } })
  })

  it('reports a whole-day window so two readers mean the same thing', async () => {
    const r = await get('/usage/gemini?days=7')
    const w = r.body.window as { from: string; days: number }
    expect(w.days).toBe(7)
    expect(new Date(w.from).toISOString()).toMatch(/T00:00:00\.000Z$/)
  })
})
