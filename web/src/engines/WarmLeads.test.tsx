import { afterEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { WarmLeads } from './WarmLeads'
import type { CompanyRow, Overview } from './warmleads/types'

// The Warm Leads screen: what it shows, and that the gates are visible. The server enforces every rule; the
// screen must never make a gated action look available, or an incomplete result look like a classification.

let admin = true
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ can: () => admin, signOut: () => undefined, principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate'] } }),
}))

const emptyUsage = { bucket: 'day:2026-11-04', geminiCalls: 120, geminiCeiling: 300, companiesStarted: 10, companyLimit: 25, retriesStarted: 1, retryLimit: 5, screened: 10, deepResearched: 4, completed: 8, failed: 1, incomplete: 1, pricedCostUsd: 0.0421, unpricedCalls: 3, stoppedReason: null }

const overview = (over: Partial<Overview> = {}): Overview => ({
  stage: 'daily',
  counts: { total: 15137, pending: 15000, inProgress: 0, evaluated: 100, warm: 7, earlySignal: 5, cold: 80, insufficientData: 8, existingCustomer: 2, activeOpportunity: 1, doNotContact: 0, humanReview: 1, failed: 3, needsReevaluation: 2, researchIncomplete: 4, notInCrm: 0 },
  pilot: { run: { id: 'run1', status: 'completed', total: 100, startedAt: null, finishedAt: null, failureReason: null }, counts: { total: 100, queued: 0, running: 0, done: 97, failed: 3, incomplete: 4, warm: 7, earlySignal: 5, cold: 70, insufficientData: 11, humanReview: 1, other: 0 }, approvedAt: '2026-11-02T00:00:00Z', approvedBy: 'u1', canApprove: false },
  settings: {
    paused: true,
    dailyCompanyLimit: 25,
    dailyGeminiCeiling: 300,
    pilotSize: 100,
    pilotGeminiCeiling: 1200,
    approvedMaxCompanies: 25,
    approvedMaxCeiling: 300,
    retryShare: 20,
    window: { start: '23:00', end: '06:00', timezone: 'Asia/Kolkata' },
    pilotApprovedAt: '2026-11-02T00:00:00Z',
    pilotApprovedBy: 'u1',
    scaleApprovedAt: null,
    syncEnabled: false,
    syncApprovedAt: null,
  },
  listRefresh: { requestedAt: null, refreshedAt: '2026-11-03T10:00:00Z', state: 'done', message: '15,137 companies read, 15,137 new.' },
  server: { workerEnabled: true, syncSwitchOn: false, geminiKeyProblem: null, syncLiveAllowed: true },
  windowOpenNow: false,
  bucket: 'day:2026-11-04',
  today: emptyUsage,
  usage: [emptyUsage],
  ...over,
})

const company = (over: Partial<CompanyRow>): CompanyRow => ({
  id: 'row', crmCompanyId: 'c1', name: 'Acme Retail', domain: 'acme.example', country: 'India', industry: 'Retail', state: 'evaluated', cohort: null, classification: 'warm', score: 62, confidence: 'high', summary: null, evaluatedAt: '2026-11-02T00:00:00Z', researchIncomplete: false, attempts: 0, lastError: null, nextAttemptAt: null, syncedEvaluationId: null, currentEvaluationId: 'e1', syncedAt: null, syncError: null, ...over,
})

interface Call { method: string; url: string; body: unknown }
function stub(o: Overview, items: CompanyRow[] = [company({})]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/warm-leads/overview')) return json(o)
    if (url.includes('/warm-leads/companies/')) {
      return json({
        company: items[0],
        history: [
          { id: 'e1', crmCompanyId: 'c1', companyName: 'Acme Retail', website: 'acme.example', status: 'done', classification: 'warm', score: 62, confidence: 'high', summary: 'Replied about a catalogue project.', reasons: [{ signal: 'reply', polarity: 'positive', points: 40, summary: 'A person replied', evidence: 'Re: catalogue', sourceUrl: 'https://news.example/acme', observedAt: '2026-10-30', source: 'crm' }], deepCheck: 'done', tier: 'deep', researchIncomplete: false, geminiCalls: 11, costUsd: 0.01, error: null, evaluatedAt: '2026-11-02T00:00:00Z', bucket: 'day:2026-11-01' },
        ],
      })
    }
    if (url.includes('/warm-leads/companies')) return json({ total: items.length, page: 1, limit: 25, items })
    if (url.includes('/warm-leads/pilot/results')) return json({ evaluations: [] })
    if (url.includes('/warm-leads/pilot/opt-outs')) return json({ items: [] })
    return json({})
  })
  return calls
}

