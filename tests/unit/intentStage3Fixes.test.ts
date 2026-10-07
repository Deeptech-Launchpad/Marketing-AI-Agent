import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmCompany } from '../../src/crm/types.js'

// STAGE 3 — INTENT SIGNALS: DEFECTS FOUND IN LIVE DATA, PINNED.
//
// Each block names the defect it guards. All generic: no company-specific
// rule is tested because none exists.

const db = {
  // No DiscoveredCompany in these tests: every id is a CRM company.
  discoveredCompany: { findFirst: async () => null },
  intentSignal: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  intentDetectionRun: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
  companyEnrichment: { findMany: vi.fn() },
  suppressionEntry: { findMany: vi.fn() },
}
vi.mock('../../src/platform/db.js', () => ({
  prisma: db,
  newId: () => 'id_' + Math.random().toString(36).slice(2, 10),
}))

const fetchPage = vi.fn()
vi.mock('../../src/research/pageFetch.js', () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  fetchPageRaw: vi.fn(),
}))

const crm = { listDeals: vi.fn(), listActivities: vi.fn(), getCompany: vi.fn() }
vi.mock('../../src/crm/index.js', () => ({ getCrm: () => crm }))

const enqueue = vi.fn()
vi.mock('../../src/platform/queue.js', () => ({
  enqueue: (...a: unknown[]) => enqueue(...a),
  QUEUE_INTENT_DETECT: 'intent.detect',
  INTENT_JOB_EXPIRE_SECONDS: 1800,
}))

const { persistSignals, shouldProcessRun, angleFor, applySupersessions } = await import(
  '../../src/intent/intentDetection.js'
)
const { presentSignal, latestPerFingerprint, presentSignals } = await import('../../src/intent/signalView.js')
const { TechnologySignalProvider, technologyKey, addedTechnologies, isFalseTechnologyChange } = await import(
  '../../src/intent/providers/technologyProvider.js'
)
const { CareersPageProvider, rejectCareersPage } = await import('../../src/intent/providers/careersPageProvider.js')
const { CrmSignalProvider } = await import('../../src/intent/providers/crmProvider.js')
const { runProvider, isRealFailure } = await import('../../src/intent/providers/provider.js')
const { isEventAboutCompany, isHistoryStatement, distinctiveNameTokens } = await import('../../src/intent/eventReader.js')
const { readSocialPage } = await import('../../src/intent/socialReading.js')
const { postDate, withArticle, recordFieldWords, themeFor } = await import(
  '../../src/intent/providers/socialProvider.js'
)
const { outreachAngleFor } = await import('../../src/intent/outreachAngles.js')
const { eventFingerprint } = await import('../../src/intent/types.js')

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'co_1',
    name: 'Northwind Fasteners Ltd',
    email: null,
    emails: [],
    phone: null,
    domain: 'northwind-fasteners.com',
    industry: null,
    country: null,
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
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...over,
  }) as CrmCompany

const draft = (over: Record<string, unknown> = {}) =>
  ({
    crmCompanyId: 'co_1',
    signalType: 'careers_page_role',
    signalCategory: 'hiring',
    summary: 'Careers page mentions a Product Data role',
    interpretation: 'x',
    evidence: 'On https://northwind-fasteners.com/careers: "Product Data Manager"',
    sourceUrl: 'https://northwind-fasteners.com/careers',
    sourceType: 'company_website',
    observedAt: null,
    polarity: 'positive',
    provider: 'careers_page',
    metadata: { role: 'Product Data' },
    ...over,
  }) as never

beforeEach(() => {
  vi.clearAllMocks()
  db.intentSignal.findMany.mockResolvedValue([])
  db.intentSignal.update.mockResolvedValue({})
  db.intentSignal.create.mockResolvedValue({})
  db.intentDetectionRun.findFirst.mockResolvedValue(null)
  db.intentDetectionRun.create.mockResolvedValue({})
  db.intentDetectionRun.update.mockResolvedValue({})
  db.suppressionEntry.findMany.mockResolvedValue([])
})

// ── #1 The same signal stored again every run ─────────────────────────────

