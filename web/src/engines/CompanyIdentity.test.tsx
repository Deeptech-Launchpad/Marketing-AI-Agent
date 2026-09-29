import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { ProspectDiscovery } from './ProspectDiscovery'
import { ContextPanel } from '../components/shell/ContextPanel'

// A COMPANY FOUND BY PROSPECTS IS NOT AN NXT SALES COMPANY.
//
// The selected-company panel and the Account panel used to call every
// selected company an "NXT Sales company" and print its id as a "CRM
// record" — including a company a Prospects search found, whose id is this
// platform's own. Both now show what the live identity check answered.

const SELECTED = { crmCompanyId: 'vvd4xwmxcixy44uodpdly96x', companyName: 'Europharma Ltd.', website: 'https://europharma.com.mt/' }
let answer: Record<string, unknown> = {}
const select = vi.fn()

vi.mock('../lib/companyContext', () => ({
  useCompany: () => ({ company: SELECTED, companies: [SELECTED], select, loading: false, reload: () => undefined }),
}))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ can: () => true, principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate'] } }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

const identity = (kind: string, over: Record<string, unknown> = {}) => ({
  id: SELECTED.crmCompanyId,
  kind,
  crmCompanyId: null,
  discoveredCompanyId: null,
  name: 'Europharma Ltd.',
  website: null,
  searchObjective: null,
  checkedAt: '2026-09-28T10:00:00.000Z',
  reason: 'x',
  ...over,
})

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const body = /\/identity$/.test(u) ? answer : u.includes('/company-discovery/searches') ? { searches: [] } : { events: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})

const panel = async () => (await screen.findByText('Selected company', { selector: 'h2' })).closest('section') as HTMLElement

describe('the selected-company panel', () => {
  it('shows a Prospects find as "Found by Prospects", with the search that found it and no CRM record', async () => {
    answer = identity('discovered', { discoveredCompanyId: SELECTED.crmCompanyId, searchObjective: 'medical supply companies in Malta' })
    render(<ProspectDiscovery />)
    const p = await panel()
    expect(await within(p).findAllByText('Found by Prospects')).not.toHaveLength(0)
    expect(within(p).getByText('medical supply companies in Malta')).toBeInTheDocument()
    expect(within(p).queryByText('NXT Sales company')).toBeNull()
    expect(within(p).queryByText('CRM record')).toBeNull()
    expect(within(p).queryByText(SELECTED.crmCompanyId)).toBeNull()
    expect(within(p).getByText(/not an NXT Sales record/)).toBeInTheDocument()
  })

  it('shows a real NXT Sales company as before — its source and its CRM record id', async () => {
    answer = identity('crm', { crmCompanyId: SELECTED.crmCompanyId })
    render(<ProspectDiscovery />)
    const p = await panel()
    expect(await within(p).findAllByText('NXT Sales company')).not.toHaveLength(0)
    expect(within(p).getByText('CRM record')).toBeInTheDocument()
    expect(within(p).getByText(SELECTED.crmCompanyId)).toBeInTheDocument()
  })

  it('does not claim a CRM record for an id NXT Sales does not hold', async () => {
    answer = identity('not_in_crm', { reason: 'NXT Sales holds no record with this id, and no Prospects search found it.' })
    render(<ProspectDiscovery />)
    const p = await panel()
    expect(await within(p).findAllByText('Not in NXT Sales')).not.toHaveLength(0)
    expect(within(p).queryByText(SELECTED.crmCompanyId)).toBeNull()
  })
})

describe('the Account panel', () => {
  it('shows no CRM id for a Prospects find — its source instead', async () => {
    answer = identity('discovered', { discoveredCompanyId: SELECTED.crmCompanyId })
    render(<ContextPanel />)
    expect(await screen.findByText('Found by Prospects')).toBeInTheDocument()
    expect(screen.queryByText('CRM id')).toBeNull()
    expect(screen.queryByText(SELECTED.crmCompanyId)).toBeNull()
  })

  it('shows the CRM id for a company NXT Sales holds', async () => {
    answer = identity('crm', { crmCompanyId: SELECTED.crmCompanyId })
    render(<ContextPanel />)
    expect(await screen.findByText('CRM id')).toBeInTheDocument()
    expect(screen.getByText(SELECTED.crmCompanyId)).toBeInTheDocument()
  })
})
