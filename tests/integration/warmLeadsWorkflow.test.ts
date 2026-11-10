import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// WARM LEADS - THE WHOLE WORKFLOW, END TO END, ON A REAL POSTGRES.
//
//   company list -> pilot request -> pilot preparation -> worker cycles -> screening, research, scoring, classification
//   -> stored results and counts -> pilot approval -> a failed re-check keeps the earlier result -> a Gemini ceiling is never "cold".
//
// Real: the database, the worker's own cycle (workerLoop.productionDeps), the scheduler and its limits, the claim queue,
// computeEvaluation, classify, the Gemini gateway and its database-backed call budget, the suppression list.
// Faked: NXT Sales (an in-memory CRM), the website fetch, the Intent research providers (they still make real, budgeted
// gateway calls to a stubbed Gemini endpoint) and the prompt store. Nothing reaches a network; no email is sent and nothing
// is written to NXT Sales. Uses its own throw-away tenant and removes what it created. Skipped when no database is reachable.

const world = vi.hoisted(() => {
  const w = {
    companies: [] as Array<Record<string, unknown>>,
    deals: [] as Array<Record<string, unknown>>,
    mail: {} as Record<string, Array<Record<string, unknown>>>,
    /** how the website read of a company ends: ok (default), none, reset */
    site: {} as Record<string, 'ok' | 'none' | 'reset'>,
    /** what the web research finds: events + how many Gemini calls it makes (default: nothing, 2 calls) */
    research: {} as Record<string, { calls?: number; events: Array<{ type: string; summary: string; url: string | null; daysAgo: number; confidence: string; fingerprint?: string }> }>,
    websiteReads: [] as string[],
    researchRuns: [] as string[],
    geminiUrls: [] as string[],
    /** the BODY of every request that reached the (stubbed) Gemini endpoint */
    geminiBodies: [] as string[],
    /** every attempt to write to NXT Sales (the transport is a recording stub: nothing ever leaves) */
    syncCalls: [] as Array<{ method: 'PUT' | 'DELETE'; path: string; body: unknown }>,
    crm: null as unknown as Record<string, (q?: any) => Promise<unknown>>,
  }
  w.crm = {
    searchCompanies: async (q: any = {}) => {
      const limit = q.limit ?? 500
      const page = q.page ?? 1
      const pool = q.lastActivity ? w.companies.filter((c) => (w.mail[c.id as string] ?? []).length > 0) : w.companies
      return { items: pool.slice((page - 1) * limit, page * limit), total: pool.length }
    },
    exportDeals: async () => w.deals.map((d) => ({ ...d })),
    listDeals: async (q: any) => w.deals.filter((d) => d.companyId === q.companyId).map((d) => ({ ...d })),
    // like NXT Sales: the response carries each email's text, and the adapter keeps it only when asked (withBody)
    listActivities: async (q: any) => (w.mail[q.companyId] ?? []).map((m) => (q.withBody ? { ...m } : { ...m, body: undefined })),
    getCompany: async (id: string) => w.companies.find((c) => c.id === id) ?? null,
  }
  return w
})

async function dbReady(): Promise<string | null> {
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1 FROM "WarmLeadUsage" LIMIT 1`
    return null
  } catch (err) {
    return `marketing database unavailable or the Warm Leads migrations are not applied: ${(err as Error).message}`
  }
}
const skip = await dbReady()
// A run that was asked to use the real database (TEST_USE_REAL=1, as the runbook says) must not pass by silently skipping.
if (skip && process.env.TEST_USE_REAL === '1') throw new Error(`[warm-leads workflow] TEST_USE_REAL=1 but ${skip}`)
const describeIfDb = skip ? describe.skip : describe
if (skip) console.warn(`\n[warm-leads workflow] SKIPPED — ${skip}\n`)

vi.mock('../../src/crm/index.js', () => ({ getCrm: () => world.crm }))
// the prompt shows its variables, exactly as a real prompt would: whatever the research puts into them is in the request body
vi.mock('../../src/llm/promptStore.js', () => ({ resolvePrompt: async (_key: string, variables: Record<string, unknown>) => ({ key: 'k', version: 1, systemInstruction: 's', userText: 'research ' + JSON.stringify(variables ?? {}), temperature: 0 }) }))
// The Warm Leads writes to NXT Sales go to a RECORDING transport: an attempt is recorded (and refused when the switch is off, as the real
// one refuses); nothing is ever sent anywhere.
vi.mock('../../src/crm/nxtSales/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crm/nxtSales/httpClient.js')>()
  const { env: liveEnv } = await import('../../src/config/env.js')
  const record = (method: 'PUT' | 'DELETE') => async (path: string, body?: unknown) => {
    world.syncCalls.push({ method, path, body })
    if (!liveEnv.WARM_LEADS_SYNC_ENABLED) throw new Error('Not sent to NXT Sales: WARM_LEADS_SYNC_ENABLED is off.')
  }
  return { ...actual, crmWarmLeadsPut: record('PUT'), crmWarmLeadsDelete: record('DELETE') }
})
vi.mock('../../src/llm/tokenLedger.js', () => ({ recordLlmCall: async () => undefined }))
vi.mock('../../src/enrichment/companyEnrichment.js', async () => {
  const { prisma, newId } = await import('../../src/platform/db.js')
  return {
    queueCompanyEnrichment: async (i: { tenantId: string; crmCompanyId: string }) => {
      world.websiteReads.push(i.crmCompanyId)
      const id = newId()
      await prisma.companyEnrichment.create({ data: { id, tenantId: i.tenantId, crmCompanyId: i.crmCompanyId, requestedByCrmUserId: 'wf', status: 'queued' } })
      return { id }
    },
    runCompanyEnrichment: async (id: string) => {
      const row = await prisma.companyEnrichment.findUniqueOrThrow({ where: { id } })
      const how = world.site[row.crmCompanyId] ?? 'ok'
      const domain = (world.companies.find((c) => c.id === row.crmCompanyId)?.domain as string | null) ?? null
      if (how === 'none' || !domain) await prisma.companyEnrichment.update({ where: { id }, data: { status: 'no_website', finishedAt: new Date() } })
      else if (how === 'reset') await prisma.companyEnrichment.update({ where: { id }, data: { status: 'unreachable', failureReason: 'The server reset the connection (ECONNRESET)', finishedAt: new Date() } })
      else
        await prisma.companyEnrichment.update({
          where: { id },
          data: { status: 'enriched', sourceUrl: `https://${domain}/`, signals: { finalUrl: `https://${domain}/`, hasProductSchema: true, pageTitle: 'Our products', metaDescription: 'Catalogue' }, technologies: [], finishedAt: new Date() },
        })
    },
  }
})
vi.mock('../../src/intent/intentDetection.js', async () => {
  const { prisma, newId } = await import('../../src/platform/db.js')
  return {
    queueIntentDetection: async (i: { tenantId: string; crmCompanyId: string }) => {
      const id = newId()
      await prisma.intentDetectionRun.create({ data: { id, tenantId: i.tenantId, crmCompanyId: i.crmCompanyId, requestedByCrmUserId: 'wf', status: 'queued' } })
      return { id }
    },
    runIntentDetection: async (id: string) => {
      const run = await prisma.intentDetectionRun.findUniqueOrThrow({ where: { id } })
      world.researchRuns.push(run.crmCompanyId)
      const spec = world.research[run.crmCompanyId] ?? { events: [] }
      const { GeminiGateway } = await import('../../src/llm/gemini/geminiGateway.js')
      const gateway = new GeminiGateway()
      for (let i = 0; i < (spec.calls ?? 2); i++) {
        try {
          const co = world.companies.find((c) => c.id === run.crmCompanyId)
          await gateway.generate({ promptKey: 'intent_public_research', variables: { companyName: co?.name, domain: co?.domain }, feature: 'intent_public_research' } as never)
        } catch {
          // like the real providers: whatever goes wrong, carry on with "nothing found"
        }
      }
      for (const e of spec.events) {
        await prisma.intentSignal.create({
          data: {
            id: newId(),
            tenantId: run.tenantId,
            intentRunId: id,
            crmCompanyId: run.crmCompanyId,
            eventFingerprint: e.fingerprint ?? newId(),
            signalType: e.type,
            signalCategory: 'business',
            summary: e.summary,
            interpretation: 'x',
            evidence: `quoted: ${e.summary}`,
            sourceUrl: e.url,
            sourceType: 'news_article',
            provider: 'test',
            observedAt: new Date(Date.now() - e.daysAgo * 86_400_000),
            confidence: e.confidence,
            polarity: 'positive',
            status: 'active',
            freshness: 'fresh',
          },
        })
      }
      await prisma.intentDetectionRun.update({ where: { id }, data: { status: 'completed', providerResults: [], completedAt: new Date() } })
    },
  }
})