describe('#1 an event already on record is refreshed, not copied', () => {
  const fp = () =>
    eventFingerprint({
      crmCompanyId: 'co_1',
      signalCategory: 'hiring',
      subject: 'careers_page_role Careers page mentions a Product Data role',
    })

  it('creates a row the first time', async () => {
    const r = await persistSignals('t1', 'run_1', [draft()])
    expect(r).toEqual({ created: 1, refreshed: 0, collapsed: 0 })
    expect(db.intentSignal.create).toHaveBeenCalledTimes(1)
  })

  it('updates the standing row on a later run instead of inserting a copy', async () => {
    db.intentSignal.findMany.mockResolvedValue([
      {
        id: 'sig_old',
        crmCompanyId: 'co_1',
        eventFingerprint: fp(),
        intentRunId: 'run_1',
        metadata: { seenCount: 1 },
        detectedAt: new Date('2026-09-01T00:00:00Z'),
      },
    ])
    const r = await persistSignals('t1', 'run_2', [draft()])
    expect(r).toEqual({ created: 0, refreshed: 1, collapsed: 0 })
    expect(db.intentSignal.create).not.toHaveBeenCalled()
    const call = db.intentSignal.update.mock.calls[0]![0] as {
      where: { id: string }
      data: { intentRunId: string; metadata: Record<string, unknown> }
    }
    expect(call.where.id).toBe('sig_old')
    expect(call.data.intentRunId).toBe('run_2')
    expect(call.data.metadata.seenCount).toBe(2)
    expect(call.data.metadata.firstRunId).toBe('run_1')
    expect(call.data.metadata.lastRunId).toBe('run_2')
    expect(typeof call.data.metadata.lastSeenAt).toBe('string')
  })

  it('looks the event up scoped to the tenant and the fingerprints of this run', async () => {
    await persistSignals('t1', 'run_2', [draft()])
    const where = (db.intentSignal.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.tenantId).toBe('t1')
    expect(where.eventFingerprint).toEqual({ in: [fp()] })
  })

  it('does not revive a withdrawn row: a fact true again is a new observation', async () => {
    db.intentSignal.findMany.mockResolvedValue([
      {
        id: 'sig_withdrawn',
        crmCompanyId: 'co_1',
        eventFingerprint: fp(),
        intentRunId: 'run_1',
        metadata: { supersededBy: { runId: 'run_x', reason: 'r' } },
        detectedAt: new Date(),
      },
    ])
    const r = await persistSignals('t1', 'run_2', [draft()])
    expect(r.created).toBe(1)
    expect(db.intentSignal.update).not.toHaveBeenCalled()
  })

  it('never matches another company’s row with the same fingerprint', async () => {
    db.intentSignal.findMany.mockResolvedValue([
      { id: 'other', crmCompanyId: 'co_2', eventFingerprint: fp(), intentRunId: 'r', metadata: {}, detectedAt: new Date() },
    ])
    const r = await persistSignals('t1', 'run_2', [draft()])
    expect(r.created).toBe(1)
  })
})

describe('#1 read side: one row per event, however many copies are stored', () => {
  const row = (id: string, detectedAt: string, over: Record<string, unknown> = {}) => ({
    id,
    eventFingerprint: 'fp_a',
    crmCompanyId: 'co_1',
    observedAt: null,
    detectedAt: new Date(detectedAt),
    confidence: 'medium',
    status: 'weak',
    metadata: null as unknown,
    ...over,
  })

  it('collapses copies to the most recently seen row and states the copy count', () => {
    const out = latestPerFingerprint([
      row('a1', '2026-09-01T00:00:00Z'),
      row('a2', '2026-09-10T00:00:00Z'),
      row('a3', '2026-09-05T00:00:00Z'),
      row('b1', '2026-09-02T00:00:00Z', { eventFingerprint: 'fp_b' }),
    ])
    expect(out.map((r) => r.id)).toEqual(['a2', 'b1'])
    expect(out[0]!.storedCopies).toBe(3)
    expect(out[1]!.storedCopies).toBe(1)
  })

  it('prefers a standing copy over a withdrawn one of the same event', () => {
    const out = latestPerFingerprint([
      row('old', '2026-09-01T00:00:00Z'),
      row('new_withdrawn', '2026-09-10T00:00:00Z', { metadata: { supersededBy: { reason: 'r' } } }),
    ])
    expect(out[0]!.id).toBe('old')
  })
})

