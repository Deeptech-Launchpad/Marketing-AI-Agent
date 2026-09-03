import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// TASK #983 integration tests, against the REAL Workbench.
//
// These drive the actual public HTTP surface — the same Express app the server
// runs — with a cookie jar, because the whole design rests on engagement being
// captured from genuine navigations rather than from client instrumentation.
// A test that called the adapter directly would prove nothing about that.
//
// Nothing external is contacted. No prospect is messaged. No row in NXT Sales
// is touched. The disposable link and every event these tests create are
// removed afterwards.

async function ready(): Promise<string | null> {
  if (process.env.CRM_DRIVER !== 'real') return `CRM_DRIVER is "${process.env.CRM_DRIVER}", not "real"`
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    return `marketing database unavailable: ${(err as Error).message}`
  }
  return null
}

const skipReason = await ready()
const describeIfReady = skipReason ? describe.skip : describe
if (skipReason) console.warn(`\n[engagement] SKIPPED — ${skipReason}\n`)

// ── A tiny cookie jar, so a visit behaves like a browser's ──────────────────

class Jar {
  private jar = new Map<string, string>()

  absorb(res: Response): void {
    // Node exposes multiple Set-Cookie headers through getSetCookie().
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    for (const line of raw) {
      const [pair] = line.split(';')
      const idx = pair?.indexOf('=') ?? -1
      if (idx > 0 && pair) this.jar.set(pair.slice(0, idx), pair.slice(idx + 1))
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  has(name: string): boolean {
    return this.jar.has(name)
  }

  get(name: string): string | undefined {
    return this.jar.get(name)
  }
}

/**
 * The session reference a jar will produce, derived the same way the server
 * does.
 *
 * These tests run against the SHARED real demonstration, which may already
 * carry events from other visits — a manual validation run, or a real one.
 * Scoping every assertion to the visits this file created is what keeps them
 * about this file's behaviour rather than about the state of the database.
 */
async function refOf(jar: Jar): Promise<string> {
  const { hashVisit } = await import('../../src/workbench/links.js')
  const cookie = jar.get('wb_visit')
  if (!cookie) throw new Error('this jar has no visit cookie yet')
  return hashVisit(decodeURIComponent(cookie))
}

let server: Server
let base: string
const created: string[] = []
let linkToken = ''
let demoId = ''
let crmCompanyId = ''
let tenantId = ''

async function get(path: string, jar: Jar, redirect: RequestRedirect = 'manual'): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    redirect,
    headers: jar.header() ? { cookie: jar.header() } : {},
  })
  jar.absorb(res)
  return res
}

async function post(path: string, jar: Jar, form: Record<string, string>): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(jar.header() ? { cookie: jar.header() } : {}),
    },
    body: new URLSearchParams(form).toString(),
  })
  jar.absorb(res)
  return res
}

/** Visits created by this file. Every assertion is scoped to these. */
const ourVisits = new Set<string>()

async function eventsFor(session?: string) {
  const { prisma } = await import('../../src/platform/db.js')
  return prisma.engagementEvent.findMany({
    where: {
      workbenchDemoId: demoId,
      sessionRef: session ? session : { in: [...ourVisits] },
    },
    orderBy: { occurredAt: 'asc' },
  })
}

beforeAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  const { createServer } = await import('../../src/server.js')
  const { mintLink } = await import('../../src/workbench/links.js')

  const demo = await prisma.workbenchDemo.findFirstOrThrow({ where: { status: 'ready' } })
  demoId = demo.id
  crmCompanyId = demo.crmCompanyId
  tenantId = demo.tenantId

  // A disposable link against the REAL demo, so the flow is genuine but the
  // link this test opens is not one anybody was sent.
  const link = await mintLink({
    tenantId: demo.tenantId,
    demoId: demo.id,
    createdByCrmUserId: 'engagement-integration-test',
    label: 'Task #983 integration test',
  })
  linkToken = link.token
  created.push(link.linkId)

  server = createServer().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  // Everything this file created, and nothing else — scoped to the visits it
  // made, so a real visit to the same demonstration is not deleted with it.
  await prisma.engagementEvent.deleteMany({
    where: { workbenchDemoId: demoId, sessionRef: { in: [...ourVisits] } },
  })
  await prisma.engagementIngestionRun.deleteMany({ where: { endpoint: { contains: 'test-provider' } } })
  await prisma.workbenchVisitor.deleteMany({ where: { linkId: { in: created } } })
  await prisma.workbenchLink.deleteMany({ where: { id: { in: created } } })
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describeIfReady('Task #983 — the real Workbench visit, end to end', () => {
  const jar = new Jar()
  let sessionRef = ''

  it('1. opening the link records the open and starts a visit', async () => {
    const res = await get(`/workbench/${linkToken}`, jar)
    expect(res.status).toBe(200)
    expect(jar.has('wb_visit')).toBe(true)
    ourVisits.add(await refOf(jar))

    const rows = await eventsFor()
    const types = rows.map((r) => r.eventType)
    expect(types).toContain('workbench_link_opened')
    expect(types).toContain('workbench_registration_started')

    // The visit reference is present on the very first event, not only from
    // the second page load onwards.
    const opened = rows.find((r) => r.eventType === 'workbench_link_opened')
    expect(opened?.sessionRef).toBeTruthy()
    sessionRef = opened!.sessionRef!
  })

  it('2. the company was resolved server-side from the token', async () => {
    const rows = await eventsFor(sessionRef)
    for (const row of rows) {
      expect(row.crmCompanyId).toBe(crmCompanyId)
      expect(row.tenantId).toBe(tenantId)
      expect(row.source).toBe('workbench_app')
    }
  })

  it('3. every event carries evidence of what, where and how', async () => {
    const rows = await eventsFor(sessionRef)
    for (const row of rows) {
      const e = row.evidence as { what?: string; how?: string }
      expect(e.what, `${row.eventType} has no "what"`).toBeTruthy()
      expect(e.how, `${row.eventType} has no "how"`).toBeTruthy()
      expect(e.what!.length).toBeGreaterThan(10)
    }
  })

  it('4. registering records the registration once', async () => {
    const res = await post(`/workbench/${linkToken}/register`, jar, {
      fullName: 'Integration Tester',
      companyName: 'AltiusNXT QA',
      workEmail: 'qa@example.invalid',
      jobTitle: 'Test Engineer',
    })
    expect(res.status).toBe(303)
    expect(jar.has('wb_session')).toBe(true)
    // The visit cookie survived the registration response.
    expect(jar.has('wb_visit')).toBe(true)

    const rows = await eventsFor(sessionRef)
    expect(rows.filter((r) => r.eventType === 'workbench_registration_completed')).toHaveLength(1)
  })

  it('5. the visit reference is continuous across registration', async () => {
    const rows = await eventsFor()
    const refs = new Set(rows.map((r) => r.sessionRef))
    // Acts before and after signing in belong to ONE visit, not two.
    expect(refs.size).toBe(1)
    expect(refs.has(sessionRef)).toBe(true)
  })

  it('6. viewing the comparison is recorded once however many refreshes', async () => {
    await get(`/workbench/${linkToken}`, jar)
    await get(`/workbench/${linkToken}`, jar)
    await get(`/workbench/${linkToken}`, jar)

    const rows = await eventsFor(sessionRef)
    expect(rows.filter((r) => r.eventType === 'workbench_viewed')).toHaveLength(1)
  })

  it('7. the page still carries no JavaScript', async () => {
    const res = await get(`/workbench/${linkToken}`, jar)
    const html = await res.text()
    // Task #981's property, unchanged by adding engagement capture.
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(res.headers.get('content-security-policy')).toBeTruthy()
    // The capture points are ordinary links.
    expect(html).toContain(`/workbench/${linkToken}/cta`)
    expect(html).toContain(`/workbench/${linkToken}/evidence`)
    expect(html).toContain('panel=before')
  })

  it('8. focusing a panel records the focus and the comparison', async () => {
    await get(`/workbench/${linkToken}?panel=before`, jar)
    const rows = await eventsFor(sessionRef)
    expect(rows.filter((r) => r.eventType === 'workbench_before_viewed')).toHaveLength(1)
    expect(rows.filter((r) => r.eventType === 'workbench_comparison_used').length).toBeGreaterThanOrEqual(1)
  })

  it('9. switching panels is a second comparison, not a duplicate', async () => {
    const before = (await eventsFor(sessionRef)).filter((r) => r.eventType === 'workbench_comparison_used').length
    await get(`/workbench/${linkToken}?panel=after`, jar)
    const after = (await eventsFor(sessionRef)).filter((r) => r.eventType === 'workbench_comparison_used').length

    // Two deliberate switches are two acts. Merging them would erase what the
    // prospect actually did.
    expect(after).toBe(before + 1)
    const rows = await eventsFor(sessionRef)
    expect(rows.filter((r) => r.eventType === 'workbench_after_viewed')).toHaveLength(1)
  })

  it('10. opening the evidence page is recorded', async () => {
    const res = await get(`/workbench/${linkToken}/evidence`, jar)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toMatch(/Where every value on this page came from/i)

    const rows = await eventsFor(sessionRef)
    expect(rows.filter((r) => r.eventType === 'workbench_evidence_viewed')).toHaveLength(1)
  })

  it('11. the CTA redirects through the server and records the click', async () => {
    const res = await get(`/workbench/${linkToken}/cta`, jar)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(process.env.WORKBENCH_CTA_URL ?? 'https://altiusnxt.com/book-a-walkthrough')

    const rows = await eventsFor(sessionRef)
    expect(rows.filter((r) => r.eventType === 'workbench_cta_clicked')).toHaveLength(1)
  })

  it('12. a second click minutes later would be a second event', async () => {
    // Same act, immediately: collapsed, because it is a double submit.
    await get(`/workbench/${linkToken}/cta`, jar)
    const rows = await eventsFor(sessionRef)
    expect(rows.filter((r) => r.eventType === 'workbench_cta_clicked')).toHaveLength(1)

    // A later click is a different bucket, so it survives. Proven on the key
    // rather than by sleeping through the window.
    const { dedupeKey } = await import('../../src/engagement/normalize.js')
    const t0 = new Date('2026-08-28T12:00:00Z')
    const t1 = new Date('2026-08-28T12:05:00Z')
    const args = { eventType: 'workbench_cta_clicked' as const, tenantId, crmCompanyId, sessionRef, referenceId: demoId }
    expect(dedupeKey({ ...args, occurredAt: t0 })).not.toBe(dedupeKey({ ...args, occurredAt: t1 }))
  })

  it('13. a QR scan is recorded only when the printed marker is present', async () => {
    // Nine requests so far in this visit, none of them carrying the marker.
    const before = (await eventsFor()).filter((r) => r.eventType === 'audit_report_qr_scanned').length
    expect(before).toBe(0)

    const fresh = new Jar()
    await get(`/workbench/${linkToken}?s=qr`, fresh)
    ourVisits.add(await refOf(fresh))

    const scans = (await eventsFor()).filter((r) => r.eventType === 'audit_report_qr_scanned')
    expect(scans).toHaveLength(1)
    // The limit of the signal is stated on the record itself.
    expect((scans[0]!.evidence as { how: string }).how).toMatch(/pasted URL/i)
  })

  it('14. the QR code encodes the marker that makes a scan distinguishable', async () => {
    const { workbenchQrUrl, workbenchUrl } = await import('../../src/workbench/links.js')
    expect(workbenchQrUrl('tok')).toBe(`${workbenchUrl('tok')}?s=qr`)
  })

  it('15. a second visitor is a separate visit, not a duplicate', async () => {
    const other = new Jar()
    await get(`/workbench/${linkToken}`, other)
    ourVisits.add(await refOf(other))

    const rows = await eventsFor()
    const refs = new Set(rows.map((r) => r.sessionRef))
    // Three browsers, three visits (the QR one included) — not one collapsed act.
    expect(refs.size).toBe(3)

    const starts = rows.filter((r) => r.eventType === 'workbench_registration_started')
    expect(starts.length).toBeGreaterThanOrEqual(2)
  })

  it('16. evidence is not a way around registration', async () => {
    const stranger = new Jar()
    const res = await get(`/workbench/${linkToken}/evidence`, stranger)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/workbench/${linkToken}`)
  })

  it('17. an unknown token records nothing at all', async () => {
    const before = (await eventsFor()).length
    const res = await get(`/workbench/${'z'.repeat(40)}`, new Jar())
    expect(res.status).toBe(404)
    expect((await eventsFor()).length).toBe(before)
  })

  it('18. a revoked link records nothing', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { mintLink } = await import('../../src/workbench/links.js')
    const temp = await mintLink({
      tenantId,
      demoId,
      createdByCrmUserId: 'engagement-integration-test',
      label: 'revoked link test',
    })
    created.push(temp.linkId)
    await prisma.workbenchLink.update({ where: { id: temp.linkId }, data: { revokedAt: new Date() } })

    const before = (await eventsFor()).length
    const res = await get(`/workbench/${temp.token}`, new Jar())
    expect(res.status).toBe(404)
    expect((await eventsFor()).length).toBe(before)
  })

  it('19. an expired link records nothing', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { mintLink } = await import('../../src/workbench/links.js')
    const temp = await mintLink({
      tenantId,
      demoId,
      createdByCrmUserId: 'engagement-integration-test',
      label: 'expired link test',
    })
    created.push(temp.linkId)
    await prisma.workbenchLink.update({
      where: { id: temp.linkId },
      data: { expiresAt: new Date('2020-01-01T00:00:00Z') },
    })

    const before = (await eventsFor()).length
    const res = await get(`/workbench/${temp.token}`, new Jar())
    expect(res.status).toBe(404)
    expect((await eventsFor()).length).toBe(before)
  })

  it('20. the whole visit reads as an ordered timeline', async () => {
    const { companyTimeline } = await import('../../src/engagement/timeline.js')
    const page = await companyTimeline({ tenantId, crmCompanyId, limit: 100 })

    expect(page.entries.length).toBeGreaterThan(5)
    for (let i = 1; i < page.entries.length; i++) {
      expect(page.entries[i - 1]!.occurredAt.getTime()).toBeGreaterThanOrEqual(
        page.entries[i]!.occurredAt.getTime(),
      )
    }
    // Freshness is read at query time and always carries the raw age.
    for (const entry of page.entries) {
      expect(['fresh', 'recent', 'old', 'unknown']).toContain(entry.freshnessLabel)
      expect(typeof entry.ageHours).toBe('number')
    }
  })
})

describeIfReady('Task #983 — the provider webhook boundary', () => {
  it('21. refuses an unsigned request and records the refusal', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const res = await fetch(`${base}/engagement/webhooks/test-provider`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'bounce', messageId: 'anything' }),
    })
    // No secret is configured on this installation, so the gate is shut.
    expect([401, 503]).toContain(res.status)

    const runs = await prisma.engagementIngestionRun.findMany({
      where: { endpoint: '/engagement/webhooks/test-provider' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.verified).toBe(false)
    expect(runs[0]!.rejected).toBe(1)
    expect(runs[0]!.accepted).toBe(0)
  })

  it('22. a forged signature is rejected', async () => {
    const { verifySignature } = await import('../../src/engagement/adapters/emailWebhookAdapter.js')
    const { env } = await import('../../src/config/env.js')

    const original = env.ENGAGEMENT_WEBHOOK_SECRET
    try {
      // Configured, so the refusal is about the signature and not about the
      // gate being shut — which test 21 already covers.
      ;(env as { ENGAGEMENT_WEBHOOK_SECRET: string }).ENGAGEMENT_WEBHOOK_SECRET = 'fixture-secret'
      const r = verifySignature('{}', 'sha256=00', String(Math.floor(Date.now() / 1000)))
      expect(r.ok).toBe(false)
      expect(r.rejection).toBe('bad_signature')

      // A missing signature is refused too, rather than treated as unsigned.
      expect(verifySignature('{}', undefined, undefined).rejection).toBe('missing_signature')
    } finally {
      ;(env as { ENGAGEMENT_WEBHOOK_SECRET: string }).ENGAGEMENT_WEBHOOK_SECRET = original
    }
  })

  it('23. a correct signature verifies, and a replayed one does not', async () => {
    const { verifySignature } = await import('../../src/engagement/adapters/emailWebhookAdapter.js')
    const { env } = await import('../../src/config/env.js')

    // Exercised as a fixture: with no provider configured there is no real
    // traffic, and inventing an email event would be fabricating data.
    const secret = 'fixture-secret'
    const body = JSON.stringify({ event: 'delivered', messageId: 'm1', eventId: 'e1' })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')

    const original = env.ENGAGEMENT_WEBHOOK_SECRET
    try {
      ;(env as { ENGAGEMENT_WEBHOOK_SECRET: string }).ENGAGEMENT_WEBHOOK_SECRET = secret
      expect(verifySignature(body, sig, ts).ok).toBe(true)

      // Replay of the same signed request, hours later: the timestamp is
      // inside the signed material, so it no longer verifies.
      const stale = String(Math.floor(Date.now() / 1000) - 7200)
      const staleSig = createHmac('sha256', secret).update(`${stale}.${body}`).digest('hex')
      const replay = verifySignature(body, staleSig, stale)
      expect(replay.ok).toBe(false)
      expect(replay.rejection).toBe('stale_timestamp')

      // A body altered after signing fails too.
      expect(verifySignature(`${body} `, sig, ts).ok).toBe(false)
    } finally {
      ;(env as { ENGAGEMENT_WEBHOOK_SECRET: string }).ENGAGEMENT_WEBHOOK_SECRET = original
    }
  })

  it('24. a payload naming a company it was not sent for cannot reach that company', async () => {
    const { mapProviderEvent } = await import('../../src/engagement/adapters/emailWebhookAdapter.js')
    const result = await mapProviderEvent(
      // A caller trying to write into an arbitrary account.
      { event: 'opened', messageId: 'no-such-message', crmCompanyId, tenantId } as never,
      'test-provider',
    )
    expect(result.ok).toBe(false)
    expect(result.rejection).toBe('unresolvable_reference')
  })

  it('25. an unmapped provider event is refused rather than stored', async () => {
    const { mapProviderEvent } = await import('../../src/engagement/adapters/emailWebhookAdapter.js')
    const result = await mapProviderEvent({ event: 'invented_event', messageId: 'm1' }, 'test-provider')
    expect(result.ok).toBe(false)
    expect(result.rejection).toBe('unknown_event')
  })
})

describeIfReady('Task #983 — outreach lifecycle over the real campaigns', () => {
  it('26. records the lifecycle of the real Task #982 actions', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { syncOutreachActions } = await import('../../src/engagement/adapters/outreachAdapter.js')

    const actions = await prisma.outreachAction.findMany({ where: { tenantId }, select: { id: true } })
    if (!actions.length) return

    const result = await syncOutreachActions(tenantId, {})
    expect(result.examined).toBe(actions.length)

    // Running it again adds nothing: the lifecycle types dedupe on the action.
    const again = await syncOutreachActions(tenantId, {})
    expect(again.recorded).toBe(0)
    expect(again.duplicate + again.skipped).toBe(actions.length)
  })

  it('27. no action claims a send that never happened', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const sent = await prisma.engagementEvent.count({ where: { tenantId, eventType: 'email_sent' } })
    const marked = await prisma.outreachAction.count({ where: { tenantId, status: 'sent' } })

    // Every email_sent event corresponds to an action the engine actually
    // marked sent. No email provider is configured, so in this environment
    // both are expected to be zero — but the test asserts the correspondence
    // rather than the zero, so it stays meaningful once a provider exists.
    expect(sent).toBe(marked)

    // And a draft or a dry run never becomes a send.
    const drafts = await prisma.outreachAction.count({
      where: { tenantId, status: { in: ['draft', 'ready_to_send'] } },
    })
    expect(drafts).toBeGreaterThan(0)
    expect(sent).toBeLessThanOrEqual(marked)
  })

  it('28. our own acts are reported separately from the prospect’s', async () => {
    const { engagementSummary } = await import('../../src/engagement/timeline.js')
    const summary = await engagementSummary(tenantId, crmCompanyId)

    expect(summary.totalEvents).toBe(summary.prospectEvents + summary.ourEvents)
    expect(summary.prospectEvents).toBeGreaterThan(0)
    // Absence is stated, not left out.
    expect(Array.isArray(summary.channelsNotObserved)).toBe(true)
    expect(summary.channelsObserved).toContain('workbench')
  })

  it('29. the summary exposes no score, total or rank', async () => {
    const { engagementSummary } = await import('../../src/engagement/timeline.js')
    const summary = await engagementSummary(tenantId, crmCompanyId)
    const keys = Object.keys(summary)
    for (const key of keys) {
      expect(/score|rating|level|rank|temperature|qualif/i.test(key), `summary.${key}`).toBe(false)
    }
  })

  it('30. NXT Sales is untouched by anything in this task', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const crm = getCrm()
    // The structural guarantee repeated at every stage: the port has no write
    // method, so an engagement event has nothing to write back through.
    const writeish = Object.keys(Object.getPrototypeOf(crm) as object).filter((m) =>
      /^(create|update|delete|write|save|patch|post|upsert)/i.test(m),
    )
    expect(writeish).toEqual([])
  })
})
