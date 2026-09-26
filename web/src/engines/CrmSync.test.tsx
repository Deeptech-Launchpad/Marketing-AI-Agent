import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { CrmSync } from './CrmSync'

// THE HANDOFF SCREEN MUST NAME THE BLOCKER IT ACTUALLY HAS.
//
// A held handoff has several possible reasons and they call for completely
// different actions: a lead that never qualified is nobody's bug, while a
// missing write adapter is an engineering task. The screen once said "CRM
// write adapter unavailable" for all of them, which sent a reader to fix the
// wrong thing — and today every real record is held for the other reason.

const COMPANY = { crmCompanyId: 'co-1', companyName: 'Ac Cleaning', sourceUrl: 'https://ac.test/', technologyCount: 0 }

vi.mock('../lib/companyContext', () => ({
  useCompany: () => ({ company: COMPANY, companies: [COMPANY], select: () => undefined }),
}))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'Operator', role: 'admin', permissions: ['view', 'operate'] },
  }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

const QUALIFICATION = { id: 'q-1', crmCompanyId: COMPANY.crmCompanyId, evaluated: true, status: 'not_qualified' }

const PROVIDERS = {
  providers: [
    {
      name: 'nxt_sales',
      destination: 'NXT Sales CRM',
      status: 'available',
      reason: null,
      remediation: 'Approve a CRM write adapter and add the write methods to the CRM port.',
      capabilities: { canCreate: false, canUpdate: true, canLookup: true },
    },
  ],
  note: 'Availability is detected, never assumed.',
}

const sync = (state: string, stateLabel: string) => ({
  syncId: 'sync-1',
  prepared: true,
  state,
  stateLabel,
  mappingVersion: 'map-1',
  payloadVersion: 'pv-1',
  attempts: 1,
  externalKey: 'ext-1',
  provider: { name: 'nxt_sales', status: 'available' },
  owner: { status: 'unassigned' },
  resources: [],
  validation: { ok: true, issues: [] },
  lastAttemptAt: null,
  lastError: null,
})

function serve(record: ReturnType<typeof sync>) {
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const body = /crm-sync\/providers/.test(u) ? PROVIDERS : /crm-sync/.test(u) ? record : QUALIFICATION
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* no storage */ }
})
afterEach(() => vi.unstubAllGlobals())

describe('a held handoff says why it is held', () => {
  it('names the lead, not the adapter, when the lead never qualified', async () => {
    serve(sync('blocked_not_qualified', 'Not synchronised — the lead is not qualified'))
    render(<CrmSync />)
    // The label appears in the flow verdict and the record panel as well as
    // the blocked notice, which is the point: they all say the same thing.
    expect((await screen.findAllByText(/the lead is not qualified/i)).length).toBeGreaterThan(0)
    expect(screen.getByText(/has not qualified, so nothing is handed to the CRM/i)).toBeInTheDocument()
    expect(screen.queryByText(/write adapter unavailable/i)).toBeNull()
  })

  it('asks for no work on a lead that simply did not qualify', async () => {
    serve(sync('blocked_not_qualified', 'Not synchronised — the lead is not qualified'))
    render(<CrmSync />)
    expect(await screen.findByText(/Nothing to do here/i)).toBeInTheDocument()
    expect(screen.getByText(/This lead only/i)).toBeInTheDocument()
  })

  it('still names the adapter when that is the blocker', async () => {
    serve(sync('blocked_provider_unavailable', 'Prepared — CRM synchronisation unavailable'))
    render(<CrmSync />)
    expect((await screen.findAllByText(/CRM synchronisation unavailable/i)).length).toBeGreaterThan(0)
    expect(screen.getByText(/no approved CRM write adapter is configured/i)).toBeInTheDocument()
    expect(screen.getByText(/Approve a CRM write adapter/i)).toBeInTheDocument()
  })

  it('points at the failed checks when the package did not validate', async () => {
    serve(sync('blocked_validation', 'Blocked — the package did not validate'))
    render(<CrmSync />)
    expect(await screen.findByText(/did not validate, so it was not offered/i)).toBeInTheDocument()
    expect(screen.getByText(/Resolve the failed checks below/i)).toBeInTheDocument()
  })

  it('reports the handoff record whatever the blocker', async () => {
    serve(sync('blocked_missing_owner', 'Blocked — no sales owner assigned'))
    render(<CrmSync />)
    expect(await screen.findByText('Handoff record')).toBeInTheDocument()
    expect(screen.getByText('Correlation key')).toBeInTheDocument()
  })
})