// ── #6 Age and status frozen at detection ─────────────────────────────────

describe('#6 freshness and status are computed at read time', () => {
  const base = {
    id: 's',
    eventFingerprint: 'f',
    crmCompanyId: 'c',
    detectedAt: new Date('2026-06-01T00:00:00Z'),
    confidence: 'high',
    metadata: null as unknown,
  }

  it('a signal stored as fresh/active is stale/expired once it has aged past the threshold', () => {
    const stored = { ...base, observedAt: new Date('2026-06-01T00:00:00Z'), status: 'active', freshness: 'fresh', ageDays: 0 }
    const now = new Date('2027-06-01T00:00:00Z')
    const shown = presentSignal(stored, now)
    expect(shown.freshness).toBe('stale')
    expect(shown.status).toBe('expired')
    expect(shown.ageDays).toBe(365)
  })

  it('an active signal that is still recent stays active', () => {
    const stored = { ...base, observedAt: new Date('2026-09-10T00:00:00Z'), status: 'active' }
    expect(presentSignal(stored, new Date('2026-09-12T00:00:00Z')).status).toBe('active')
  })

  it('a withdrawn signal stays expired whatever its age says', () => {
    const stored = {
      ...base,
      observedAt: new Date('2026-09-10T00:00:00Z'),
      status: 'expired',
      metadata: { supersededBy: { reason: 'read ok' } },
    }
    expect(presentSignal(stored, new Date('2026-09-11T00:00:00Z')).status).toBe('expired')
  })

  it('presentSignals applies both rules together', () => {
    const out = presentSignals(
      [
        { ...base, id: 'x1', observedAt: new Date('2026-01-01T00:00:00Z'), status: 'active' },
        { ...base, id: 'x2', observedAt: new Date('2026-01-01T00:00:00Z'), status: 'active', detectedAt: new Date('2026-07-01T00:00:00Z') },
      ],
      new Date('2026-12-01T00:00:00Z'),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe('expired')
  })
})

// ── #3 / #12 duplicate runs and enqueue failures ──────────────────────────

describe('#3 #12 queueing runs', async () => {
  const { queueRunsFor } = await import('../../src/api/routes/intent.routes.js')
  const input = (ids: string[]) => ({ tenantId: 't1', requestedByCrmUserId: 'u1', prospectSearchId: null, crmCompanyIds: ids })

  it('queues one run per distinct company', async () => {
    enqueue.mockResolvedValue('job')
    const r = await queueRunsFor(input(['co_1', 'co_1', ' co_1 ', 'co_2']))
    expect(r.queued.map((q) => q.crmCompanyId)).toEqual(['co_1', 'co_2'])
    expect(db.intentDetectionRun.create).toHaveBeenCalledTimes(2)
  })

  it('returns the run already in flight instead of creating another', async () => {
    db.intentDetectionRun.findFirst.mockResolvedValue({ id: 'run_existing' })
    const r = await queueRunsFor(input(['co_1']))
    expect(r.reused).toEqual([{ id: 'run_existing', crmCompanyId: 'co_1', reused: true }])
    expect(r.queued).toEqual([])
    expect(db.intentDetectionRun.create).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    const where = (db.intentDetectionRun.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.status).toEqual({ in: ['queued', 'running'] })
    expect(where.tenantId).toBe('t1')
  })

  it('marks a run failed when its job cannot be enqueued, rather than leaving it queued', async () => {
    enqueue.mockRejectedValue(new Error('queue down'))
    const r = await queueRunsFor(input(['co_1']))
    expect(r.failed).toHaveLength(1)
    const upd = db.intentDetectionRun.update.mock.calls[0]![0] as { data: { status: string; failureReason: string } }
    expect(upd.data.status).toBe('failed')
    expect(upd.data.failureReason).toContain('queue down')
  })
})

describe('redelivered jobs do not process a run twice', () => {
  const now = new Date('2026-09-15T12:00:00Z')
  it('skips finished runs', () => {
    expect(shouldProcessRun({ status: 'completed', startedAt: null }, now)).toBe(false)
    expect(shouldProcessRun({ status: 'failed', startedAt: null }, now)).toBe(false)
  })
  it('skips a run another delivery started recently', () => {
    expect(shouldProcessRun({ status: 'running', startedAt: new Date(now.getTime() - 60_000) }, now)).toBe(false)
  })
  it('picks up a queued run, or a running one abandoned past the in-flight window', () => {
    expect(shouldProcessRun({ status: 'queued', startedAt: null }, now)).toBe(true)
    expect(shouldProcessRun({ status: 'running', startedAt: new Date(now.getTime() - 3_600_000) }, now)).toBe(true)
  })
})

// ── #4 Technology provider ────────────────────────────────────────────────

describe('#4 website unreachable and technology changes', () => {
  const at = (d: string) => new Date(d)
  const row = (over: Record<string, unknown>) => ({
    id: 'enr',
    status: 'enriched',
    sourceUrl: 'https://northwind-fasteners.com/',
    technologies: [],
    failureReason: null,
    fetchedAt: at('2026-09-10T00:00:00Z'),
    finishedAt: at('2026-09-10T00:00:00Z'),
    createdAt: at('2026-09-10T00:00:00Z'),
    ...over,
  })
  const collect = () => new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })

  it('withdraws "unreachable" when the latest enrichment found no website on record', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([row({ id: 'e2', status: 'no_website', fetchedAt: null })])
    const r = await collect()
    expect((r.supersedes ?? []).map((s) => s.signalType)).toContain('website_unreachable')
    expect(r.signals.some((s) => s.signalType === 'website_unreachable')).toBe(false)
  })

  it('does not re-emit "unreachable" from an enrichment row already recorded', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([row({ id: 'e_down', status: 'unreachable', fetchedAt: null })])
    db.intentSignal.findMany.mockResolvedValue([{ metadata: { enrichmentId: 'e_down' } }])
    const r = await collect()
    expect(r.signals.some((s) => s.signalType === 'website_unreachable')).toBe(false)
  })

  it('still emits "unreachable" for a new failed enrichment row', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([row({ id: 'e_new', status: 'unreachable', fetchedAt: null })])
    db.intentSignal.findMany.mockResolvedValue([{ metadata: { enrichmentId: 'e_old' } }])
    const r = await collect()
    expect(r.signals.some((s) => s.signalType === 'website_unreachable')).toBe(true)
  })

  it('emits no "technology added" when the previous observation could not read the site', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([
      row({ id: 'e2', technologies: [{ name: 'Shopify', category: 'ecommerce', evidence: 'cdn.shopify.com' }] }),
      row({ id: 'e1', status: 'unreachable', technologies: [] }),
    ])
    const r = await collect()
    expect(r.signals.some((s) => s.signalType === 'technology_added')).toBe(false)
  })

  it('compares against the previous SUCCESSFUL read, skipping failed ones between', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([
      row({
        id: 'e3',
        technologies: [
          { name: 'Shopify', category: 'ecommerce', evidence: 'x' },
          { name: 'Akeneo', category: 'pim', evidence: 'y' },
        ],
      }),
      row({ id: 'e2', status: 'unreachable' }),
      row({ id: 'e1', technologies: [{ name: 'Shopify', category: 'ecommerce', evidence: 'x' }] }),
    ])
    const r = await collect()
    const added = r.signals.filter((s) => s.signalType === 'technology_added')
    expect(added.map((s) => s.metadata?.technology)).toEqual(['Akeneo'])
    expect(added[0]!.metadata?.previousEnrichmentId).toBe('e1')
  })

  it('a version bump is not a new technology, and generator declarations are ignored', () => {
    expect(technologyKey('Site Kit by Google 1.187.0')).toBe(technologyKey('Site Kit by Google 1.186.0'))
    expect(technologyKey('WordPress 7.1')).toBe('wordpress')
    const added = addedTechnologies(
      [
        { name: 'Site Kit by Google 1.186.0', category: 'framework', evidence: '' },
        { name: 'WordPress 7.1', category: 'declared', evidence: '' },
      ] as never,
      [
        { name: 'Site Kit by Google 1.187.0', category: 'framework', evidence: '' },
        { name: 'WPBakery', category: 'declared', evidence: '' },
      ] as never,
    )
    expect(added).toEqual([])
  })

  it('withdraws earlier false "technology added" rows, and only those', async () => {
    const rows = new Map([
      ['e_ok', { id: 'e_ok', status: 'enriched', technologies: [{ name: 'Shopify', category: 'ecommerce' }] }],
      ['e_down', { id: 'e_down', status: 'unreachable', technologies: [] }],
      ['e_later', { id: 'e_later', status: 'enriched', technologies: [{ name: 'Shopify 2.1', category: 'ecommerce' }, { name: 'Akeneo', category: 'pim' }, { name: 'WPBakery', category: 'declared' }] }],
    ])
    // previous could not read the site
    expect(isFalseTechnologyChange({ previousEnrichmentId: 'e_down', enrichmentId: 'e_later', technology: 'Akeneo' }, rows)).toBe(true)
    // only the version differed
    expect(isFalseTechnologyChange({ previousEnrichmentId: 'e_ok', enrichmentId: 'e_later', technology: 'Shopify 2.1' }, rows)).toBe(true)
    // a generator declaration
    expect(isFalseTechnologyChange({ previousEnrichmentId: 'e_ok', enrichmentId: 'e_later', technology: 'WPBakery' }, rows)).toBe(true)
    // a real addition stands
    expect(isFalseTechnologyChange({ previousEnrichmentId: 'e_ok', enrichmentId: 'e_later', technology: 'Akeneo' }, rows)).toBe(false)
    // unknown rows are left alone
    expect(isFalseTechnologyChange({ previousEnrichmentId: 'e_gone', technology: 'Akeneo' }, rows)).toBe(false)
  })

  it('applySupersessions honours a row-level narrowing', async () => {
    db.intentSignal.findMany.mockResolvedValue([
      { id: 'false_one', metadata: { bad: true } },
      { id: 'true_one', metadata: { bad: false } },
    ])
    const n = await applySupersessions('t1', 'co_1', 'run_new', [
      {
        signalType: 'technology_added',
        observedBefore: new Date(),
        reason: 'r',
        appliesTo: (m) => (m as { bad: boolean }).bad,
      },
    ])
    expect(n).toBe(1)
    expect((db.intentSignal.update.mock.calls[0]![0] as { where: { id: string } }).where.id).toBe('false_one')
  })
})