const T = `wl-flow-${Math.random().toString(36).slice(2, 10)}`
const NOW = new Date('2026-11-05T19:00:00Z') // 00:30 IST: inside the 23:00-06:00 window
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

const company = (id: string, name: string, domain: string | null) => ({
  id,
  name,
  email: null,
  emails: [],
  phone: null,
  domain,
  industry: 'Retail',
  country: 'India',
  cms: null,
  leadStatus: null,
  status: null,
  remarks: null,
  notes: null,
  endPdpUrl: null,
  contactPersons: [],
  linkedProfiles: [],
  ownerId: null,
  ownerName: null,
  dealCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})
/** A marker that sits inside every email text: it must never appear in anything the module stores. */
const MARK = 'ZZ-BODY-MARKER-7391'
const reply = (companyId: string, subject: string, daysAgo: number, body: string) => ({ id: `${companyId}-${subject}-${daysAgo}`, type: 'email', companyId, subject, direction: 'inbound', createdAt: day(daysAgo), body: `${body} ${MARK}` })
/** A STRICT, standalone opt-out as NXT Sales returns it: the sender's address, our own mailbox, and no other word in the message. */
const strictOptOut = (companyId: string, daysAgo: number, from: string, id: string, body = 'UNSUBSCRIBE') => ({ id, type: 'email', companyId, subject: 'Re: Product data proposal', direction: 'inbound', createdAt: day(daysAgo), body, fromAddresses: [from], matchedAddress: from, ownAddresses: ['sales@ours.example'] })
const deal = (companyId: string, stage: string) => ({ id: `deal-${companyId}`, title: `Deal ${companyId}`, value: 1000, currency: 'USD', stage, companyId, companyName: companyId, ownerId: null, country: null, clientType: null, serviceRequirement: null, opportunityType: null, strategicImportance: null, expectedOutcome: null, poc: false, proposalShared: false, openDate: day(30), createdAt: day(30) })

/** [id, name, domain, what we expect after the pilot] */
const SCENARIOS = {
  warmReply: 'wf-warm-reply',
  warmEvents: 'wf-warm-events',
  early: 'wf-early',
  fitOnly: 'wf-fit-only',
  dupe: 'wf-dupe',
  republished: 'wf-republished',
  declined: 'wf-declined',
  refusedInText: 'wf-refused-in-text',
  latestRefusal: 'wf-latest-refusal',
  humanReview: 'wf-human-review',
  productOnly: 'wf-product-specific',
  unreadable: 'wf-unreadable-reply',
  agingEvent: 'wf-aging-event',
  noSiteReply: 'wf-nosite-reply',
  noData: 'wf-no-data',
  customer: 'wf-customer',
  opp: 'wf-opp',
  dnc: 'wf-dnc',
  blocked: 'wf-blocked',
} as const
const S = SCENARIOS

const { env } = await import('../../src/config/env.js')
const { prisma } = await import('../../src/platform/db.js')
// Server-side settings the opt-out code needs (test values only): the dedicated fingerprint key, and which domains are OURS.
env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'integration-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
env.WARM_LEADS_OWN_DOMAINS = 'ours.example'
const saved = { worker: env.WARM_LEADS_WORKER_ENABLED, key: env.WARM_LEADS_GEMINI_API_KEY, sync: env.WARM_LEADS_SYNC_ENABLED, fresh: env.INTENT_FRESH_DAYS, seed: env.WARM_LEADS_SAMPLE_SEED }
/** This test writes rows and removes them again: it only ever runs against a database on THIS machine. */
function assertLocalDatabase(): void {
  const url = process.env.MARKETING_DATABASE_URL ?? ''
  const host = /@([^:/?]+)/.exec(url)?.[1] ?? ''
  if (!['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(host)) throw new Error(`[warm-leads workflow] refusing to run: the database host is "${host || 'unknown'}", not this machine`)
}

async function cycles(): Promise<{ stoppedBecause: string; processed: number }[]> {
  const { productionDeps } = await import('../../src/warmleads/workerLoop.js')
  const { runCycle } = await import('../../src/warmleads/scheduler.js')
  const deps = { ...productionDeps(T), now: () => NOW, availableMb: () => Number.POSITIVE_INFINITY }
  const out: { stoppedBecause: string; processed: number }[] = []
  for (let i = 0; i < 6; i++) {
    const r = await runCycle(deps)
    out.push({ stoppedBecause: r.stoppedBecause, processed: r.processed })
    if (r.stoppedBecause !== 'repeated_failures' && r.processed === 0) break
    if (r.stoppedBecause === 'gemini_ceiling') break
  }
  return out
}
const row = (id: string) => prisma.warmLeadCompany.findUniqueOrThrow({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: id } } })

