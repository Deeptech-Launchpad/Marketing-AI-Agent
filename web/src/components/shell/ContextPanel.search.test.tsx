import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../../lib/theme'
import { ContextPanel } from './ContextPanel'

// PICKING A COMPANY THAT THE PLATFORM HAS NEVER TOUCHED.
//
// The picker listed the enrichment register and nothing else, so a company
// sitting in the customer's CRM could not be selected until some engine had
// happened to work on it. It now asks the CRM as well — by name, and by the
// industry the typed words name.

const KNOWN = { crmCompanyId: 'co-known', companyName: 'Jamesco Trading Ltd', technologyCount: 0 }
const select = vi.fn()

vi.mock('../../lib/companyContext', () => ({
  useCompany: () => ({ company: KNOWN, companies: [KNOWN], select, loading: false, reload: () => undefined }),
}))

const CRM_ANSWER = {
  query: 'medical',
  companies: [
    {
      crmCompanyId: 'co-star',
      companyName: 'Star Medical',
      website: 'https://starmedical.test/',
      industry: 'Medical Devices & Supplies',
      country: 'Malta',
      matchedOn: 'industry' as const,
    },
  ],
  industries: ['Medical Devices & Supplies'],
  truncated: false,
  industryReadError: null,
  note: 'Matched by name, and by the CRM industry "Medical Devices & Supplies".',
}

let asked: string[] = []

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

beforeEach(() => {
  asked = []
  select.mockClear()
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    asked.push(u)
    const body = /companies\/search/.test(u) ? CRM_ANSWER : { events: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})
afterEach(() => vi.unstubAllGlobals())

const openPicker = async () => {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Jamesco Trading Ltd/ }))
  return user
}

describe('the company picker searches the CRM', () => {
  it('offers a company the platform has never worked on', async () => {
    render(<ContextPanel />)
    const user = await openPicker()
    await user.type(screen.getByLabelText(/Search companies in the CRM/i), 'medical')
    expect(await screen.findByText('Star Medical')).toBeInTheDocument()
    expect(screen.getByText('In NXT Sales')).toBeInTheDocument()
  })

  it('selects it with the facts the CRM holds, and no others', async () => {
    render(<ContextPanel />)
    const user = await openPicker()
    await user.type(screen.getByLabelText(/Search companies in the CRM/i), 'medical')
    await user.click(await screen.findByText('Star Medical'))
    expect(select).toHaveBeenCalledWith({
      crmCompanyId: 'co-star',
      companyName: 'Star Medical',
      sourceUrl: 'https://starmedical.test/',
      website: 'https://starmedical.test/',
      industry: 'Medical Devices & Supplies',
      location: 'Malta',
    })
  })

  it('says which industry the words matched', async () => {
    render(<ContextPanel />)
    const user = await openPicker()
    await user.type(screen.getByLabelText(/Search companies in the CRM/i), 'medical')
    expect(await screen.findByText('Medical Devices & Supplies')).toBeInTheDocument()
  })

  it('asks the CRM nothing until a second character is typed', async () => {
    render(<ContextPanel />)
    const user = await openPicker()
    await user.type(screen.getByLabelText(/Search companies in the CRM/i), 'm')
    await new Promise((r) => setTimeout(r, 400))
    expect(asked.filter((u) => /companies\/search/.test(u))).toEqual([])
  })

  it('filters the platform own list as the word is typed', async () => {
    render(<ContextPanel />)
    const user = await openPicker()
    await user.type(screen.getByLabelText(/Search companies in the CRM/i), 'medical')
    await waitFor(() => expect(screen.queryByRole('option', { name: /Jamesco/ })).toBeNull())
  })

  it('does not search the CRM while the picker is shut', async () => {
    render(<ContextPanel />)
    await new Promise((r) => setTimeout(r, 400))
    expect(asked.filter((u) => /companies\/search/.test(u))).toEqual([])
  })
})