// ── #5 Careers page ───────────────────────────────────────────────────────

describe('#5 careers page provider rejects pages that are not this company’s careers page', () => {
  const base = new URL('https://www.northwind-fasteners.com/')
  const longText = 'We are hiring. '.repeat(30)

  it('rejects a redirect to another host', () => {
    expect(rejectCareersPage({ requestedBase: base, finalUrl: 'https://www.facebook.com/jobs', title: null, text: longText })).toMatch(/facebook/)
  })
  it('rejects a 404 path, a not-found title and soft-404 content', () => {
    expect(rejectCareersPage({ requestedBase: base, finalUrl: 'https://www.northwind-fasteners.com/404', title: null, text: longText })).not.toBeNull()
    expect(rejectCareersPage({ requestedBase: base, finalUrl: 'https://northwind-fasteners.com/careers', title: 'Page Not Found – Northwind', text: longText })).not.toBeNull()
    expect(
      rejectCareersPage({
        requestedBase: base,
        finalUrl: 'https://northwind-fasteners.com/careers',
        title: 'Northwind',
        text: `Oops! The page you are looking for could not be found. ${longText}`,
      }),
    ).not.toBeNull()
  })
  it('accepts the company’s own careers page, including apex/www differences', () => {
    expect(rejectCareersPage({ requestedBase: base, finalUrl: 'https://northwind-fasteners.com/careers', title: 'Careers', text: longText })).toBeNull()
  })

  it('never reads a social platform named in the website field', async () => {
    const r = await new CareersPageProvider().collect({ tenantId: 't1', company: company({ domain: 'facebook.com' }), maxResults: 10 })
    expect(fetchPage).not.toHaveBeenCalled()
    expect(r.signals).toEqual([])
  })

  it('"looked and found none" is ok:true with a reason, not a failure', async () => {
    fetchPage.mockResolvedValue({ ok: false, requestedUrl: 'x', reason: 'HTTP 404' })
    const r = await new CareersPageProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    expect(r.ok).toBe(true)
    expect(r.reason).toMatch(/No careers page found/)
    expect(isRealFailure(r)).toBe(false)
  })

  it('moves past a soft 404 to the next path', async () => {
    fetchPage
      .mockResolvedValueOnce({ ok: true, requestedUrl: 'a', finalUrl: 'https://northwind-fasteners.com/404', text: longText, signals: { title: '404' } })
      .mockResolvedValue({
        ok: true,
        requestedUrl: 'b',
        finalUrl: 'https://northwind-fasteners.com/jobs',
        text: `Open roles\nProduct Data Manager\n${longText}`,
        signals: { title: 'Jobs' },
      })
    const r = await new CareersPageProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    expect(r.signals[0]?.sourceUrl).toBe('https://northwind-fasteners.com/jobs')
  })
})