beforeAll(async () => {
  if (skip) return
  assertLocalDatabase()
  env.WARM_LEADS_WORKER_ENABLED = true
  env.INTENT_FRESH_DAYS = 30 // pinned: the fresh / aging line decides early signals
  env.WARM_LEADS_SAMPLE_SEED = 20261031
  env.WARM_LEADS_GEMINI_API_KEY = 'warm-leads-placeholder-key'
  env.WARM_LEADS_SYNC_ENABLED = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    world.geminiUrls.push(String(url))
    world.geminiBodies.push(String(init?.body ?? ''))
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Nothing about this company.' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

  const list: Array<[string, string, string | null]> = [
    [S.warmReply, 'Warm By Reply', 'warmreply.example'],
    [S.warmEvents, 'Warm By Events', 'warmevents.example'],
    [S.early, 'Early Signal Co', 'early.example'],
    [S.fitOnly, 'Fit Only Co', 'fitonly.example'],
    [S.dupe, 'One Announcement Twice', 'dupe.example'],
    [S.republished, 'Republished Next Day Co', 'republished.example'],
    [S.declined, 'Declined Co', 'declined.example'],
    [S.refusedInText, 'Refused In The Text Co', 'refusedtext.example'],
    [S.latestRefusal, 'Friendly Then Refused Co', 'latestrefusal.example'],
    [S.humanReview, 'Refused But Growing Co', 'humanreview.example'],
    [S.productOnly, 'Single Product Decline Co', 'productonly.example'],
    [S.unreadable, 'Unreadable Reply Co', 'unreadable.example'],
    [S.agingEvent, 'Old News Co', 'aging.example'],
    [S.noSiteReply, 'No Site But Replied', null],
    [S.noData, 'No Data Co', null],
    [S.customer, 'Customer Co', 'customer.example'],
    [S.opp, 'Open Deal Co', 'opp.example'],
    [S.dnc, 'Do Not Contact Co', 'dnc.example'],
    [S.blocked, 'Blocked Site Co', 'blocked.example'],
  ]
  world.companies = list.map(([id, name, domain]) => company(id, name, domain))
  world.mail = {
    [S.warmReply]: [reply(S.warmReply, 'Re: Product data proposal', 5, 'Thanks, we would like pricing and a demo next week. On Tue, 3 Nov 2026, Sales wrote: > to unsubscribe reply STOP')],
    [S.declined]: [reply(S.declined, 'Re: Please unsubscribe us', 4, 'Hello.')],
    // the SUBJECT is friendly; the person's own words refuse
    [S.refusedInText]: [reply(S.refusedInText, 'Re: Product data proposal', 4, 'Thanks for writing, but we are not interested at this time.')],
    // a friendly reply, then a later one that asks us to stop
    [S.latestRefusal]: [reply(S.latestRefusal, 'Re: Product data proposal', 20, 'Sounds good, send pricing.'), strictOptOut(S.latestRefusal, 2, 'lr@latestrefusal.example', 'act-lr', 'PLEASE STOP SENDING ME MARKETING EMAILS')],
    // asked to be removed, yet two fresh sourced events say it is growing: a person decides (HUMAN REVIEW), it is never a Warm lead
    [S.humanReview]: [reply(S.humanReview, 'Re: Product data proposal', 3, 'Kindly remove us from the Zebra distribution list.')],
    // the site cannot be read, so this evaluation FAILS - the opt-out evidence must be kept anyway
    [S.blocked]: [strictOptOut(S.blocked, 3, 'buyer@blocked.example', 'act-blocked')],
    // not interested in ONE product says nothing about the others: independent demand still counts
    [S.productOnly]: [reply(S.productOnly, 'Re: Product data proposal', 3, 'We are not interested in crates at the Quokka plant.')],
    // the newest reply has no words of its own (only a quoted copy), so it cannot be told from a refusal
    [S.unreadable]: [reply(S.unreadable, 'Re: Product data proposal', 3, 'On Tue, 3 Nov 2026, Sales <s@altius.example> wrote: hello there')],
    [S.noSiteReply]: [reply(S.noSiteReply, 'Re: hello', 3, 'Hello, please call me about the offer.')],
  }
  world.deals = [deal(S.customer, 'Won'), deal(S.opp, 'Proposal')]
  world.site[S.blocked] = 'reset'
  const ev = (type: string, summary: string, url: string, daysAgo: number, confidence = 'high', fingerprint?: string) => ({ type, summary, url, daysAgo, confidence, fingerprint })
  world.research[S.warmEvents] = { events: [ev('expansion', 'Opened a second distribution centre in Pune', 'https://news.example/warmevents/expansion', 5), ev('funding', 'Raised a Series A to grow its catalogue', 'https://news.example/warmevents/funding', 9)] }
  world.research[S.early] = { events: [ev('public_business_activity', 'Became an authorised service centre for CleanSpace respirators', 'https://early.example/blog/service-centre', 6)] }
  // the SAME announcement stored twice (two runs, different words, one has no date-free duplicate): must count once
  world.research[S.dupe] = {
    events: [
      ev('public_business_activity', 'ProSafety officially became a CleanSpace service center for respiratory devices.', 'https://dupe.example/en/blog', 7, 'high', 'fp-a'),
      ev('public_business_activity', 'ProSafety officially became a CleanSpace service center for respiratory devices in Germany.', 'https://dupe.example/en/blog/', 7, 'high', 'fp-b'),
    ],
  }
  // ONE announcement, republished on another site the next day: counted once (35, early signal), never a false Warm of 60
  world.research[S.republished] = {
    events: [
      ev('public_business_activity', 'Republished Next Day Co officially became a CleanSpace service center for respiratory devices.', 'https://republished.example/blog/service-center', 6, 'high', 'fp-r1'),
      ev('public_business_activity', 'Republished Next Day Co officially became a CleanSpace service center for respiratory devices, trade press reports.', 'https://trade-press.example/republished-next-day', 5, 'high', 'fp-r2'),
    ],
  }
  world.research[S.humanReview] = { events: [ev('expansion', 'Opened a regional office in Nagpur', 'https://news.example/humanreview/office', 6), ev('funding', 'Raised a bridge round to hire engineers', 'https://news.example/humanreview/funding', 8)] }
  world.research[S.productOnly] = { events: [ev('expansion', 'Commissioned a second packaging line in Surat', 'https://news.example/productonly/line', 6), ev('funding', 'Secured a working-capital facility from a bank', 'https://news.example/productonly/credit', 9)] }
  world.research[S.agingEvent] = { events: [ev('expansion', 'Opened a showroom in Surat', 'https://news.example/aging/showroom', 45)] }

  await prisma.suppressionEntry.create({ data: { id: `${T}-sup`, tenantId: T, scope: 'global', matchType: 'company', matchValue: S.dnc, reason: 'asked not to be contacted', source: 'manual' } })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  if (skip) return
  env.WARM_LEADS_WORKER_ENABLED = saved.worker
  env.WARM_LEADS_GEMINI_API_KEY = saved.key
  env.WARM_LEADS_SYNC_ENABLED = saved.sync
  env.INTENT_FRESH_DAYS = saved.fresh
  env.WARM_LEADS_SAMPLE_SEED = saved.seed
  await prisma.intentSignal.deleteMany({ where: { tenantId: T } })
  await prisma.intentDetectionRun.deleteMany({ where: { tenantId: T } })
  await prisma.companyEnrichment.deleteMany({ where: { tenantId: T } })
  await prisma.suppressionEntry.deleteMany({ where: { tenantId: T } })
  await prisma.warmLeadRun.deleteMany({ where: { tenantId: T } }) // evaluations go with their runs
  await prisma.warmLeadEvaluation.deleteMany({ where: { tenantId: T } })
  await prisma.warmLeadCompany.deleteMany({ where: { tenantId: T } })
  await prisma.warmLeadUsage.deleteMany({ where: { tenantId: T } })
  await prisma.warmLeadSettings.deleteMany({ where: { tenantId: T } })
  await prisma.auditEvent.deleteMany({ where: { tenantId: T } })
})