const renderPage = () =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>
        <WarmLeads />
      </MemoryRouter>
    </ThemeProvider>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  admin = true
})

describe('the progress and the statuses', () => {
  it('shows every count the owner asked for, with research-incomplete kept apart from Cold', async () => {
    stub(overview())
    renderPage()
    expect(await screen.findByText('15,137 companies in NXT Sales')).toBeInTheDocument()
    for (const label of ['Evaluated', 'Pending', 'Warm', 'Early signal', 'Cold', 'Not enough data', 'Research incomplete', 'Failed']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0)
    }
    expect(screen.getByText('never counted as Cold')).toBeInTheDocument()
  })

  it('a company whose research was cut short is shown as incomplete - never as Cold', async () => {
    stub(overview(), [company({ name: 'Cut Short Ltd', crmCompanyId: 'c2', state: 'needs_reevaluation', classification: null, score: null, researchIncomplete: true })])
    renderPage()
    const row = (await screen.findByText('Cut Short Ltd')).closest('tr')!
    expect(within(row).getByText('Research incomplete')).toBeInTheDocument()
    expect(within(row).queryByText(/^Cold$/)).toBeNull()
  })

  it('a Warm company whose re-check is due still shows Warm', async () => {
    stub(overview(), [company({ state: 'needs_reevaluation', classification: 'warm' })])
    renderPage()
    const row = (await screen.findByText('Acme Retail')).closest('tr')!
    expect(within(row).getByText(/Warm · re-check due/)).toBeInTheDocument()
  })

  it('opening a company shows its score, confidence, evidence and source link', async () => {
    stub(overview())
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Acme Retail'))
    expect(await screen.findByText('Latest evaluation')).toBeInTheDocument()
    expect(screen.getByText('Score 62/100')).toBeInTheDocument()
    expect(screen.getByText('high confidence')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'source' })
    expect(link).toHaveAttribute('href', 'https://news.example/acme')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })
})