// ── #10 expected outcomes are not failures ────────────────────────────────

describe('#10 provider outcomes', () => {
  it('a provider switched off by configuration is marked not configured', async () => {
    const r = await runProvider(
      {
        name: 'x',
        category: 'hiring',
        available: () => ({ ok: false, reason: 'token not set' }),
        collect: async () => ({ provider: 'x', ok: true, signals: [], durationMs: 0 }),
      },
      { tenantId: 't1', company: company(), maxResults: 1 },
    )
    expect(r.metadata?.notConfigured).toBe(true)
    expect(isRealFailure(r)).toBe(false)
  })

  it('a thrown provider is a real failure', async () => {
    const r = await runProvider(
      {
        name: 'x',
        category: 'hiring',
        available: () => ({ ok: true }),
        collect: async () => {
          throw new Error('boom')
        },
      },
      { tenantId: 't1', company: company(), maxResults: 1 },
    )
    expect(isRealFailure(r)).toBe(true)
  })
})

describe('CRM calls that fail are not empty lists', () => {
  it('reports ok:false with the failed call recorded', async () => {
    crm.listDeals.mockRejectedValue(new Error('CRM 502'))
    crm.listActivities.mockResolvedValue([])
    const r = await new CrmSignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('listDeals')
    expect((r.metadata?.errors as unknown[]).length).toBe(1)
  })
  it('is ok:true when every call succeeded', async () => {
    crm.listDeals.mockResolvedValue([])
    crm.listActivities.mockResolvedValue([])
    const r = await new CrmSignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    expect(r.ok).toBe(true)
  })
})