describeIfDb('the pilot, from request to review', () => {
  it('the company list, the pilot request and its preparation queue exactly the sampled companies', async () => {
    const settings = await import('../../src/warmleads/settings.js')
    const pilot = await import('../../src/warmleads/pilot.js')
    const companies = await import('../../src/warmleads/companies.js')

    await settings.ensureSettings(T)
    await companies.refreshCompanyList(T)
    expect((await companies.companyCounts(T)).total).toBe(19)
    await pilot.requestPilot(T, 'tester')
    expect(await pilot.preparePilot(T)).toBe(true)

    const run = await prisma.warmLeadRun.findFirstOrThrow({ where: { tenantId: T, kind: 'pilot' } })
    expect(run.status).toBe('queued')
    expect(run.total).toBe(19) // fewer than the 100 asked for are available, and the run says exactly that many
    expect(await prisma.warmLeadCompany.count({ where: { tenantId: T, state: 'queued', cohort: 'pilot' } })).toBe(19)
    // nothing has been evaluated yet and the worker is still paused
    expect((await settings.ensureSettings(T)).paused).toBe(true)
    expect(world.websiteReads).toHaveLength(0)
  })

  it('the worker, once started, evaluates every pilot company within its limits and stops with nothing left', async () => {
    const settings = await import('../../src/warmleads/settings.js')
    const { dbUsageStore } = await import('../../src/warmleads/usageStore.js')
    await settings.setPaused(T, false, 'tester')

    const runs = await cycles()
    expect(runs[0]!.processed).toBe(19)
    expect(runs.at(-1)!.stoppedBecause).toBe('nothing_to_do')

    const usage = await dbUsageStore.getBucket(T, 'pilot')
    expect(usage!.companiesStarted).toBe(19)
    // 13 companies had a readable shop site, so were flagged and researched: 2 budgeted Gemini calls each
    expect(new Set(world.researchRuns).size).toBe(13)
    expect(usage!.geminiCalls).toBe(26)
    expect(world.geminiUrls).toHaveLength(26)
    expect(world.geminiBodies).toHaveLength(26)
    expect(world.geminiUrls.every((u) => u.startsWith('https://generativelanguage.googleapis.com/'))).toBe(true)
    expect(usage!.geminiCalls).toBeLessThanOrEqual(usage!.geminiCeiling)
  })

  it('every company ends in the right status, for the right reason', async () => {
    const r = async (id: string) => {
      const c = await row(id)
      const ev = c.currentEvaluationId ? await prisma.warmLeadEvaluation.findUnique({ where: { id: c.currentEvaluationId } }) : null
      return { c, ev }
    }
    // Warm: a fresh reply written by a person (45) + the shop (10) = 55
    expect((await r(S.warmReply)).c).toMatchObject({ classification: 'warm', score: 55, state: 'evaluated' })
    // Warm: two fresh, sourced events (25 + 25) + the shop (10) = 60, no reply needed
    expect((await r(S.warmEvents)).c).toMatchObject({ classification: 'warm', score: 60 })
    // Early signal: one fresh sourced event (25) + the shop (10) = 35
    expect((await r(S.early)).c).toMatchObject({ classification: 'early_signal', score: 35 })
    // The same announcement stored twice counts ONCE: still an early signal at 35, never a warm 60
    const dupe = await r(S.dupe)
    expect(dupe.c).toMatchObject({ classification: 'early_signal', score: 35 })
    expect((dupe.ev!.reasons as Array<{ summary: string }>).filter((x) => /counted once/.test(x.summary))).toHaveLength(1)
    // The same announcement republished on a second URL the next day counts ONCE: an early signal, not a false Warm
    const republished = await r(S.republished)
    expect(republished.c).toMatchObject({ classification: 'early_signal', score: 35 })
    expect((republished.ev!.reasons as Array<{ summary: string }>).filter((x) => /counted once/.test(x.summary))).toHaveLength(1)
    // Shop and platform alone are fit, never intent: cold
    expect((await r(S.fitOnly)).c).toMatchObject({ classification: 'cold', score: 10 })
    // A reply that says "unsubscribe" is not interest
    const declined = await r(S.declined)
    expect(declined.c).toMatchObject({ classification: 'cold', score: 10 })
    expect((declined.ev!.reasons as Array<{ signal: string; points: number }>).find((x) => x.signal === 'reply_opt_out')).toMatchObject({ points: 0 })
    // A friendly subject but a refusal in the person's own words: not interest (the earlier "Warm By Reply" quoted an
    // "unsubscribe" footer and is still warm, because quoted text is not what the person wrote)
    const inText = await r(S.refusedInText)
    expect(inText.c).toMatchObject({ classification: 'cold', score: 10 })
    expect((inText.ev!.reasons as Array<{ signal: string; points: number; evidence: string }>).find((x) => x.signal === 'reply_declined')).toMatchObject({ points: 0, evidence: expect.stringContaining('kind: not_interested') })
    // A friendly reply followed by a later one that asks us to stop: the later one wins
    expect((await r(S.latestRefusal)).c).toMatchObject({ classification: 'cold', score: 10 })
    // The newest reply cannot be read (nothing but a quoted copy): unverified, listed, worth 0, never interest
    const unreadable = await r(S.unreadable)
    expect(unreadable.c).toMatchObject({ classification: 'cold', score: 10 })
    expect((unreadable.ev!.reasons as Array<{ signal: string; points: number }>).find((x) => x.signal === 'reply_unverified')).toMatchObject({ points: 0 })
    // Asked to be removed, but two fresh sourced events and the shop (60) say it is growing: HUMAN REVIEW, never Warm, and the reason is listed
    const review = await r(S.humanReview)
    expect(review.c).toMatchObject({ classification: 'human_review', score: 60, state: 'evaluated' })
    expect(review.c.summary).toMatch(/Human review required/)
    expect((review.ev!.reasons as Array<{ signal: string; points: number; evidence: string }>).find((x) => x.signal === 'reply_opt_out')).toMatchObject({ points: 0, evidence: expect.stringContaining('kind: opt_out') })
    // Not interested in ONE product does not disqualify the independent demand: still Warm
    expect((await r(S.productOnly)).c).toMatchObject({ classification: 'warm', score: 60 })
    // News that is not fresh does not qualify
    expect((await r(S.agingEvent)).c.classification).toBe('cold')
    // A fresh reply with no website is still an early signal (not cold, not insufficient)
    expect((await r(S.noSiteReply)).c).toMatchObject({ classification: 'early_signal', score: 45 })
    // Nothing to read at all: not enough data (never cold)
    expect((await r(S.noData)).c).toMatchObject({ classification: 'insufficient_data' })
    // The CRM's own statuses stay separate and are never "cold"
    expect((await r(S.customer)).c.classification).toBe('existing_customer')
    expect((await r(S.opp)).c.classification).toBe('active_opportunity')
    expect((await r(S.dnc)).c.classification).toBe('do_not_contact')
    // A site that could not be read is a failure to retry, not a classification
    const blocked = await r(S.blocked)
    expect(blocked.c).toMatchObject({ classification: null, state: 'failed' })
    expect(blocked.c.nextAttemptAt).not.toBeNull()
    expect(blocked.c.lastError).toMatch(/could not be read/i)
  })

  it('customers, open deals and do-not-contact companies are not approached or researched: their websites are never even read', () => {
    for (const id of [S.customer, S.opp, S.dnc]) {
      expect(world.websiteReads).not.toContain(id)
      expect(world.researchRuns).not.toContain(id)
    }
    // nor was a site read for a company that has none on record
    expect(world.researchRuns).not.toContain(S.noData)
    expect(world.researchRuns).not.toContain(S.blocked)
  })

  it('the text of the emails was read in memory and is nowhere in what was stored', async () => {
    const evals = await prisma.warmLeadEvaluation.findMany({ where: { tenantId: T } })
    const companies = await prisma.warmLeadCompany.findMany({ where: { tenantId: T } })
    const everything = JSON.stringify([evals, companies])
    expect(everything).not.toContain(MARK)
    expect(everything).not.toMatch(/please stop emailing us|we would like pricing|thanks for writing|Zebra|Quokka/i) // not even sentences or names from the bodies
    expect(everything).not.toMatch(/buyer@blocked|lr@latestrefusal|ravi@/i) // and no raw sender address: only masked forms
  })

  it('the pilot review list shows every opt-out found - masked, with its NXT activity, status and day - including one found by an evaluation that FAILED, and writes nothing', async () => {
    const { optOutReview } = await import('../../src/warmleads/optOutReview.js')
    const review = await optOutReview(T)
    const items = review.items
    expect(review).toMatchObject({ pendingCount: 2, complete: true }) // both proposals are still pending (none approved yet), none left out
    const proposals = items.filter((i) => i.kind === 'proposal')
    expect(proposals.map((p) => [p.crmCompanyId, p.activityId, p.status, p.masked]).sort()).toEqual([
      [S.blocked, 'act-blocked', 'dry_run', 'b***@blocked.example'],
      [S.latestRefusal, 'act-lr', 'dry_run', 'l***@latestrefusal.example'],
    ])
    // the blocked company's evaluation FAILED (its site could not be read), and still carries the opt-out evidence
    const failedEval = await prisma.warmLeadEvaluation.findUniqueOrThrow({ where: { id: proposals.find((p) => p.crmCompanyId === S.blocked)!.evaluationId } })
    expect(failedEval.status).toBe('failed')
    // opt-outs that may not be recorded automatically are listed for a person, with their activity
    const notRecorded = items.filter((i) => i.kind === 'not_recorded')
    expect(notRecorded.find((i) => i.crmCompanyId === S.humanReview)).toMatchObject({ status: 'needs_person', activityId: `${S.humanReview}-Re: Product data proposal-3` })
    expect(notRecorded.find((i) => i.crmCompanyId === S.declined)).toMatchObject({ status: 'needs_person' })
    // nothing raw, and nothing written
    expect(JSON.stringify(items)).not.toMatch(/[a-z0-9._-]{2,}@[a-z0-9.-]+/i)
    expect(await prisma.suppressionEntry.count({ where: { tenantId: T, matchType: 'email' } })).toBe(0)
  })

  it('what was sent to Gemini: the request BODIES carry the research prompt for the company, and nothing from any email', () => {
    // the instrumentation is live: every request body was recorded and shows the company details the research put into its prompt
    expect(world.geminiBodies.length).toBeGreaterThan(0)
    expect(world.geminiBodies.every((b) => b.length > 0)).toBe(true)
    expect(world.geminiBodies.some((b) => b.includes('Refused But Growing Co'))).toBe(true)
    // ... and none of them holds an email: not the marker, not a sentence, not a name that only appears inside a message
    const sent = world.geminiBodies.join('\n')
    expect(sent).not.toContain(MARK)
    expect(sent).not.toMatch(/Zebra|Quokka|please stop emailing|we would like pricing|thanks for writing|not interested/i)
  })

  it('the only code that asks the CRM for email text is the Warm Leads evaluation (a source scan: it fails if another reader starts asking)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.tsx?$/.test(name) && /withBody/.test(readFileSync(full, 'utf8'))) hits.push(full.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'))
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(hits.sort()).toEqual(['src/crm/crmPort.ts', 'src/crm/fake/fakeCrmAdapter.ts', 'src/crm/nxtSales/mappers.ts', 'src/crm/nxtSales/nxtSalesAdapter.ts', 'src/crm/types.ts', 'src/warmleads/optOutApproval.ts', 'src/warmleads/service.ts']) // the evaluation, and the admin approval of ONE opt-out proposal (it re-reads that single email, read only)
  })

  it('the counts keep every status apart and add up; nothing was sent to NXT Sales', async () => {
    const companies = await import('../../src/warmleads/companies.js')
    const { buildOverview } = await import('../../src/warmleads/view.js')
    const c = await companies.companyCounts(T)
    expect(c).toMatchObject({ total: 19, warm: 3, earlySignal: 4, cold: 6, insufficientData: 1, existingCustomer: 1, activeOpportunity: 1, doNotContact: 1, humanReview: 1, failed: 1, pending: 0, inProgress: 0 })
    expect(c.warm + c.earlySignal + c.cold + c.insufficientData + c.existingCustomer + c.activeOpportunity + c.doNotContact + c.humanReview).toBe(c.evaluated)
    expect(c.evaluated + c.failed).toBe(19)

    const o = await buildOverview(T, NOW)
    expect(o.stage).toBe('pilot_review')
    expect(o.pilot.canApprove).toBe(true)
    // the worker never even TRIED to write to NXT Sales (every attempt would have been recorded by the transport stub)
    expect(world.syncCalls).toEqual([])
    expect(await prisma.warmLeadCompany.count({ where: { tenantId: T, syncedEvaluationId: { not: null } } })).toBe(0)
    expect(o.settings.syncEnabled).toBe(false)
  })

  it('approving the pilot permits daily processing but leaves it paused', async () => {
    const pilot = await import('../../src/warmleads/pilot.js')
    const settings = await import('../../src/warmleads/settings.js')
    await pilot.approvePilot(T, 'tester')
    const s = await settings.ensureSettings(T)
    expect(s.pilotApprovedAt).not.toBeNull()
    expect(s.paused).toBe(true)
    expect(s.syncEnabled).toBe(false)
    // paused: a cycle does nothing, and no company changes
    const { productionDeps } = await import('../../src/warmleads/workerLoop.js')
    const { runCycle } = await import('../../src/warmleads/scheduler.js')
    const r = await runCycle({ ...productionDeps(T), now: () => NOW, availableMb: () => Number.POSITIVE_INFINITY })
    expect(r.stoppedBecause).toBe('paused')
  })
})

