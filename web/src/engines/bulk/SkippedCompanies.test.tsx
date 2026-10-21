import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// THE SKIPPED COMPANIES OF A BULK SEND (2026-10-21): each skipped company with
// its email and reason, and a download of the same list as Excel. Read-only.

const get = vi.fn()
vi.mock('../../lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) }, getToken: () => 'tok' }))

import { SkippedCompanies } from './SkippedCompanies'

const report = {
  campaign: { id: 'c1', name: 'Evolution Motion — Oct 17', sourceFileName: 'list.xlsx', startLocal: 'Sat, Oct 17, 2026, 8:25 PM IST', status: 'completed' },
  counts: { total: 89, sent: 78, failed: 0, skipped: 11 },
  rows: [
    { no: 2, companyName: 'Athena Supply', contactName: null, toEmail: 'info@athena-supply.com', ccEmails: [], sourceRows: [3], status: 'skipped', reason: 'No contact name, so the greeting [First Name] cannot be filled.', detail: null, skippedLocal: 'Sat, Oct 17, 2026, 8:20 PM IST' },
  ],
}

beforeEach(() => {
  get.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SkippedCompanies', () => {
  it('lists each skipped company with its email and the reason', async () => {
    get.mockResolvedValue(report)
    render(<SkippedCompanies id="latest" onBack={() => {}} />)
    expect(await screen.findByText('Athena Supply')).toBeTruthy()
    expect(screen.getByText('info@athena-supply.com')).toBeTruthy()
    expect(screen.getByText('No contact name, so the greeting [First Name] cannot be filled.')).toBeTruthy()
    expect(screen.getByText(/11/)).toBeTruthy()
    expect(get.mock.calls[0]![0]).toBe('/outreach/bulk/latest/skipped')
  })

  it('says so when nothing was skipped, and has nothing to download', async () => {
    get.mockResolvedValue({ ...report, counts: { total: 3, sent: 3, failed: 0, skipped: 0 }, rows: [] })
    render(<SkippedCompanies id="c1" onBack={() => {}} />)
    expect(await screen.findByText('No skipped companies')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Download Excel/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('downloads the Excel file with the sign-in token', async () => {
    get.mockResolvedValue(report)
    const fetchMock = vi.fn(async () => new Response(new Blob(['x']), { status: 200, headers: { 'Content-Disposition': 'attachment; filename="skipped-companies-x.xlsx"' } }))
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<SkippedCompanies id="c1" onBack={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /Download Excel/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toBe('/api/v1/outreach/bulk/c1/skipped.xlsx')
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('shows why when the Excel file cannot be made', async () => {
    get.mockResolvedValue(report)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    render(<SkippedCompanies id="c1" onBack={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /Download Excel/ }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/HTTP 500/)).toBeTruthy()
  })
})
