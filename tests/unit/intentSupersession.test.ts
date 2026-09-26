import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmCompany } from '../../src/crm/types.js'

// A SIGNAL THAT STOPPED BEING TRUE.
//
// "Ultra Taps" is a real company. Its website — ultratapsmt.com — loads in
// 200ms and redirects the apex to www. The Intent Signals screen showed three
// cards reading "Website unreachable · high confidence · counts against
// outreach".
//
// Nothing had lied. Three enrichment runs on 4 and 11 September really did
// fail with "The site reset the connection", and the technology provider
// really did record what enrichment observed. The site then recovered, the
// next enrichment read it successfully, and the next intent run — knowing the
// site was fine — emitted NOTHING.
//
// Emitting nothing was the defect. Signals only ever accumulated: there was no
// mechanism by which a later observation could take an earlier one back. So a
// statement about the PRESENT stayed on screen as active evidence, in red,
// long after it had become false.
//
// THE DISTINCTION THAT MAKES THIS SAFE.
//
// Most signals are HISTORICAL EVENTS. "A buyer role was posted on 3 August"
// is true forever, and a later run withdrawing it would be falsifying the
// record. Only signals that assert something about the present may be
// superseded, and only the exact types a provider NAMES. There is no wildcard,
// and expiry is never deletion: the row keeps its evidence, its date and its
// source, and gains the observation that overtook it.

const db = {
  intentSignal: { findMany: vi.fn(), update: vi.fn() },
  companyEnrichment: { findMany: vi.fn() },
}
vi.mock('../../src/platform/db.js', () => ({
  prisma: db,
  newId: () => 'id_' + Math.random().toString(36).slice(2, 10),
}))

const { applySupersessions } = await import('../../src/intent/intentDetection.js')
const { TechnologySignalProvider } = await import('../../src/intent/providers/technologyProvider.js')

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'co_ultrataps',
    name: 'Ultra Taps',
    email: null,
    emails: [],
    phone: null,
    domain: 'ultratapsmt.com',
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

const READ_AT = new Date('2026-09-11T06:07:28Z')
const FAILED_AT = new Date('2026-09-04T05:10:06Z')

const enrichment = (over: Record<string, unknown> = {}) => ({
  id: 'enr_1',
  status: 'enriched',
  sourceUrl: 'https://ultratapsmt.com/',
  technologies: [],
  failureReason: null,
  fetchedAt: READ_AT,
  finishedAt: READ_AT,
  createdAt: READ_AT,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  db.intentSignal.findMany.mockResolvedValue([])
  db.intentSignal.update.mockResolvedValue({})
})
afterEach(() => vi.restoreAllMocks())

// ── 1. The provider says the site is reachable again ──────────────────────

describe('a successful website read withdraws a standing "unreachable"', () => {
  it('emits a supersession naming the type, the instant and the reason', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([enrichment()])

    const r = await new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })

    const s = (r.supersedes ?? []).filter((x) => x.signalType === 'website_unreachable')
    expect(s).toHaveLength(1)
    expect(s[0]!.observedBefore).toEqual(READ_AT)
    expect(s[0]!.reason).toContain('read successfully')
    expect(s[0]!.reason).toContain('https://ultratapsmt.com/')
  })

  it('emits the signal and no supersession while the site really is down', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([
      enrichment({ status: 'unreachable', failureReason: 'The site reset the connection.', fetchedAt: null }),
    ])

    const r = await new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })

    expect(r.signals.map((s) => s.signalType)).toContain('website_unreachable')
    expect(r.supersedes ?? []).toEqual([])
  })

  // A run must never withdraw a fact it is asserting in the same breath.
  it('does not both report and withdraw unreachability in one run', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([enrichment({ status: 'unreachable' })])
    const r = await new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    const reported = r.signals.some((s) => s.signalType === 'website_unreachable')
    const withdrawn = (r.supersedes ?? []).some((s) => s.signalType === 'website_unreachable')
    expect(reported && withdrawn).toBe(false)
  })
})

// ── 2. What the engine does with it ───────────────────────────────────────

