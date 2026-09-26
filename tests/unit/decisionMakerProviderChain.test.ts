import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CandidateDraft } from '../../src/decisionmakers/types.js'

// CRM FIRST, NOT CRM ONLY.
//
// The chain used to STOP the moment any source produced a company-matched,
// role-relevant, reachable person. Because the CRM runs first and is free, a
// company whose NXT Sales record happens to name one buyer got exactly that
// one person, and Apollo, ZoomInfo, RocketReach and Hunter were all recorded
// as "Not called: an earlier provider already returned a decision maker".
//
// Two things were lost every single time that happened:
//
//   · a better-verified email for the person we already had, which is the
//     whole point of paying for an enrichment provider, and
//   · the SECOND person — without whom there is no alternative contact, and
//     an approach that stalls with the primary has nowhere to go.
//
// The order is now a PRIORITY order, not a stopping rule. What still bounds
// cost is the thing that should: a provider with no credential, no plan, or no
// domain to search by declines in available() and never reaches the network.

const db = {
  // No DiscoveredCompany in these tests: every id is a CRM company.
  discoveredCompany: { findFirst: async () => null },
  decisionMakerRun: { findUnique: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  decisionMakerCandidate: { createMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  companyEnrichment: { findFirst: vi.fn() },
  $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? (fn as (t: unknown) => unknown)(db) : fn)),
}
vi.mock('../../src/platform/db.js', () => ({
  prisma: db,
  newId: () => 'id_' + Math.random().toString(36).slice(2, 10),
}))