describeIfDb('what would be sent to NXT Sales (a recording transport: nothing leaves)', () => {
  it('with sending switched off the real gate stops it before anything is attempted', async () => {
    const { syncPending } = await import('../../src/warmleads/sync.js')
    const r = await syncPending(T)
    expect(r.skipped).toMatch(/WARM_LEADS_SYNC_ENABLED/)
    expect(r).toMatchObject({ put: 0, withdrawn: 0, failed: 0 })
    expect(world.syncCalls).toEqual([])
  })

  it('with every gate opened (in this test only): only Warm and Early Signal companies are sent; a company held for human review is not, and one already listed is withdrawn', async () => {
    const { syncPending } = await import('../../src/warmleads/sync.js')
    const review = await row(S.humanReview)
    // pretend it had been listed earlier (before the refusal arrived)
    await prisma.warmLeadCompany.update({ where: { id: review.id }, data: { syncedEvaluationId: review.currentEvaluationId, syncedAt: new Date() } })
    try {
      env.WARM_LEADS_SYNC_ENABLED = true
      await prisma.warmLeadSettings.update({ where: { tenantId: T }, data: { syncEnabled: true, syncApprovedAt: new Date(), syncApprovedBy: 'tester' } })
      const r = await syncPending(T, 100)
      expect(r.skipped).toBeNull()
      const last = (c: { path: string }) => decodeURIComponent(c.path.split('/').pop()!)
      const puts = world.syncCalls.filter((c) => c.method === 'PUT')
      const ids = puts.map(last).sort()
      const listed = await prisma.warmLeadCompany.findMany({ where: { tenantId: T, classification: { in: ['warm', 'early_signal'] } }, select: { crmCompanyId: true } })
      expect(ids).toEqual(listed.map((c) => c.crmCompanyId).sort())
      expect(ids).toContain(S.warmEvents)
      expect(ids).not.toContain(S.humanReview) // held for a person: never sent as a lead
      expect(ids).not.toContain(S.declined)
      expect(puts.every((c) => ['warm', 'early_signal'].includes((c.body as { classification: string }).classification))).toBe(true)
      // the company that is now held for review is withdrawn from NXT Sales' list
      expect(world.syncCalls.filter((c) => c.method === 'DELETE').map(last)).toEqual([S.humanReview])
      // and nothing a customer wrote, and no raw phrase, is in anything that would have been sent
      const payload = JSON.stringify(world.syncCalls)
      expect(payload).not.toContain(MARK)
      expect(payload).not.toMatch(/Zebra|Quokka|please stop emailing|unsubscribe us/i)
    } finally {
      env.WARM_LEADS_SYNC_ENABLED = false
      await prisma.warmLeadSettings.update({ where: { tenantId: T }, data: { syncEnabled: false, syncApprovedAt: null, syncApprovedBy: null } })
      await prisma.warmLeadCompany.updateMany({ where: { tenantId: T }, data: { syncedEvaluationId: null, syncedAt: null, syncError: null } })
      world.syncCalls.length = 0
    }
  })
})

describeIfDb('afterwards: re-checks, failures and the Gemini ceiling', () => {
  it('a later evaluation that FAILS keeps the earlier Warm result; the company is only marked for another check', async () => {
    const settings = await import('../../src/warmleads/settings.js')
    const before = await row(S.warmReply)
    world.site[S.warmReply] = 'reset' // the site now cannot be read
    world.site[S.blocked] = 'ok' // and the blocked one now can
    await prisma.warmLeadCompany.update({ where: { id: before.id }, data: { state: 'needs_reevaluation', attempts: 0, nextAttemptAt: new Date('2026-11-05T00:00:00Z') } })
    await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: S.blocked } }, data: { nextAttemptAt: new Date('2026-11-05T00:00:00Z'), attempts: 1 } })
    // a Warm company (two events) now has a reply that asks us to stop - and its site cannot be read on the re-check, so the
    // evaluation cannot finish: it must still stop being an actionable Warm lead
    const events = await row(S.warmEvents)
    world.mail[S.warmEvents] = [reply(S.warmEvents, 'Re: Product data proposal', 1, 'Please unsubscribe us.')]
    world.site[S.warmEvents] = 'reset'
    await prisma.warmLeadCompany.update({ where: { id: events.id }, data: { state: 'needs_reevaluation', attempts: 0, nextAttemptAt: new Date('2026-11-05T00:00:00Z') } })
    // a tiny ceiling for tonight and a brand-new company waiting: its research cannot finish
    world.companies.push(company('wf-late', 'Late Co', 'late.example'))
    const companies = await import('../../src/warmleads/companies.js')
    await companies.refreshCompanyList(T)
    await prisma.warmLeadSettings.update({ where: { tenantId: T }, data: { dailyGeminiCeiling: 5 } })
    await settings.setPaused(T, false, 'tester')

    const first = await cycles()
    expect(first.at(-1)!.stoppedBecause).toBe('gemini_ceiling')
    // incomplete research is never "cold": the company has NO classification yet and is due again
    const late = await row('wf-late')
    expect(late.classification).toBeNull()
    expect(late.researchIncomplete).toBe(true)
    expect(late.state).toBe('needs_reevaluation')

    // the ceiling is raised (within what was approved) and the retries run
    await prisma.warmLeadSettings.update({ where: { tenantId: T }, data: { dailyGeminiCeiling: 300 } })
    await cycles()

    const kept = await row(S.warmReply)
    expect(kept.classification).toBe('warm') // the earlier valid result stands
    expect(kept.score).toBe(55)
    expect(kept.currentEvaluationId).toBe(before.currentEvaluationId)
    expect(kept.state).toBe('needs_reevaluation')
    expect(kept.lastError).toMatch(/could not be read/i)

    // the Warm company whose re-check could not finish but whose newest reply refuses: held for a person, earlier score and evidence kept
    const held = await row(S.warmEvents)
    expect(held.classification).toBe('human_review')
    expect(held.score).toBe(60)
    expect(held.currentEvaluationId).toBe(events.currentEvaluationId)
    expect(held.summary).toMatch(/^Human review required/)
    expect(held.state).toBe('needs_reevaluation')
    const { syncAction } = await import('../../src/warmleads/companyState.js')
    expect(syncAction({ classification: held.classification, currentEvaluationId: held.currentEvaluationId, syncedEvaluationId: events.currentEvaluationId })).toBe('delete')

    const fixed = await row(S.blocked)
    expect(fixed.state).toBe('evaluated') // the retry worked once the site could be read
    expect(fixed.classification).toBe('cold')
    expect((await row('wf-late')).classification).toBe('cold') // research finished this time; nothing found
  })

  it('still nothing was sent anywhere: the later cycles attempted no write to NXT Sales either, and every Gemini call went to the stubbed endpoint', async () => {
    expect(world.syncCalls).toEqual([])
    expect(world.geminiUrls.every((u) => u.startsWith('https://generativelanguage.googleapis.com/'))).toBe(true)
    const { dbUsageStore } = await import('../../src/warmleads/usageStore.js')
    const day = await prisma.warmLeadUsage.findMany({ where: { tenantId: T, NOT: { bucket: 'pilot' } } })
    expect(day).toHaveLength(1)
    expect(day[0]!.geminiCalls).toBeLessThanOrEqual(day[0]!.geminiCeiling)
    void dbUsageStore
  })
})

