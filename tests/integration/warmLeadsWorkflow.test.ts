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
const describeIfDb = skip ? describe.skip : describe
if (skip) console.warn(`\n[warm-leads workflow] SKIPPED — ${skip}\n`)

vi.mock('../../src/crm/index.js', () => ({ getCrm: () => world.crm }))
vi.mock('../../src/llm/promptStore.js', () => ({ resolvePrompt: async () => ({ key: 'k', version: 1, systemInstruction: 's', userText: 'u', temperature: 0 }) }))
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
          await gateway.generate({ promptKey: 'intent_public_research', variables: {}, feature: 'intent_public_research' } as never)
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
const saved = { worker: env.WARM_LEADS_WORKER_ENABLED, key: env.WARM_LEADS_GEMINI_API_KEY, sync: env.WARM_LEADS_SYNC_ENABLED }

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
  env.WARM_LEADS_WORKER_ENABLED = true
  env.WARM_LEADS_GEMINI_API_KEY = 'warm-leads-placeholder-key'
  env.WARM_LEADS_SYNC_ENABLED = false
  vi.stubGlobal('fetch', async (url: string) => {
    world.geminiUrls.push(String(url))
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
    [S.latestRefusal]: [reply(S.latestRefusal, 'Re: Product data proposal', 20, 'Sounds good, send pricing.'), reply(S.latestRefusal, 'Re: Product data proposal', 2, 'Please stop emailing us.')],
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
  world.research[S.agingEvent] = { events: [ev('expansion', 'Opened a showroom in Surat', 'https://news.example/aging/showroom', 45)] }

  await prisma.suppressionEntry.create({ data: { id: `${T}-sup`, tenantId: T, scope: 'global', matchType: 'company', matchValue: S.dnc, reason: 'asked not to be contacted', source: 'manual' } })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  if (skip) return
  env.WARM_LEADS_WORKER_ENABLED = saved.worker
  env.WARM_LEADS_GEMINI_API_KEY = saved.key
  env.WARM_LEADS_SYNC_ENABLED = saved.sync
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
    expect((await companies.companyCounts(T)).total).toBe(17)
    await pilot.requestPilot(T, 'tester')
    expect(await pilot.preparePilot(T)).toBe(true)

    const run = await prisma.warmLeadRun.findFirstOrThrow({ where: { tenantId: T, kind: 'pilot' } })
    expect(run.status).toBe('queued')
    expect(run.total).toBe(17) // fewer than the 100 asked for are available, and the run says exactly that many
    expect(await prisma.warmLeadCompany.count({ where: { tenantId: T, state: 'queued', cohort: 'pilot' } })).toBe(17)
    // nothing has been evaluated yet and the worker is still paused
    expect((await settings.ensureSettings(T)).paused).toBe(true)
    expect(world.websiteReads).toHaveLength(0)
  })

  it('the worker, once started, evaluates every pilot company within its limits and stops with nothing left', async () => {
    const settings = await import('../../src/warmleads/settings.js')
    const { dbUsageStore } = await import('../../src/warmleads/usageStore.js')
    await settings.setPaused(T, false, 'tester')

    const runs = await cycles()
    expect(runs[0]!.processed).toBe(17)
    expect(runs.at(-1)!.stoppedBecause).toBe('nothing_to_do')

    const usage = await dbUsageStore.getBucket(T, 'pilot')
    expect(usage!.companiesStarted).toBe(17)
    // 11 companies had a readable shop site, so were flagged and researched: 2 budgeted Gemini calls each
    expect(new Set(world.researchRuns).size).toBe(11)
    expect(usage!.geminiCalls).toBe(22)
    expect(world.geminiUrls).toHaveLength(22)
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
    expect((declined.ev!.reasons as Array<{ signal: string; points: number }>).find((x) => x.signal === 'reply_declined')).toMatchObject({ points: 0 })
    // A friendly subject but a refusal in the person's own words: not interest (the earlier "Warm By Reply" quoted an
    // "unsubscribe" footer and is still warm, because quoted text is not what the person wrote)
    const inText = await r(S.refusedInText)
    expect(inText.c).toMatchObject({ classification: 'cold', score: 10 })
    expect((inText.ev!.reasons as Array<{ signal: string; points: number; evidence: string }>).find((x) => x.signal === 'reply_declined')).toMatchObject({ points: 0, evidence: expect.stringContaining('the message says "not interested"') })
    // A friendly reply followed by a later one that asks us to stop: the later one wins
    expect((await r(S.latestRefusal)).c).toMatchObject({ classification: 'cold', score: 10 })
    // The newest reply cannot be read (nothing but a quoted copy): unverified, listed, worth 0, never interest
    const unreadable = await r(S.unreadable)
    expect(unreadable.c).toMatchObject({ classification: 'cold', score: 10 })
    expect((unreadable.ev!.reasons as Array<{ signal: string; points: number }>).find((x) => x.signal === 'reply_unverified')).toMatchObject({ points: 0 })
    // News that is not fresh does not qualify
    expect(['cold']).toContain((await r(S.agingEvent)).c.classification)
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
    expect(everything).not.toMatch(/please stop emailing us|we would like pricing|thanks for writing/i) // not even sentences from the bodies
    expect(world.geminiUrls.join(' ')).not.toContain(MARK)
  })

  it('the counts keep every status apart and add up; nothing was sent to NXT Sales', async () => {
    const companies = await import('../../src/warmleads/companies.js')
    const { buildOverview } = await import('../../src/warmleads/view.js')
    const c = await companies.companyCounts(T)
    expect(c).toMatchObject({ total: 17, warm: 2, earlySignal: 4, cold: 6, insufficientData: 1, existingCustomer: 1, activeOpportunity: 1, doNotContact: 1, failed: 1, pending: 0, inProgress: 0 })
    expect(c.warm + c.earlySignal + c.cold + c.insufficientData + c.existingCustomer + c.activeOpportunity + c.doNotContact).toBe(c.evaluated)
    expect(c.evaluated + c.failed).toBe(17)

    const o = await buildOverview(T, NOW)
    expect(o.stage).toBe('pilot_review')
    expect(o.pilot.canApprove).toBe(true)
    // the worker never wrote to NXT Sales: no result carries a sync stamp
    expect(await prisma.warmLeadEvaluation.count({ where: { tenantId: T, crmSyncedAt: { not: null } } })).toBe(0)
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

describeIfDb('afterwards: re-checks, failures and the Gemini ceiling', () => {
  it('a later evaluation that FAILS keeps the earlier Warm result; the company is only marked for another check', async () => {
    const settings = await import('../../src/warmleads/settings.js')
    const before = await row(S.warmReply)
    world.site[S.warmReply] = 'reset' // the site now cannot be read
    world.site[S.blocked] = 'ok' // and the blocked one now can
    await prisma.warmLeadCompany.update({ where: { id: before.id }, data: { state: 'needs_reevaluation', attempts: 0, nextAttemptAt: new Date('2026-11-05T00:00:00Z') } })
    await prisma.warmLeadCompany.update({ where: { tenantId_crmCompanyId: { tenantId: T, crmCompanyId: S.blocked } }, data: { nextAttemptAt: new Date('2026-11-05T00:00:00Z'), attempts: 1 } })
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

    const fixed = await row(S.blocked)
    expect(fixed.state).toBe('evaluated') // the retry worked once the site could be read
    expect(fixed.classification).toBe('cold')
    expect((await row('wf-late')).classification).toBe('cold') // research finished this time; nothing found
  })

  it('still nothing was sent anywhere: no result is stamped as sent, and every Gemini call went to the stubbed endpoint', async () => {
    expect(await prisma.warmLeadEvaluation.count({ where: { tenantId: T, crmSyncedAt: { not: null } } })).toBe(0)
    expect(world.geminiUrls.every((u) => u.startsWith('https://generativelanguage.googleapis.com/'))).toBe(true)
    const { dbUsageStore } = await import('../../src/warmleads/usageStore.js')
    const day = await prisma.warmLeadUsage.findMany({ where: { tenantId: T, NOT: { bucket: 'pilot' } } })
    expect(day).toHaveLength(1)
    expect(day[0]!.geminiCalls).toBeLessThanOrEqual(day[0]!.geminiCeiling)
    void dbUsageStore
  })
})