const company = {
  id: 'co_1',
  name: 'Acme Supplies',
  email: null as string | null,
  emails: [] as string[],
  phone: null,
  domain: 'acme.test',
  industry: null,
  country: null,
  cms: null,
  leadStatus: null,
  status: null,
  remarks: null,
  notes: null,
  endPdpUrl: null,
  contactPersons: [] as string[],
  linkedProfiles: [] as string[],
  ownerId: null,
  ownerName: null,
  dealCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
vi.mock('../../src/crm/index.js', () => ({
  getCrm: () => ({ getCompany: async () => company }),
}))
vi.mock('../../src/platform/audit.js', () => ({ audit: async () => undefined }))

/** What each provider returns this test. Keyed by provider name. */
let scripted: Record<string, { status: string; candidates: CandidateDraft[]; reason?: string }> = {}
/** Every provider the engine actually invoked, in order. */
let invoked: string[] = []

vi.mock('../../src/decisionmakers/providers/provider.js', () => ({
  runDmProvider: async (provider: { name: string }) => {
    invoked.push(provider.name)
    const s = scripted[provider.name] ?? { status: 'no_results', candidates: [] }
    return {
      provider: provider.name,
      status: s.status,
      candidates: s.candidates,
      reason: s.reason,
      durationMs: 1,
    }
  },
}))

const { runDecisionMakerDiscovery, providerNames } = await import('../../src/decisionmakers/discovery.js')

const draft = (over: Partial<CandidateDraft> = {}): CandidateDraft => ({
  fullName: 'Dana Reed',
  rawTitle: 'Head of Ecommerce',
  statedCompany: 'Acme Supplies',
  profileUrl: null,
  providerPersonId: null,
  email: null,
  phone: null,
  location: null,
  evidence: [
    {
      provider: 'crm_contacts',
      sourceType: 'crm_record',
      sourceUrl: null,
      snippet: 'NXT Sales contactPersons entry',
      observedAt: new Date('2026-08-01T00:00:00Z'),
      supports: ['name', 'company', 'title'],
    },
  ],
  ...over,
})

/** The providerResults the run wrote. */
function writtenProviders(): Array<{ provider: string; status: string; queried: boolean; reason: string | null }> {
  const call = db.decisionMakerRun.update.mock.calls.find(
    (c) => (c[0] as { data?: { providerResults?: unknown } })?.data?.providerResults,
  )
  return ((call?.[0] as { data: { providerResults: unknown } }).data.providerResults ?? []) as never
}

beforeEach(() => {
  vi.clearAllMocks()
  invoked = []
  scripted = {}
  company.email = null
  company.emails = []
  company.contactPersons = []
  db.decisionMakerRun.findUnique.mockResolvedValue({
    id: 'run_1',
    tenantId: 't1',
    crmCompanyId: 'co_1',
    status: 'queued',
    retryCount: 0,
  })
  db.decisionMakerRun.update.mockResolvedValue({})
  db.companyEnrichment.findFirst.mockResolvedValue(null)
  db.decisionMakerCandidate.createMany.mockResolvedValue({ count: 0 })
  db.decisionMakerCandidate.deleteMany.mockResolvedValue({ count: 0 })
  db.decisionMakerCandidate.create.mockResolvedValue({})
})
afterEach(() => vi.restoreAllMocks())

// ── Every provider runs, whatever the CRM found ───────────────────────────

describe('the chain is a priority order, not a stopping rule', () => {
  const ALL = providerNames()

  it('lists the approved order, CRM first and the open web last', () => {
    expect(ALL[0]).toBe('crm_contacts')
    expect(ALL).toContain('apollo')
    expect(ALL).toContain('zoominfo')
    expect(ALL).toContain('rocketreach')
    expect(ALL).toContain('hunter')
    expect(ALL).toContain('company_website')
    // The open web is the widest net and the weakest evidence, so it goes last.
    expect(ALL[ALL.length - 1]).toBe('public_web_research')
  })

  // The exact case that used to stop the chain dead: a CRM person who is
  // company-matched, role-relevant, reachable and high confidence.
  it('still calls every external provider when the CRM found a perfect person', async () => {
    scripted.crm_contacts = {
      status: 'available',
      candidates: [draft({ email: 'dana.reed@acme.test' })],
    }
    await runDecisionMakerDiscovery('run_1')
    expect(invoked).toEqual(ALL)
  })

  it('calls every provider when the CRM person has no email', async () => {
    scripted.crm_contacts = { status: 'available', candidates: [draft({ email: null })] }
    await runDecisionMakerDiscovery('run_1')
    expect(invoked).toEqual(ALL)
  })

  it('calls every provider when the CRM holds only a shared mailbox', async () => {
    // The generic address is rejected upstream, so the person arrives without
    // one. What matters here is that the run does not stop.
    company.email = 'info@acme.test'
    company.emails = ['info@acme.test']
    scripted.crm_contacts = { status: 'available', candidates: [draft({ email: null })] }
    await runDecisionMakerDiscovery('run_1')
    expect(invoked).toEqual(ALL)
  })

  it('calls every provider when the CRM found nobody', async () => {
    scripted.crm_contacts = { status: 'no_results', candidates: [] }
    await runDecisionMakerDiscovery('run_1')
    expect(invoked).toEqual(ALL)
  })

  it('records no provider as skipped because an earlier one sufficed', async () => {
    scripted.crm_contacts = { status: 'available', candidates: [draft({ email: 'dana.reed@acme.test' })] }
    await runDecisionMakerDiscovery('run_1')
    const written = writtenProviders()
    expect(written.map((p) => p.provider)).toEqual(ALL)
    expect(written.some((p) => p.status === 'skipped')).toBe(false)
    expect(written.some((p) => /already returned|Not called/i.test(p.reason ?? ''))).toBe(false)
  })
})

// ── Which providers actually reached the network ──────────────────────────

describe('a provider that could not run is distinguishable from one that found nothing', () => {
  it('marks an unconfigured provider as not queried, and a real empty answer as queried', async () => {
    scripted.crm_contacts = { status: 'available', candidates: [draft()] }
    scripted.apollo = { status: 'unauthorized', candidates: [], reason: 'No API key is set.' }
    scripted.hunter = { status: 'no_results', candidates: [], reason: 'Hunter holds no address for this domain.' }

    await runDecisionMakerDiscovery('run_1')
    const written = writtenProviders()

    const apollo = written.find((p) => p.provider === 'apollo')!
    const hunter = written.find((p) => p.provider === 'hunter')!
    // Apollo never reached the network; Hunter did and came back empty. An
    // operator reading "0 people" needs to know which of the two happened.
    expect(apollo.queried).toBe(false)
    expect(hunter.queried).toBe(true)
  })

  it('treats a rate limit and an error as requests that were made', async () => {
    scripted.zoominfo = { status: 'rate_limited', candidates: [] }
    scripted.rocketreach = { status: 'error', candidates: [] }
    await runDecisionMakerDiscovery('run_1')
    const written = writtenProviders()
    expect(written.find((p) => p.provider === 'zoominfo')!.queried).toBe(true)
    expect(written.find((p) => p.provider === 'rocketreach')!.queried).toBe(true)
  })

  it('does not call reading a local record (CRM, stored intent signals) a query', async () => {
    scripted.crm_contacts = { status: 'no_results', candidates: [] }
    scripted.intent_social = { status: 'no_results', candidates: [] }
    await runDecisionMakerDiscovery('run_1')
    const written = writtenProviders() as Array<{ provider: string; queried: boolean; local?: boolean }>
    expect(written.find((p) => p.provider === 'crm_contacts')).toMatchObject({ queried: false, local: true })
    expect(written.find((p) => p.provider === 'intent_social')).toMatchObject({ queried: false, local: true })
  })

  it('keeps each provider own reason, so "not configured" is readable', async () => {
    scripted.apollo = { status: 'unauthorized', candidates: [], reason: 'No API key is set.' }
    await runDecisionMakerDiscovery('run_1')
    expect(writtenProviders().find((p) => p.provider === 'apollo')!.reason).toBe('No API key is set.')
  })
})

// ── Enrichment: a later source improving what the CRM already had ─────────

describe('a later provider enriches the person the CRM already named', () => {
  it('keeps the CRM person and takes the email a later provider verified', async () => {
    scripted.crm_contacts = { status: 'available', candidates: [draft({ email: null })] }
    scripted.hunter = {
      status: 'available',
      candidates: [
        draft({
          email: 'dana.reed@acme.test',
          evidence: [
            {
              provider: 'hunter',
              sourceType: 'data_provider',
              sourceUrl: 'https://acme.test/about/team',
              snippet: 'Hunter recorded dana.reed@acme.test on https://acme.test/about/team.',
              observedAt: new Date('2026-08-02T00:00:00Z'),
              supports: ['name', 'contact'],
            },
          ],
        }),
      ],
    }

    await runDecisionMakerDiscovery('run_1')

    const rows = db.decisionMakerCandidate.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data)
    const dana = rows.find((r) => r.fullName === 'Dana Reed')!
    expect(dana.email).toBe('dana.reed@acme.test')
    // One person, not two: the same human seen by two sources.
    expect(rows.filter((r) => r.fullName === 'Dana Reed')).toHaveLength(1)
    // Both sources are kept against them.
    expect(dana.corroboratingProviders).toEqual(expect.arrayContaining(['crm_contacts', 'hunter']))
  })

  it('finds a second person a later provider names, so an alternative exists', async () => {
    scripted.crm_contacts = { status: 'available', candidates: [draft({ email: 'dana.reed@acme.test' })] }
    scripted.apollo = {
      status: 'available',
      candidates: [
        draft({
          fullName: 'Ben Ali',
          rawTitle: 'Operations Manager',
          email: 'ben.ali@acme.test',
          evidence: [
            {
              provider: 'apollo',
              sourceType: 'data_provider',
              sourceUrl: null,
              snippet: 'Apollo person record',
              observedAt: new Date('2026-08-03T00:00:00Z'),
              supports: ['name', 'title', 'company', 'contact'],
            },
          ],
        }),
      ],
    }

    await runDecisionMakerDiscovery('run_1')
    const names = db.decisionMakerCandidate.create.mock.calls.map(
      (c) => (c[0] as { data: { fullName: string } }).data.fullName,
    )
    expect(names).toContain('Dana Reed')
    expect(names).toContain('Ben Ali')
  })
})

