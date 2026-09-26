import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { IntentSignals } from './IntentSignals'

// THE LATEST-RUN PANEL SAYS WHAT EACH PROVIDER DID, IN SEPARATE WORDS.
//
// Two live defects: provider name and count ran together ("CRM0 signals",
// "Apify jobsdid not run — …"), and every run read PARTIAL because a provider
// switched off by configuration, or a careers page that simply does not
// exist, was worded as "could not run".

const COMPANY = { crmCompanyId: 'co_1', companyName: 'Northwind', sourceUrl: 'https://northwind.test/' }

vi.mock('../lib/companyContext', () => ({
  useCompany: () => ({ company: COMPANY, companies: [COMPANY], select: () => undefined }),
}))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate'] },
  }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/intent']}>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

const RUN = {
  id: 'run_1',
  crmCompanyId: COMPANY.crmCompanyId,
  companyName: 'Northwind',
  status: 'completed',
  signalCount: 0,
  duplicatesCollapsed: 0,
  costUsd: 0,
  failureReason: null,
  createdAt: '2026-09-11T06:10:00.000Z',
  completedAt: '2026-09-11T06:10:05.000Z',
}

function serve(providerResults: unknown[], run: Record<string, unknown> = RUN) {
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const body = /\/signals/.test(u)
      ? { crmCompanyId: COMPANY.crmCompanyId, total: 0, byCategory: {}, byPolarity: {}, signals: [] }
      : /\/runs\/run_1/.test(u)
        ? { ...run, providerResults }
        : /\/runs/.test(u)
          ? { total: 1, runs: [run] }
          : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* no storage */
  }
})
afterEach(() => vi.unstubAllGlobals())

describe('provider outcomes in the latest-run panel', () => {
  it('separates the provider name from its outcome', async () => {
    serve([
      { provider: 'crm', ok: true, signals: 0, reason: null },
      { provider: 'apify_jobs', ok: false, signals: 0, reason: 'APIFY_TOKEN is not set', metadata: { notConfigured: true } },
    ])
    render(<IntentSignals />)

    const item = (await screen.findByText(/APIFY_TOKEN is not set/)).closest('li')!
    expect(item.textContent).toMatch(/Apify jobs not configured — APIFY_TOKEN is not set/)
    const crm = screen.getByText('CRM').closest('li')!
    expect(crm.textContent).toMatch(/^CRM looked, found none/)
    expect(document.body.textContent).not.toMatch(/CRM0/)
    expect(document.body.textContent).not.toMatch(/jobsdid not run/)
  })

  it('does not call a run PARTIAL for expected outcomes', async () => {
    serve([
      { provider: 'crm', ok: true, signals: 0, reason: null },
      { provider: 'careers_page', ok: true, signals: 0, reason: 'No careers page found on northwind.test.' },
      { provider: 'apify_jobs', ok: false, signals: 0, reason: 'disabled', metadata: { notConfigured: true } },
    ])
    render(<IntentSignals />)
    await screen.findByText(/No careers page found/)
    expect(screen.queryByText('PARTIAL')).toBeNull()
    expect(document.body.textContent).not.toMatch(/could not run/)
  })

  it('still calls a run PARTIAL when a provider really failed', async () => {
    serve([
      { provider: 'crm', ok: true, signals: 0, reason: null },
      { provider: 'social_profiles', ok: false, signals: 0, reason: 'No page could be read' },
    ])
    render(<IntentSignals />)
    expect(await screen.findByText(/could not run — No page could be read/)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/1 of 2 providers failed/)
  })

  it('disables the detect button while the company’s latest run is in flight', async () => {
    serve([], { ...RUN, status: 'running', completedAt: null })
    render(<IntentSignals />)
    const button = await screen.findByRole('button', { name: /detect/i })
    expect(button).toBeDisabled()
  })
})