// ── Explicit marketing opt-outs: dry run by default; the switch on (here only, throw-away tenant) writes ONE exact row ───────────────────
describeIfDb('an explicit opt-out: proposed in a dry run, recorded only with the switch on, durable, enforced by the real suppression gate', () => {
  const OO = 'wf-optout'
  const PERSIST = 'wf-persist'
  const OO_FROM = 'ravi@optout.example'
  // the opt-out exactly as written (no marker word added: a strict opt-out has no other word), from `from`; the address we mailed is a different one
  const optOutMail = (companyId: string, body: string, daysAgo: number, from = OO_FROM) => ({ ...strictOptOut(companyId, daysAgo, from, `${companyId}-act-${daysAgo}`, body), matchedAddress: 'info@optout.example' })
  const evaluate = async (id: string) => {
    const { computeEvaluation } = await import('../../src/warmleads/service.js')
    return computeEvaluation({ tenantId: T, crmCompanyId: id, requestedBy: 'tester', deepGate: async () => ({ allowed: false, reason: 'ceiling' }) })
  }
  const emailRows = () => prisma.suppressionEntry.findMany({ where: { tenantId: T, matchType: 'email' } })
  const reasonsOf = (c: Awaited<ReturnType<typeof evaluate>>) => ((c.result?.reasons ?? []) as Array<{ signal: string; summary: string; evidence: string | null; points: number }>)

  it('DRY RUN (the default): the masked address is listed, the other address is only a masked suggestion, and nothing is written', async () => {
    world.companies.push(company(OO, 'Opt Out Co', 'optout.example'))
    world.mail[OO] = [optOutMail(OO, 'UNSUBSCRIBE', 6)]
    expect(env.WARM_LEADS_RECORD_OPT_OUTS).toBe(false)
    const before = await prisma.suppressionEntry.count({ where: { tenantId: T } })
    const c = await evaluate(OO)
    expect(c.refusal).toBe(true)
    expect(c.optOuts).toEqual([]) // nothing to write
    const reasons = reasonsOf(c)
    const proposal = reasons.find((x) => x.signal === 'opt_out_proposal')!
    expect(proposal.summary).toMatch(/^r\*\*\*@optout\.example \(the sender of the opt-out of \d{4}-\d{2}-\d{2}\) is PROPOSED for the suppression list — DRY RUN: nothing was written/)
    expect(proposal.evidence).toMatch(/^status: dry_run · NXT activity wf-optout-act-6 · received \d{4}-\d{2}-\d{2}/)
    expect(proposal.evidence).toMatch(/i\*\*\*@optout\.example, is a different address and was NOT suppressed/)
    expect(reasons.find((x) => x.signal === 'contact_opt_out')).toMatchObject({ points: 0 })
    expect(JSON.stringify(reasons)).not.toMatch(/ravi@|info@|Zebra/) // masked only; nothing the person wrote
    expect(await prisma.suppressionEntry.count({ where: { tenantId: T } })).toBe(before)
  })

  it('SWITCH ON is NOT enough: the From header is unauthenticated, so the evaluation writes NOTHING and the proposal waits for a person', async () => {
    const mod = (await import('../../src/warmleads/optOut.js')) as Record<string, unknown>
    expect(mod.recordOptOuts).toBeUndefined() // there is no automatic writer at all
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      const c = await evaluate(OO)
      expect(c.optOuts).toHaveLength(1)
      expect(Object.keys(c.optOuts[0]!)).not.toContain('senderVerified')
      expect(await emailRows()).toHaveLength(0)
      const line = reasonsOf(c).find((x) => x.signal === 'opt_out_proposal')!
      expect(line.evidence).toMatch(/^status: awaiting_approval · NXT activity wf-optout-act-6 /)
      expect(line.summary).toMatch(/is NOT added yet: the sender of an email cannot be verified/)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('A PERSON\'S APPROVAL writes exactly one global email row, source "unsubscribe", naming the approver - once however often it runs, no second address, no domain, no company', async () => {
    const { writeApprovedOptOut } = await import('../../src/warmleads/optOut.js')
    const audit = { resourceId: 'wf-optout|act', summary: (st: string) => `approved (${st})`, metadata: { independentlyVerifiedConfirmed: true } }
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      const c = await evaluate(OO)
      expect((await writeApprovedOptOut(T, c.optOuts[0]!, 'admin-1', audit)).status).toBe('recorded')
      expect((await writeApprovedOptOut(T, c.optOuts[0]!, 'admin-1', audit)).status).toBe('already_listed') // idempotent: nothing is written twice
      const rows = await emailRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tenantId: T, scope: 'global', matchType: 'email', matchValue: OO_FROM, source: 'unsubscribe', expiresAt: null, campaignId: null, createdByCrmUserId: 'admin-1' })
      expect(rows[0]!.reason).toMatch(/^Opt-out request in an email reply on \d{4}-\d{2}-\d{2} \(NXT activity [^)]+\); approved by a person who verified it through a trusted contact channel \(read by Warm Leads\)$/)
      expect(rows[0]!.reason).not.toMatch(/UNSUBSCRIBE|Zebra|remove us/)
      expect(await prisma.suppressionEntry.count({ where: { tenantId: T, source: 'unsubscribe' } })).toBe(1) // not the suggested info@ address, no domain, no company
      expect(await prisma.suppressionEntry.count({ where: { tenantId: T, matchValue: { contains: 'info@' } } })).toBe(0)
      expect(await prisma.suppressionEntry.count({ where: { tenantId: T, matchType: { in: ['domain'] } } })).toBe(0)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('a NON-STRICT opt-out (it also asks for a quote) is held for a person: no proposal and no suppression row - even with the switch on', async () => {
    world.companies.push(company('wf-mixed', 'Mixed Co', 'mixed.example'))
    world.mail['wf-mixed'] = [optOutMail('wf-mixed', 'Please stop sending me marketing emails, but I do need a quote for 500 crates.', 4, 'mix@mixed.example')]
    const before = await prisma.suppressionEntry.count({ where: { tenantId: T } })
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      const c = await evaluate('wf-mixed')
      expect(c.optOuts).toEqual([])
      const reasons = reasonsOf(c)
      expect(reasons.some((x) => x.signal === 'opt_out_proposal')).toBe(false)
      expect(reasons.find((x) => x.signal === 'opt_out_not_recorded')!.evidence).toMatch(/^status: needs_person · NXT activity wf-mixed-act-4 · received /)
      expect(reasons.some((x) => x.signal === 'contact_opt_out')).toBe(true) // still held for a person
      expect(c.refusal).toBe(true)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
    expect(await prisma.suppressionEntry.count({ where: { tenantId: T } })).toBe(before)
  })

  it('DURABLE: with the switch off again, the row alone keeps the opt-out in force against a later quote request, and a would-be-Warm company stays in human review', async () => {
    world.companies.push(company(PERSIST, 'Persisted Opt Out Co', 'optout.example'))
    // the opt-out is far outside the 90-day window; only a recent, friendly quote request is read
    world.mail[PERSIST] = [{ ...reply(PERSIST, 'Re: Product data proposal', 2, 'Thanks, please send the quote for 500 crates.'), fromAddresses: [OO_FROM], matchedAddress: 'info@optout.example', ownAddresses: ['sales@ours.example'] }]
    world.research[PERSIST] = { events: [] }
    const c = await evaluate(PERSIST)
    const reasons = reasonsOf(c)
    expect(reasons.find((x) => x.signal === 'contact_opt_out')!.evidence).toMatch(/1 address\(es\) on the suppression list as an opt-out; r\*\*\*@optout\.example/)
    expect(reasons.find((x) => x.signal === 'inbound_engagement')).toMatchObject({ points: 45 }) // buying intent is still judged ...
    expect(c.refusal).toBe(true) // ... but permission stays withdrawn
    // a fresh reply (45) + the shop (10) = 55 would be Warm - but a contact of this company is on the suppression list, so a person decides
    expect(c.result).toMatchObject({ classification: 'human_review', score: 55 })
    expect(c.result!.summary).toMatch(/^Human review required: .* a contact has opted out of marketing email .* only a person can/)
    // the identical evidence for a company with nobody on the list is Warm
    world.companies.push(company('wf-clean', 'Clean Co', 'clean.example'))
    world.mail['wf-clean'] = [{ ...reply('wf-clean', 'Re: Product data proposal', 2, 'Thanks, please send the quote for 500 crates.'), fromAddresses: ['buyer@clean.example'], matchedAddress: 'buyer@clean.example', ownAddresses: ['sales@ours.example'] }]
    expect((await evaluate('wf-clean')).result).toMatchObject({ classification: 'warm', score: 55 })
  })

  it('the REAL suppression gate that Bulk Email calls (review, start and send time) stops exactly that address and no other', async () => {
    const { checkSuppression } = await import('../../src/outreach/suppression.js')
    const gate = (email: string) => checkSuppression({ tenantId: T, crmCompanyId: 'bulk:optout', companyName: 'Opt Out Co', companyDomain: email.split('@')[1] ?? null, destination: email, channel: 'email', openDealCheck: 'skip' })
    const blocked = await gate(OO_FROM)
    expect(blocked).toMatchObject({ suppressed: true, reason: 'opt_out' })
    expect((await gate('Ravi@Optout.Example')).suppressed).toBe(true) // the gate lower-cases
    expect((await gate('info@optout.example')).suppressed).toBe(false) // the suggested address was NOT suppressed
    expect((await gate('someone.else@optout.example')).suppressed).toBe(false) // nobody else at the domain
    // Bulk Email calls that gate at review, at start and again at the moment of sending (so queued mail is skipped too)
    const { readFileSync } = await import('node:fs')
    const bulk = readFileSync('src/outreach/bulk/service.ts', 'utf8')
    expect(bulk.match(/await checkSuppression\(/g)!.length).toBeGreaterThanOrEqual(4)
    expect(/async function sendOne[\s\S]{0,900}await checkSuppression\(/.test(bulk)).toBe(true)
    // and the company-level "do not contact" is NOT triggered by an email row
    const { CrmSignalProvider } = await import('../../src/intent/providers/crmProvider.js')
    expect(CrmSignalProvider).toBeTruthy()
    expect(await prisma.suppressionEntry.count({ where: { tenantId: T, matchType: { in: ['company', 'domain'] }, source: 'unsubscribe' } })).toBe(0)
  })
})

// ── The approval endpoint's service, on the real database: the address comes from the source email, the tenant from the login ─────────────
describeIfDb('approving a stored opt-out proposal (real database, fake CRM): only a person, only this tenant, only what the email still says', () => {
  const COMPANY = S.latestRefusal // its evaluation stored a dry-run proposal for activity "act-lr" during the pilot
  const approve = async (over: Record<string, unknown> = {}) => {
    const { approveOptOut } = await import('../../src/warmleads/optOutApproval.js')
    return approveOptOut({ tenantId: T, approverCrmUserId: 'admin-1', crmCompanyId: COMPANY, activityId: 'act-lr', independentlyVerified: true, verificationMethod: 'phone_call_known_number', ...over })
  }
  const reveal = async (over: Record<string, unknown> = {}) => {
    const { revealOptOutAddress } = await import('../../src/warmleads/optOutApproval.js')
    return revealOptOutAddress({ tenantId: T, adminCrmUserId: 'admin-1', crmCompanyId: COMPANY, activityId: 'act-lr', ...over })
  }
  /** the approval and reveal audit rows this suite's tenant has for the proposal */
  const decisionAudits = () => prisma.auditEvent.count({ where: { tenantId: { startsWith: T }, action: { in: ['warmleads.opt_out_approved', 'warmleads.opt_out_address_revealed'] }, resourceId: `${COMPANY}|act-lr` } })

  it('NULL or MISMATCHED company id on the activity: approval and reveal are refused (real database) - nothing is written, nothing is audited', async () => {
    const original = world.mail[COMPANY]!
    const before = await decisionAudits()
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      for (const [companyId, expected] of [[null, /does not link that email to any company/], [undefined, /does not link that email to any company/], ['', /does not link that email to any company/], ['wf-some-other-company', /different company than the one submitted/], [COMPANY.toUpperCase(), /different company than the one submitted/]] as const) {
        world.mail[COMPANY] = original.map((m) => (m.id === 'act-lr' ? { ...m, companyId } : m))
        await expect(approve(), String(companyId)).rejects.toThrow(expected)
        await expect(reveal(), String(companyId)).rejects.toThrow(expected)
      }
      expect(await lrRows()).toHaveLength(0)
      expect(await decisionAudits()).toBe(before)
    } finally {
      world.mail[COMPANY] = original
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('CROSS-TENANT (real database): another tenant - with the same company on its own list, or none - can neither approve nor reveal this tenant\'s proposal', async () => {
    const other = `${T}-other`
    await prisma.warmLeadCompany.create({ data: { id: `${other}-row`, tenantId: other, crmCompanyId: COMPANY, name: 'Same company id, other tenant' } })
    const before = await decisionAudits()
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      // it has the company on its list, but no proposal of its own: the activity id of ANOTHER tenant's proposal is not accepted
      await expect(approve({ tenantId: other })).rejects.toThrow(/no opt-out proposal/)
      await expect(reveal({ tenantId: other })).rejects.toThrow(/no opt-out proposal/)
      // a tenant without the company on its list never gets as far as the proposals
      await expect(approve({ tenantId: `${T}-nobody` })).rejects.toThrow(/not in your Warm Leads list/)
      await expect(reveal({ tenantId: `${T}-nobody` })).rejects.toThrow(/not in your Warm Leads list/)
      expect(await lrRows()).toHaveLength(0)
      expect(await prisma.suppressionEntry.count({ where: { tenantId: { startsWith: `${T}-` } } })).toBe(0)
      expect(await decisionAudits()).toBe(before)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
      await prisma.warmLeadCompany.deleteMany({ where: { tenantId: other } })
    }
  })

  it('an administrator can REVEAL the exact address of the proposal (real database): audited without the address, nothing stored, nothing suppressed', async () => {
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      const before = await decisionAudits()
      const r = await reveal()
      expect(r).toMatchObject({ address: 'lr@latestrefusal.example', masked: 'l***@latestrefusal.example', activityId: 'act-lr', authenticated: false })
      const rows = await prisma.auditEvent.findMany({ where: { tenantId: T, action: 'warmleads.opt_out_address_revealed', resourceId: `${COMPANY}|act-lr` } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ actorCrmUserId: 'admin-1', actorType: 'user', dataClass: 'customer_pii' })
      expect(await decisionAudits()).toBe(before + 1)
      // the exact address is nowhere in what is stored: not the audit, not any evaluation's reasons
      expect(JSON.stringify(rows)).not.toContain('lr@latestrefusal')
      const evals = await prisma.warmLeadEvaluation.findMany({ where: { tenantId: T }, select: { reasons: true } })
      expect(JSON.stringify(evals)).not.toContain('lr@latestrefusal')
      expect(await lrRows()).toHaveLength(0)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })
  const lrRows = () => prisma.suppressionEntry.findMany({ where: { tenantId: T, matchValue: 'lr@latestrefusal.example' } })

  it('with the switch OFF it refuses, reads nothing and writes nothing', async () => {
    expect(env.WARM_LEADS_RECORD_OPT_OUTS).toBe(false)
    await expect(approve()).rejects.toThrow(/switched off/)
    expect(await lrRows()).toHaveLength(0)
  })

  it('it refuses a proposal that is not this tenant\'s, an unknown activity, and a line that is not a proposal - and writes nothing', async () => {
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      await expect(approve({ tenantId: 'some-other-tenant' })).rejects.toThrow(/not in your Warm Leads list/)
      await expect(approve({ activityId: 'act-does-not-exist' })).rejects.toThrow(/no opt-out proposal/)
      // the held-for-a-person line of another company is not a proposal
      await expect(approve({ crmCompanyId: S.humanReview, activityId: `${S.humanReview}-Re: Product data proposal-3` })).rejects.toThrow(/no opt-out proposal/)
      expect(await lrRows()).toHaveLength(0)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('a FORGED change after the proposal cannot redirect the approval: if the email now shows another sender, or is no longer a plain opt-out, nothing is added', async () => {
    const original = world.mail[COMPANY]!
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      world.mail[COMPANY] = original.map((m) => (m.id === 'act-lr' ? { ...m, fromAddresses: ['victim@thirdparty.example'] } : m))
      await expect(approve()).rejects.toThrow(/not the address that was proposed/)
      world.mail[COMPANY] = original.map((m) => (m.id === 'act-lr' ? { ...m, body: 'PLEASE STOP SENDING ME MARKETING EMAILS, and send the catalogue first.' } : m))
      await expect(approve()).rejects.toThrow(/no longer a plain standalone opt-out/)
      world.mail[COMPANY] = original.map((m) => (m.id === 'act-lr' ? { ...m, fromAddresses: ['a@x.example', 'b@x.example'] } : m))
      await expect(approve()).rejects.toThrow(/no longer a plain standalone opt-out/)
      expect(await lrRows()).toHaveLength(0)
      expect(await prisma.suppressionEntry.count({ where: { tenantId: T, matchValue: { contains: 'victim@' } } })).toBe(0)
    } finally {
      world.mail[COMPANY] = original
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('CONCURRENT approvals of the same address (real database): exactly one row, exactly one "recorded", the others "already_listed", all audited, none failed', async () => {
    const { writeApprovedOptOut } = await import('../../src/warmleads/optOut.js')
    const proposalFor = (address: string, n: number) => ({ address, masked: 'c***@race.example', fingerprint: null, keyId: null, suggestion: null, receivedOn: '2026-11-03', activityId: `race-act-${n}`, mode: 'record' as const, phrase: 'UNSUBSCRIBE' })
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      for (let round = 0; round < 12; round++) {
        const address = `concurrent${round}@race.example`
        const resourceId = `race|${round}`
        const audit = { resourceId, summary: (s: string) => `approved (${s})`, metadata: { independentlyVerifiedConfirmed: true } }
        const results = await Promise.all([1, 2, 3, 4].map(() => writeApprovedOptOut(T, proposalFor(address, round), 'admin-1', audit)))
        const statuses = results.map((r) => r.status).sort()
        expect(statuses, `round ${round}`).toEqual(['already_listed', 'already_listed', 'already_listed', 'recorded'])
        expect(await prisma.suppressionEntry.count({ where: { tenantId: T, matchValue: address } }), `round ${round}`).toBe(1)
        const audits = await prisma.auditEvent.findMany({ where: { tenantId: T, action: 'warmleads.opt_out_approved', resourceId }, select: { summary: true } })
        expect(audits, `round ${round}`).toHaveLength(4) // each approval is a real, recorded decision
        expect(audits.filter((a) => a.summary === 'approved (recorded)'), `round ${round}`).toHaveLength(1) // and only ONE of them says a row was added
      }
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
      await prisma.suppressionEntry.deleteMany({ where: { tenantId: T, matchValue: { endsWith: '@race.example' } } })
      await prisma.auditEvent.deleteMany({ where: { tenantId: T, action: 'warmleads.opt_out_approved', resourceId: { startsWith: 'race|' } } })
    }
  })

  it('a TEMPORARY entry that appears for the address is never reported as "recorded" (real database)', async () => {
    const { writeApprovedOptOut } = await import('../../src/warmleads/optOut.js')
    const address = 'temporary@race.example'
    await prisma.suppressionEntry.create({ data: { id: 'race-temp-1', tenantId: T, scope: 'global', matchType: 'email', matchValue: address, reason: 'temporary', source: 'manual', expiresAt: new Date(Date.now() + 86_400_000) } })
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      const res = await writeApprovedOptOut(T, { address, masked: 't***@race.example', fingerprint: null, keyId: null, suggestion: null, receivedOn: '2026-11-03', activityId: 'race-act-t', mode: 'record', phrase: 'UNSUBSCRIBE' }, 'admin-1', { resourceId: 'race|temp', summary: (s) => `approved (${s})`, metadata: {} })
      expect(res.status).toBe('needs_person')
      expect(await prisma.suppressionEntry.count({ where: { tenantId: T, matchValue: address } })).toBe(1) // untouched
      expect(await prisma.auditEvent.count({ where: { tenantId: T, resourceId: 'race|temp' } })).toBe(0)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
      await prisma.suppressionEntry.deleteMany({ where: { tenantId: T, matchValue: address } })
    }
  })

  it('WITHOUT the confirmation of an independent check nothing is written', async () => {
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      await expect(approve({ independentlyVerified: false })).rejects.toThrow(/verified independently/)
      expect(await lrRows()).toHaveLength(0)
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('ATOMIC on the real database: if the audit insert fails, the suppression row is rolled back too (the next test then records it exactly once)', async () => {
    // a trigger (in this disposable test database only) makes the audit insert for approvals fail
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION marketing.wl_fail_audit() RETURNS trigger AS $$ BEGIN IF NEW."action" = 'warmleads.opt_out_approved' THEN RAISE EXCEPTION 'audit insert refused (test)'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER wl_fail_audit_trg BEFORE INSERT ON marketing."AuditEvent" FOR EACH ROW EXECUTE FUNCTION marketing.wl_fail_audit()`)
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      const auditsBefore = await prisma.auditEvent.count({ where: { tenantId: T, action: 'warmleads.opt_out_approved' } })
      await expect(approve()).rejects.toThrow(/could not be recorded/)
      expect(await lrRows()).toHaveLength(0) // rolled back: no record, no change
      expect(await prisma.auditEvent.count({ where: { tenantId: T, action: 'warmleads.opt_out_approved' } })).toBe(auditsBefore)
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS wl_fail_audit_trg ON marketing."AuditEvent"')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS marketing.wl_fail_audit()')
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('a person\'s approval writes ONE row naming the approver, is audited without the address, blocks that address in the REAL Bulk Email gate and no one else, and is idempotent', async () => {
    const { checkSuppression } = await import('../../src/outreach/suppression.js')
    const gate = (email: string) => checkSuppression({ tenantId: T, crmCompanyId: 'bulk:lr', companyName: 'LR Co', companyDomain: email.split('@')[1] ?? null, destination: email, channel: 'email', openDealCheck: 'skip' })
    try {
      env.WARM_LEADS_RECORD_OPT_OUTS = true
      const r = await approve()
      expect(r).toMatchObject({ status: 'recorded', masked: 'l***@latestrefusal.example', activityId: 'act-lr' })
      const rows = await lrRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tenantId: T, scope: 'global', matchType: 'email', source: 'unsubscribe', expiresAt: null, createdByCrmUserId: 'admin-1' })
      expect((await approve()).status).toBe('already_listed') // the second approval changes nothing
      expect(await lrRows()).toHaveLength(1)
      // enforced by the gate Bulk Email calls at review, start and send time - for that address only
      expect(await gate('lr@latestrefusal.example')).toMatchObject({ suppressed: true, reason: 'opt_out' })
      expect((await gate('someone.else@latestrefusal.example')).suppressed).toBe(false)
      // audited, without the address
      const audits = await prisma.auditEvent.findMany({ where: { tenantId: T, action: 'warmleads.opt_out_approved', resourceId: `${COMPANY}|act-lr` }, orderBy: { createdAt: 'asc' } })
      expect(audits).toHaveLength(2) // the approval, and the second approval of the same address (audited too, nothing written)
      expect(audits[0]).toMatchObject({ actorCrmUserId: 'admin-1', resourceId: `${COMPANY}|act-lr`, actorType: 'user' })
      expect(JSON.stringify(audits)).not.toContain('lr@latestrefusal')
      // who, when and how: the admin's id, the approval time and the structured verification method
      expect(audits[0]!.metadata).toMatchObject({ approvedByCrmUserId: 'admin-1', verification: { method: 'phone_call_known_number', independentlyVerifiedConfirmed: true, attestedByCrmUserId: 'admin-1' }, crmCompanyId: COMPANY, activityId: 'act-lr' })
      expect(Math.abs(Date.parse((audits[0]!.metadata as { approvedAt: string }).approvedAt) - audits[0]!.createdAt.getTime())).toBeLessThan(10_000)
      expect(rows[0]!.reason).toContain('(phone_call_known_number)')
      // the review list now shows it as recorded, and who approved it
      const { optOutReview } = await import('../../src/warmleads/optOutReview.js')
      const review = await optOutReview(T)
      const line = review.items.find((i) => i.kind === 'proposal' && i.activityId === 'act-lr')!
      expect(line).toMatchObject({ status: 'recorded', approvedBy: 'admin-1' })
      expect(review.pendingCount).toBe(1) // the other proposal (act-blocked) is still pending; the approved one no longer is
    } finally {
      env.WARM_LEADS_RECORD_OPT_OUTS = false
    }
  })

  it('another tenant\'s review list never contains this tenant\'s proposals', async () => {
    const { optOutReview } = await import('../../src/warmleads/optOutReview.js')
    expect((await optOutReview('some-other-tenant')).items).toEqual([])
  })
})