// ── Stored exclusion reasons and counts ───────────────────────────────────

describe('what is stored about people who were not shortlisted', () => {
  it('stores the fallback-policy reason for a suppressed Owner, and counts every non-shortlisted person', async () => {
    scripted.crm_contacts = {
      status: 'available',
      candidates: [
        draft(),
        draft({ fullName: 'Olive Owner', rawTitle: 'Owner' }),
        draft({ fullName: 'Fin Chief', rawTitle: 'Chief Financial Officer' }),
      ],
    }
    await runDecisionMakerDiscovery('run_1')

    const rows = db.decisionMakerCandidate.create.mock.calls.map(
      (c) => (c[0] as { data: { fullName: string; outcome: string; exclusionReason: string | null } }).data,
    )
    const owner = rows.find((r) => r.fullName === 'Olive Owner')!
    expect(owner.outcome).toBe('excluded')
    expect(owner.exclusionReason).toMatch(/executive-sponsor fallback/)
    expect(owner.exclusionReason).not.toMatch(/Ranked below/)

    const completed = db.decisionMakerRun.update.mock.calls
      .map((c) => (c[0] as { data: { status?: string; candidateCount?: number; excludedCount?: number } }).data)
      .find((d) => d.status === 'completed')!
    expect(completed.candidateCount).toBe(1)
    expect(completed.excludedCount).toBe(2)
  })

  it('clears this run’s earlier candidate rows inside the write transaction, so a retry cannot duplicate them', async () => {
    scripted.crm_contacts = { status: 'available', candidates: [draft()] }
    await runDecisionMakerDiscovery('run_1')
    expect(db.$transaction).toHaveBeenCalled()
    expect(db.decisionMakerCandidate.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't1', dmRunId: 'run_1' } })
    const deleteOrder = db.decisionMakerCandidate.deleteMany.mock.invocationCallOrder[0]!
    const createOrder = db.decisionMakerCandidate.create.mock.invocationCallOrder[0]!
    expect(deleteOrder).toBeLessThan(createOrder)
  })
})

// ── Nothing found stays nothing found ─────────────────────────────────────

describe('when no source finds anybody', () => {
  it('says so, and invents no one', async () => {
    await runDecisionMakerDiscovery('run_1')

    expect(db.decisionMakerCandidate.create).not.toHaveBeenCalled()
    const call = db.decisionMakerRun.update.mock.calls.find(
      (c) => (c[0] as { data?: { noResultsReason?: unknown } })?.data?.noResultsReason,
    )
    const reason = (call?.[0] as { data: { noResultsReason: string } } | undefined)?.data?.noResultsReason
    expect(typeof reason).toBe('string')
    expect(reason).not.toMatch(/dana|ben|@/i)
  })

  it('still shows every provider it asked', async () => {
    await runDecisionMakerDiscovery('run_1')
    expect(writtenProviders().map((p) => p.provider)).toEqual(providerNames())
  })
})