describe('the controls and their gates', () => {
  it('Start is offered while paused, and posts to /start', async () => {
    const calls = stub(overview())
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /^start$/i }))
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/warm-leads/start'))).toBe(true)
  })

  it('shows Pause while running, and says when it is waiting for the window', async () => {
    const o = overview()
    o.settings.paused = false
    stub(o)
    renderPage()
    expect(await screen.findByRole('button', { name: /pause/i })).toBeInTheDocument()
    expect(screen.getByText(/waiting for 23:00–06:00 Asia\/Kolkata/)).toBeInTheDocument()
  })

  it('says plainly when the worker is switched off on the server', async () => {
    const o = overview()
    o.server.workerEnabled = false
    stub(o)
    renderPage()
    expect((await screen.findAllByText(/switched off on this server/i)).length).toBeGreaterThan(0)
  })

  it('says plainly when Warm Leads has no Gemini key of its own, and shows no key', async () => {
    const o = overview()
    o.server.geminiKeyProblem = 'Warm Leads has no Gemini key of its own (WARM_LEADS_GEMINI_API_KEY is empty), so this call was not sent. It does not use the shared key.'
    stub(o)
    renderPage()
    expect((await screen.findAllByText(/no Gemini key of its own/i)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Warm Leads is idle/i)).toBeInTheDocument()
  })

  it('shows no key warning when the key is in place', async () => {
    stub(overview())
    renderPage()
    await screen.findAllByText(/Progress/i)
    expect(screen.queryByText(/Warm Leads is idle/i)).toBeNull()
  })

  it('saving the limits sends numbers to /limits', async () => {
    const calls = stub(overview())
    const user = userEvent.setup()
    renderPage()
    const box = await screen.findByLabelText(/Companies per night/i)
    await user.clear(box)
    await user.type(box, '10')
    await user.click(screen.getByRole('button', { name: /save limits/i }))
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/warm-leads/limits'))
    expect(put?.body).toEqual({ dailyCompanyLimit: 10, dailyGeminiCeiling: 300, retryShare: 20 })
  })

  it('a higher level can only be approved after confirming a review, and only the next level is offered', async () => {
    const calls = stub(overview())
    const user = userEvent.setup()
    renderPage()
    const button = await screen.findByRole('button', { name: /allow up to 50 companies a night \(600 Gemini calls\)/i })
    expect(button).toBeDisabled()
    expect(screen.queryByRole('button', { name: /up to 100/i })).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: /reviewed the usage and the accuracy/i }))
    await user.click(button)
    expect(calls.find((c) => c.url.endsWith('/warm-leads/scale/approve'))?.body).toEqual({ level: 50, confirm: true })
  })

  it('sending to NXT Sales cannot be approved before the pilot is, or while the server switch is off', async () => {
    stub(overview())
    renderPage()
    expect(await screen.findByRole('button', { name: /approve sending to nxt sales/i })).toBeDisabled()
    expect(screen.getAllByText(/WARM_LEADS_SYNC_ENABLED/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Nothing is written to NXT Sales/)).toBeInTheDocument()
  })

  it('a member who is not an admin sees the results but none of the controls', async () => {
    admin = false
    stub(overview())
    renderPage()
    await screen.findByText('15,137 companies in NXT Sales')
    expect(screen.queryByRole('button', { name: /^start$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /save limits/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /read the company list/i })).toBeNull()
    expect(screen.getByLabelText(/Companies per night/i)).toBeDisabled()
  })
})

describe('the pilot', () => {
  const pilotOverview = (stage: Overview['stage'], over: Partial<Overview['pilot']> = {}) => {
    const o = overview({ stage })
    o.settings.pilotApprovedAt = null
    o.pilot = { ...o.pilot, approvedAt: null, approvedBy: null, ...over }
    return o
  }

  it('before a pilot exists: prepare it; nothing else is offered', async () => {
    const calls = stub(pilotOverview('pilot_not_requested', { run: null }))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /prepare the 100-company pilot/i }))
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/warm-leads/pilot'))).toBe(true)
  })

  it('the pilot can only be approved after a review is confirmed', async () => {
    const calls = stub(pilotOverview('pilot_review', { canApprove: true }))
    const user = userEvent.setup()
    renderPage()
    const approve = await screen.findByRole('button', { name: /approve the pilot/i })
    expect(approve).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /reviewed the pilot results/i }))
    await user.click(approve)
    expect(calls.find((c) => c.url.endsWith('/warm-leads/pilot/approve'))?.body).toEqual({ confirm: true })
  })

  it('an unfinished pilot cannot be approved', async () => {
    stub(pilotOverview('pilot_review', { canApprove: false }))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('checkbox', { name: /reviewed the pilot results/i }))
    expect(screen.getByRole('button', { name: /approve the pilot/i })).toBeDisabled()
  })

  it('a pilot that could not be prepared says why and offers another try', async () => {
    stub(pilotOverview('pilot_failed', { run: { id: 'r', status: 'failed', total: 0, startedAt: null, finishedAt: null, failureReason: 'NXT Sales could not be read' } }))
    renderPage()
    expect(await screen.findByText(/NXT Sales could not be read/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /prepare it again/i })).toBeInTheDocument()
  })
})

describe('usage', () => {
  it('shows the night’s companies, Gemini calls against the ceiling, priced cost, and calls without a price', async () => {
    stub(overview())
    renderPage()
    expect((await screen.findAllByText('120/300')).length).toBeGreaterThan(0) // Gemini calls / ceiling (the night, and the table)
    expect(screen.getAllByText('10/25').length).toBeGreaterThan(0) // companies
    expect(screen.getAllByText('$0.0421').length).toBeGreaterThan(0)
    expect(screen.getByText('3 calls without a price')).toBeInTheDocument()
  })
})