describe('applying a supersession', () => {
  const stale = [
    { id: 'sig_1', metadata: { enrichmentId: 'enr_old' } },
    { id: 'sig_2', metadata: null },
  ]

  it('expires the matching signals and says what overtook them', async () => {
    db.intentSignal.findMany.mockResolvedValue(stale)

    const n = await applySupersessions('t1', 'co_ultrataps', 'run_new', [
      { signalType: 'website_unreachable', observedBefore: READ_AT, reason: 'The website was read successfully.' },
    ])

    expect(n).toBe(2)
    expect(db.intentSignal.update).toHaveBeenCalledTimes(2)
    const first = db.intentSignal.update.mock.calls[0]![0] as {
      where: { id: string }
      data: { status: string; metadata: Record<string, unknown> }
    }
    expect(first.where.id).toBe('sig_1')
    expect(first.data.status).toBe('expired')
    expect((first.data.metadata.supersededBy as { reason: string }).reason).toContain('read successfully')
  })

  it('keeps the row and everything already on it', async () => {
    db.intentSignal.findMany.mockResolvedValue([stale[0]])

    await applySupersessions('t1', 'co_ultrataps', 'run_new', [
      { signalType: 'website_unreachable', observedBefore: READ_AT, reason: 'read ok' },
    ])

    const call = db.intentSignal.update.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }
    // Expiry is a correction, not an erasure: the original provider metadata
    // survives alongside the withdrawal.
    expect(call.data.metadata.enrichmentId).toBe('enr_old')
    expect(db.intentSignal.update.mock.calls[0]![0]).not.toHaveProperty('delete')
  })

  // ── The guards. Each of these is a way this could falsify the record. ──

  it('touches only the named signal type — never a wildcard', async () => {
    db.intentSignal.findMany.mockResolvedValue([])
    await applySupersessions('t1', 'co_ultrataps', 'run_new', [
      { signalType: 'website_unreachable', observedBefore: READ_AT, reason: 'read ok' },
    ])
    const where = (db.intentSignal.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.signalType).toBe('website_unreachable')
  })

  it('never withdraws a signal observed AFTER the contradicting observation', async () => {
    db.intentSignal.findMany.mockResolvedValue([])
    await applySupersessions('t1', 'co_ultrataps', 'run_new', [
      { signalType: 'website_unreachable', observedBefore: READ_AT, reason: 'read ok' },
    ])
    const where = (db.intentSignal.findMany.mock.calls[0]![0] as { where: { OR: unknown[] } }).where
    expect(where.OR).toEqual([{ observedAt: { lt: READ_AT } }, { observedAt: null }])
  })

  it('never withdraws a signal this same run produced', async () => {
    db.intentSignal.findMany.mockResolvedValue([])
    await applySupersessions('t1', 'co_ultrataps', 'run_new', [
      { signalType: 'website_unreachable', observedBefore: READ_AT, reason: 'read ok' },
    ])
    const where = (db.intentSignal.findMany.mock.calls[0]![0] as { where: { intentRunId: unknown } }).where
    expect(where.intentRunId).toEqual({ not: 'run_new' })
  })

  it('stays inside the one company', async () => {
    db.intentSignal.findMany.mockResolvedValue([])
    await applySupersessions('t1', 'co_ultrataps', 'run_new', [
      { signalType: 'website_unreachable', observedBefore: READ_AT, reason: 'read ok' },
    ])
    const where = (db.intentSignal.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.crmCompanyId).toBe('co_ultrataps')
    expect(where.tenantId).toBe('t1')
  })

  it('does nothing at all when no provider named a supersession', async () => {
    const n = await applySupersessions('t1', 'co_ultrataps', 'run_new', [])
    expect(n).toBe(0)
    expect(db.intentSignal.findMany).not.toHaveBeenCalled()
    expect(db.intentSignal.update).not.toHaveBeenCalled()
  })

  it('leaves a historical event alone — nothing supersedes a job posting', async () => {
    // The provider never names hiring_signal, so no query for one is ever made.
    db.intentSignal.findMany.mockResolvedValue([])
    db.companyEnrichment.findMany.mockResolvedValue([enrichment()])
    const r = await new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    await applySupersessions('t1', 'co_ultrataps', 'run_new', r.supersedes ?? [])

    const types = db.intentSignal.findMany.mock.calls.map(
      (c) => (c[0] as { where: { signalType: string } }).where.signalType,
    )
    // Only the present-tense types the provider names — the unreachable claim,
    // and the technology change claims it can re-check row by row.
    expect(types).toEqual(['website_unreachable', 'technology_added'])
    expect(types).not.toContain('hiring_signal')
    expect(types).not.toContain('relevant_job_posting')
  })
})

// ── 3. The Ultra Taps sequence, end to end over the two units ─────────────

describe('Ultra Taps — three stale negatives, one recovery', () => {
  it('withdraws all three once the site is read again', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([enrichment()])
    const r = await new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })

    // The three that were recorded while the host was resetting connections.
    db.intentSignal.findMany.mockResolvedValue([
      { id: 'sig_0904a', metadata: { failureReason: 'The site reset the connection.' } },
      { id: 'sig_0904b', metadata: { failureReason: 'The site reset the connection.' } },
      { id: 'sig_0911', metadata: { failureReason: 'The site reset the connection.' } },
    ])

    const n = await applySupersessions('t1', 'co_ultrataps', 'run_new', r.supersedes ?? [])
    expect(n).toBe(3)
    const statuses = db.intentSignal.update.mock.calls.map(
      (c) => (c[0] as { data: { status: string } }).data.status,
    )
    expect(statuses).toEqual(['expired', 'expired', 'expired'])
  })

  it('emits no new "unreachable" for a site that now loads', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([enrichment()])
    const r = await new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    expect(r.signals.some((s) => s.signalType === 'website_unreachable')).toBe(false)
  })

  it('records the failure honestly while it is still failing', async () => {
    db.companyEnrichment.findMany.mockResolvedValue([
      enrichment({
        status: 'unreachable',
        failureReason: 'The site reset the connection.',
        finishedAt: FAILED_AT,
        createdAt: FAILED_AT,
      }),
    ])
    const r = await new TechnologySignalProvider().collect({ tenantId: 't1', company: company(), maxResults: 10 })
    const sig = r.signals.find((s) => s.signalType === 'website_unreachable')!
    expect(sig.polarity).toBe('negative')
    expect(sig.evidence).toContain('The site reset the connection.')
  })
})