// A DiscoveredCompany (2026-09-24 restructure) has no CRM record yet — every
// call above would fail against a placeholder id that was never one of NXT
// Sales' own companies. That is the expected state of a brand-new prospect,
// not a CRM outage, so it must be reported as such rather than as N failed reads.
describe('a discovered company is not a CRM failure', () => {
  it('answers ok:false with a clear reason, and calls the CRM zero times', async () => {
    const r = await new CrmSignalProvider().collect({
      tenantId: 't1',
      company: company({ id: 'discovered-co-1' }),
      maxResults: 10,
      isDiscovered: true,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('No CRM record exists for this company yet.')
    expect(r.signals).toEqual([])
    expect(crm.listDeals).not.toHaveBeenCalled()
    expect(crm.listActivities).not.toHaveBeenCalled()
  })
})

// ── #8 Public research: other organisations and history ───────────────────

describe('#8 a grounded event must be about this company', () => {
  const page =
    'Welcome to Saint James Hospital. Our board is pleased to share news. ' +
    'Jean Claude was appointed as CEO of Saint James Hospital Operations in August. ' +
    'Visiting hours are unchanged.'
  const event = {
    summary: 'CEO appointed',
    sourceSentence: 'Jean Claude was appointed as CEO of Saint James Hospital Operations in August.',
  }

  it('drops an event on a third-party page that never names the company', () => {
    expect(
      isEventAboutCompany(event, page, { name: 'Jamesco Trading', host: 'jamesco.com', pageOnCompanyDomain: false }),
    ).toBe(false)
  })

  it('keeps it when the company is named near the sentence', () => {
    const named = `Jamesco Trading announced a partnership. ${page}`
    expect(
      isEventAboutCompany(event, named, { name: 'Jamesco Trading', host: 'jamesco.com', pageOnCompanyDomain: false }),
    ).toBe(true)
  })

  it('does not count generic name words as naming the company', () => {
    expect(distinctiveNameTokens('Jamesco Trading Ltd')).toEqual(['jamesco'])
    const generic = 'A trading company opened a new warehouse in Leeds this month, the trading group said.'
    expect(
      isEventAboutCompany(
        { summary: 'warehouse', sourceSentence: 'A trading company opened a new warehouse in Leeds this month' },
        generic,
        { name: 'Jamesco Trading', host: null, pageOnCompanyDomain: false },
      ),
    ).toBe(false)
  })

  // 2026-09-29: seen in live data — list articles tied other companies' news
  // to this one through one shared word.
  it('drops another company’s news on a list article, even when this company is listed nearby', () => {
    const list =
      'Top 100 distributors of 2026: big projects across the industry this year. ' +
      'Our annual ranking of the largest electrical distributors in North America, with the projects, ' +
      'acquisitions and investments that shaped their year, based on sales reported to our editors. ' +
      '12. Scott Electric, Greensburg PA. 13. Northgate Supply. ' +
      'IDEAL Electrical to provide grants to Midwest community colleges to fund electrical career training.'
    expect(
      isEventAboutCompany(
        { summary: 'grants', sourceSentence: 'IDEAL Electrical to provide grants to Midwest community colleges to fund electrical career training.' },
        list,
        { name: 'Scott Electric', host: 'scottelectricusa.com', pageOnCompanyDomain: false },
      ),
    ).toBe(false)
  })

  it('does not count ONE shared word of a multi-word name as naming the company', () => {
    const sentence = 'Graybar acquired American Electric Supply, one of the largest single distributors.'
    expect(
      isEventAboutCompany({ summary: 'acquisition', sourceSentence: sentence }, `Industry news. ${sentence}`, {
        name: 'Johnson Electric Supply Company',
        host: 'johnson-electric.com',
        pageOnCompanyDomain: false,
      }),
    ).toBe(false)
  })

  it('keeps a follow-on sentence under a headline that names the company', () => {
    const article = 'Eaton to acquire COL Group in data-centre push. Eaton said on Monday it had agreed terms. The transaction is expected to close in the first quarter of 2027.'
    expect(
      isEventAboutCompany(
        { summary: 'acquisition close', sourceSentence: 'The transaction is expected to close in the first quarter of 2027.' },
        article,
        { name: 'Eaton', host: 'eaton.com', pageOnCompanyDomain: false },
      ),
    ).toBe(true)
  })

  it('accepts any event on the company’s own domain', () => {
    expect(isEventAboutCompany(event, page, { name: 'Jamesco Trading', host: 'jamesco.com', pageOnCompanyDomain: true })).toBe(true)
  })

  it('drops founding and history statements, keeps current events', () => {
    expect(isHistoryStatement({ summary: 'Company founded', sourceSentence: 'Unicare was founded in 2004 in Dubai.' })).toBe(true)
    expect(isHistoryStatement({ summary: 'x', sourceSentence: 'Established since 1998, we serve the region.' })).toBe(true)
    expect(isHistoryStatement({ summary: 'New branch', sourceSentence: 'We established a new branch in Leeds in 2026.' })).toBe(false)
    expect(isHistoryStatement({ summary: 'Hiring', sourceSentence: 'We are hiring a Product Data Manager.' })).toBe(false)
  })
})

// ── #9 Outreach angles ────────────────────────────────────────────────────

describe('#9 no outreach angle on negative, neutral or presence signals', () => {
  it('returns null for negative and neutral polarity', () => {
    expect(outreachAngleFor({ category: 'website', polarity: 'negative' })).toBeNull()
    expect(outreachAngleFor({ category: 'business', polarity: 'neutral' })).toBeNull()
  })
  it('returns null for presence and description types even if positive', () => {
    expect(outreachAngleFor({ category: 'business', polarity: 'positive', signalType: 'social_presence_linkedin' })).toBeNull()
    expect(outreachAngleFor({ category: 'business', polarity: 'positive', signalType: 'social_description_facebook' })).toBeNull()
  })
  it('keeps the angle for a positive event', () => {
    expect(outreachAngleFor({ category: 'business', polarity: 'positive', signalType: 'social_post_hiring' })).toBeTruthy()
  })
  it('the engine drops a provider-supplied angle on a negative signal', () => {
    expect(
      angleFor(draft({ polarity: 'negative', signalCategory: 'website', signalType: 'website_unreachable', outreachAngle: 'Open on it' })),
    ).toBeNull()
    expect(angleFor(draft({ outreachAngle: 'Quoted role angle' }))).toBe('Quoted role angle')
  })
})

// ── #13 Social post dates, and copy ───────────────────────────────────────

describe('#13 each social post is dated from its own markup', () => {
  const html =
    '<html><head><meta property="og:title" content="Acme"></head><body>' +
    '<article><time datetime="2026-01-05">Jan</time>We are proud to announce a new range of stainless fittings for trade customers.</article>' +
    '<article>Join our team — we are hiring a warehouse lead for the new depot opening in spring this year.</article>' +
    '</body></html>'

  it('gives a dated post its date and an undated post null', () => {
    const r = readSocialPage({ html, status: 200, platformLabel: 'Facebook' })
    expect(r.posts).toHaveLength(2)
    const dated = r.posts.findIndex((p) => p.includes('stainless'))
    const undated = r.posts.findIndex((p) => p.includes('warehouse'))
    expect(postDate(r, dated)?.toISOString().slice(0, 10)).toBe('2026-01-05')
    expect(postDate(r, undated)).toBeNull()
  })

  it('reads "an Instagram", "a LinkedIn", and never an internal field name', () => {
    expect(withArticle('Instagram')).toBe('an Instagram')
    expect(withArticle('LinkedIn')).toBe('a LinkedIn')
    expect(recordFieldWords('Company.endPdpUrl')).not.toContain('Company.')
  })
})

// A company promoting a training or certification programme is investing in
// capability, and its own post is a first-party need signal — the same kind
// of thing "Hiring" already covers, added for the 2026-09-24 restructure's
// Intent Signals example ("posted about a bootcamp").
describe('#14 a training or certification post is its own theme', () => {
  it('matches a bootcamp announcement', () => {
    const m = themeFor("We're now enrolling for our new bootcamp cohort, starting this October — limited spaces.")
    expect(m?.theme).toBe('Training or certification programme')
  })

  it('produces the expected signal type', () => {
    const m = themeFor('Join our upskilling academy for new starters this quarter.')
    expect(m).not.toBeNull()
    const signalType = `social_post_${m!.theme.toLowerCase().replace(/[^a-z]+/g, '_')}`
    expect(signalType).toBe('social_post_training_or_certification_programme')
  })

  it('does not fire on an ordinary business post', () => {
    expect(themeFor('We have restocked our full range of copper fittings this week.')).toBeNull()
  })

  it('does not get shadowed by the Hiring theme for a plain enrolment post', () => {
    // "now enrolling" must not accidentally satisfy "now hiring" or vice versa.
    const m = themeFor('Our training programme is now enrolling for the spring cohort.')
    expect(m?.theme).toBe('Training or certification programme')
  })
})