// ── Review findings: the screen must never say something that is not true ────

describe('the screen tells the truth about what is happening', () => {
  const withSettings = (patch: Partial<Overview['settings']>, over: Partial<Overview> = {}): Overview => {
    const o = overview(over)
    o.settings = { ...o.settings, ...patch }
    return o
  }

  it('after the pilot has finished it does not say "Running": it says the pilot waits for your review', async () => {
    const o = withSettings({ paused: false, pilotApprovedAt: null }, { stage: 'pilot_review', windowOpenNow: true })
    stub(o)
    renderPage()
    expect(await screen.findByText(/pilot has finished and waits for your review/i)).toBeInTheDocument()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('"Running" only when it can be: daily mode, started, inside the window, and the night has not stopped', async () => {
    stub(withSettings({ paused: false }, { stage: 'daily', windowOpenNow: true }))
    renderPage()
    expect(await screen.findByText('Running')).toBeInTheDocument()
  })

  it('a night that has already stopped is said to have stopped', async () => {
    const o = withSettings({ paused: false }, { stage: 'daily', windowOpenNow: true })
    o.today = { ...(o.today as NonNullable<Overview['today']>), stoppedReason: 'company_limit' }
    stub(o)
    renderPage()
    expect(await screen.findByText(/work for this night has stopped \(company limit\)/i)).toBeInTheDocument()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('Start is disabled, with the reason beside it, when the Warm Leads Gemini key is unusable', async () => {
    const o = withSettings({ paused: true }, { stage: 'daily' })
    o.server = { ...o.server, geminiKeyProblem: 'Warm Leads has no Gemini key of its own (WARM_LEADS_GEMINI_API_KEY is empty).' }
    stub(o)
    renderPage()
    expect(await screen.findByRole('button', { name: /^start$/i })).toBeDisabled()
    expect(screen.getByText(/Start is unavailable: Warm Leads has no Gemini key/i)).toBeInTheDocument()
  })

  it('Start is disabled while the worker is switched off on the server', async () => {
    const o = withSettings({ paused: true })
    o.server = { ...o.server, workerEnabled: false }
    stub(o)
    renderPage()
    expect(await screen.findByRole('button', { name: /^start$/i })).toBeDisabled()
  })

  it('after the pilot is approved it says daily processing is allowed but paused until Start - not "enabled"', async () => {
    stub(withSettings({ paused: true }, { stage: 'daily' }))
    renderPage()
    expect(await screen.findAllByText(/stays paused until you press Start/i)).not.toHaveLength(0)
    expect(screen.queryByText(/Daily processing is enabled/i)).toBeNull()
  })

  it('a pilot with fewer companies than its size says so before it can be approved', async () => {
    const o = withSettings({ paused: true, pilotApprovedAt: null }, { stage: 'pilot_review' })
    o.pilot = { ...o.pilot, counts: { ...o.pilot.counts, total: 40, done: 40, failed: 0, incomplete: 0 } }
    stub(o)
    renderPage()
    expect(await screen.findByText(/This pilot has 40 companies, not 100/i)).toBeInTheDocument()
  })

  it('failed and incomplete pilot companies are counted next to the approval', async () => {
    const o = withSettings({ paused: true, pilotApprovedAt: null }, { stage: 'pilot_review' })
    o.pilot = { ...o.pilot, counts: { ...o.pilot.counts, total: 100, done: 90, failed: 6, incomplete: 4 } }
    stub(o)
    renderPage()
    expect(await screen.findByText(/6 failed and 4 incomplete of 100/i)).toBeInTheDocument()
  })
})

describe('retry, limits and sending: no control that pretends', () => {
  it('"Retry" says how many companies were made due and what has to happen next - it is not instant', async () => {
    const o = overview()
    o.counts = { ...o.counts, failed: 3, needsReevaluation: 0 }
    const calls = stub(o)
    const base = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('/retry-failed') ? (calls.push({ method: 'POST', url: String(input), body: {} }), new Response(JSON.stringify({ retried: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : base(input, init)))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /retry failed or due for a re-check \(3\)/i }))
    expect(await screen.findByText(/3 companies were made due again. They are retried by the worker, not at once/i)).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/retry-failed'))).toBe(true)
  })

  it('with a retry share of 0 it warns that nothing will be retried', async () => {
    const o = overview()
    o.settings = { ...o.settings, retryShare: 0 }
    o.counts = { ...o.counts, failed: 2, needsReevaluation: 0 }
    stub(o)
    const base = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('/retry-failed') ? new Response(JSON.stringify({ retried: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } }) : base(input, init)))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /retry failed or due for a re-check/i }))
    expect(await screen.findByText(/retry share above is 0, so nothing will be retried/i)).toBeInTheDocument()
  })

  it('an emptied limit field is not saved as 0: Save is disabled and the screen says why', async () => {
    stub(overview())
    renderPage()
    const field = await screen.findByLabelText(/Gemini call ceiling per night/i)
    await userEvent.clear(field)
    expect(screen.getByRole('button', { name: /save limits/i })).toBeDisabled()
    expect(screen.getByText(/An empty field is not a limit of 0/i)).toBeInTheDocument()
  })

  it('approving sending needs a ticked confirmation; every closed gate is listed', async () => {
    const o = overview()
    o.settings = { ...o.settings, pilotApprovedAt: '2026-11-02T00:00:00Z', syncEnabled: false }
    o.server = { ...o.server, syncSwitchOn: true, syncLiveAllowed: false }
    const calls = stub(o)
    renderPage()
    const button = await screen.findByRole('button', { name: /approve sending to nxt sales/i })
    expect(button).toBeDisabled()
    expect(screen.getByText(/Needed: writing to this NXT Sales is allowed on this server/i)).toBeInTheDocument()
    expect(screen.getByText(/WARM_LEADS_ALLOW_LIVE is off/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /I approve sending Warm and Early Signal companies/i }))
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(calls.find((c) => c.url.includes('/sync/approve'))?.body).toEqual({ confirm: true })
  })
})

