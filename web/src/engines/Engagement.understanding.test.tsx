import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { Engagement } from './Engagement'

// THE "UNDERSTANDING" PANEL (2026-09-24 restructure) — Intent Source,
// Engagement and Qualification shown side by side on the same screen that
// already renders the raw timeline.
//
// This is additive to Engagement.tsx's existing, deliberate absence of a
// Summary panel (see that file's own header comment): the timeline stays
// exactly as it was, and this is new, separate information underneath it.

const COMPANY = { crmCompanyId: 'co-1', companyName: 'Acme Safety Co' }

vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: COMPANY }) }))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ can: () => true, principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view'] } }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

function stub(understanding: unknown, timeline: unknown = { events: [] }) {
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/understanding')) return json(understanding)
    if (u.includes('/timeline')) return json(timeline)
    return json({})
  })
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* no storage */ }
})

describe('the Understanding panel', () => {
  it('shows the intent signal, engagement level and qualification status, each with its own evidence', async () => {
    stub({
      crmCompanyId: COMPANY.crmCompanyId,
      intentSource: {
        count: 1,
        byCategory: { hiring: 1 },
        signals: [
          { id: 'sig-1', signalType: 'careers_page_role', signalCategory: 'hiring', summary: 'Careers page mentions a buyer role', sourceUrl: 'https://acme.test/careers', detectedAt: '2026-09-20T00:00:00.000Z' },
        ],
      },
      engagement: { level: 'HIGH', policyStatus: 'provisional' },
      qualification: { status: 'qualified_unassigned' },
      disclaimers: ['Intent Source, Engagement and Qualification are shown side by side, not combined into one number. Each keeps its own evidence.'],
    })

    render(<Engagement />)

    expect(await screen.findByText('Understanding')).toBeInTheDocument()
    expect(screen.getByText('Careers page mentions a buyer role')).toBeInTheDocument()
    expect(screen.getByText('HIGH')).toBeInTheDocument()
    expect(screen.getByText('qualified unassigned')).toBeInTheDocument()
    expect(screen.getByText(/shown side by side, not combined into one number/i)).toBeInTheDocument()
  })

  it('never renders the raw normalizedScore or a qualification threshold, only the level and status words', async () => {
    stub({
      crmCompanyId: COMPANY.crmCompanyId,
      intentSource: { count: 0, byCategory: {}, signals: [] },
      engagement: { level: 'MEDIUM', policyStatus: 'provisional' },
      qualification: { status: 'not_qualified' },
      disclaimers: [],
    })

    render(<Engagement />)
    await screen.findByText('Understanding')

    // The endpoint itself never sends these fields (see engagement/understanding.ts),
    // so this also guards against a future change that widens the response.
    expect(document.body.textContent).not.toMatch(/normalizedScore|rawScore/i)
  })

  it('shows an honest "not yet" state when nothing has been calculated', async () => {
    stub({
      crmCompanyId: COMPANY.crmCompanyId,
      intentSource: { count: 0, byCategory: {}, signals: [] },
      engagement: null,
      qualification: null,
      disclaimers: ['No engagement score has been calculated for this company yet.', 'No qualification has been evaluated for this company yet.'],
    })

    render(<Engagement />)

    expect(await screen.findByText('Understanding')).toBeInTheDocument()
    expect(screen.getByText('No active intent signal')).toBeInTheDocument()
    expect(screen.getByText('Not yet calculated')).toBeInTheDocument()
    expect(screen.getByText('Not yet evaluated')).toBeInTheDocument()
  })

  it('does not block or replace the existing Timeline panel', async () => {
    stub(
      {
        crmCompanyId: COMPANY.crmCompanyId,
        intentSource: { count: 0, byCategory: {}, signals: [] },
        engagement: null,
        qualification: null,
        disclaimers: [],
      },
      {
        events: [
          {
            id: 'ev-1', crmCompanyId: COMPANY.crmCompanyId, actor: 'prospect', eventType: 'email_opened', channel: 'email',
            source: 'email', sourceProvider: null, occurredAt: '2026-09-20T00:00:00.000Z', receivedAt: '2026-09-20T00:00:00.000Z',
            freshnessLabel: 'recent', ageHours: 1, timestampNote: null, sessionRef: null, workbenchDemoId: null, outreachActionId: null,
            auditRunId: null, evidence: { what: 'Opened an email', where: null, how: 'Pixel', referenceKind: null, referenceId: null }, metadata: {},
          },
        ],
      },
    )

    render(<Engagement />)

    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    expect(screen.getByText('Understanding')).toBeInTheDocument()
  })
})