describe('the screen does not blank or hide failures while it refreshes', () => {
  it('the company table stays on screen while a refresh is in flight', async () => {
    let companiesCalls = 0
    const base = stub(overview())
    void base
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (/\/warm-leads\/companies\?/.test(String(input))) {
        companiesCalls++
        if (companiesCalls > 1) return new Promise<Response>(() => undefined) // the refresh never answers
      }
      return inner(input, init)
    })
    renderPage()
    expect(await screen.findByText('Acme Retail')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
    await new Promise((r) => setTimeout(r, 50))
    expect(companiesCalls).toBeGreaterThan(1) // a refresh really was started
    expect(screen.getByText('Acme Retail')).toBeInTheDocument() // and the table was not replaced by "Reading the companies"
    expect(screen.queryByText(/Reading the companies/i)).toBeNull()
  })

  it('when a refresh fails the screen says so instead of showing old data as current', async () => {
    let overviewCalls = 0
    stub(overview())
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/warm-leads/overview')) {
        overviewCalls++
        if (overviewCalls > 1) return new Response(JSON.stringify({ error: { message: 'Session expired' } }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      }
      return inner(input, init)
    })
    renderPage()
    await screen.findAllByText(/Progress/i)
    await userEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
    expect(await screen.findByText(/The screen could not be refreshed/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Progress/i).length).toBeGreaterThan(0) // the last data stays visible, marked as possibly out of date
  })

  it('a failed company whose automatic retries are used up is not described as "will retry"', async () => {
    stub(overview(), [company({ state: 'failed', classification: null, nextAttemptAt: null, attempts: 3 })])
    renderPage()
    expect(await screen.findByText(/Failed — use Retry failed/i)).toBeInTheDocument()
    expect(screen.queryByText(/Failed — will retry/i)).toBeNull()
  })

  it('a failed company still due for an automatic retry says "will retry"', async () => {
    stub(overview(), [company({ state: 'failed', classification: null, nextAttemptAt: '2026-11-05T00:00:00Z', attempts: 1 })])
    renderPage()
    expect(await screen.findByText(/Failed — will retry/i)).toBeInTheDocument()
  })
})
