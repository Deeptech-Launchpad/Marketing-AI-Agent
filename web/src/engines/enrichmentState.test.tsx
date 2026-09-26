import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { Enrichment } from './Enrichment'
import { ContextPanel } from '../components/shell/ContextPanel'
import { latestPerCompany, technologySummary } from '../lib/enrichmentSummary'
import type { CompanyRef } from '../lib/companyContext'

// Stage 2 presentation: the shared panel reads fresh register data, technology
// is shown by name with a status-based empty state, the run button cannot
// queue a duplicate, the register counts companies rather than runs, and a
// no-website run explains itself in its own words. Generic fixtures only.

const ctx: { company: CompanyRef | null; companies: CompanyRef[]; reload: () => void } = {
  company: null,
  companies: [],
  reload: vi.fn(),
}
vi.mock('../lib/companyContext', () => ({
  useCompany: () => ({ ...ctx, select: () => undefined, loading: false }),
}))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate', 'approve'] },
  }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let routes: Array<[RegExp, () => Response]> = []
function stubApi() {
  vi.stubGlobal('fetch', async (url: string) => {
    for (const [re, make] of routes) if (re.test(String(url))) return make()
    return json({ error: { code: 'not_found', message: 'none' } }, 404)
  })
}

beforeEach(() => {
  routes = []
  ctx.company = null
  ctx.companies = []
  ctx.reload = vi.fn()
  stubApi()
})

describe('enrichmentSummary', () => {
  it('names technologies instead of counting them', () => {
    expect(technologySummary({ status: 'enriched', technologies: [{ name: 'Shopify' }] })).toBe('Shopify')
    expect(
      technologySummary({ status: 'enriched', technologies: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] }),
    ).toBe('A, B, C +1 more')
  })

  it('chooses the empty state by status', () => {
    expect(technologySummary(null)).toBe('Not enriched yet')
    expect(technologySummary({ status: 'enriched', technologies: [] })).toBe('None detected')
    expect(technologySummary({ status: 'unreachable', technologies: [] })).toBe('Website unreachable')
    expect(technologySummary({ status: 'no_website' })).toBe('No website on record')
    expect(technologySummary({ status: 'running' })).toBe('Enrichment in progress')
  })

  it('keeps the latest row per company', () => {
    const rows = [
      { id: '3', crmCompanyId: 'a', createdAt: '2026-09-03' },
      { id: '2', crmCompanyId: 'b', createdAt: '2026-09-02' },
      { id: '1', crmCompanyId: 'a', createdAt: '2026-09-01' },
    ]
    expect(latestPerCompany(rows).map((r) => r.id)).toEqual(['3', '2'])
  })
})

describe('shared context panel', () => {
  it('shows the fresh register entry, not the frozen selection', async () => {
    ctx.company = { crmCompanyId: 'co_a', companyName: 'Acme Parts', sourceUrl: null }
    ctx.companies = [
      {
        crmCompanyId: 'co_a',
        companyName: 'Acme Parts',
        sourceUrl: 'https://acme-parts.example/',
        technologyCount: 1,
        enrichmentStatus: 'enriched',
        technologies: ['Shopify'],
      },
    ]
    render(<ContextPanel />)
    expect(await screen.findByText('Shopify')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /acme-parts\.example/ })).toBeInTheDocument()
    expect(screen.queryByText('Not recorded')).toBeNull()
  })

  it('says why technology is empty', async () => {
    ctx.company = { crmCompanyId: 'co_b', companyName: 'Beta Tools', website: 'beta-tools.example' }
    ctx.companies = [{ ...ctx.company, enrichmentStatus: 'unreachable', technologies: [] }]
    render(<ContextPanel />)
    expect(await screen.findByText(/Website unreachable/)).toBeInTheDocument()
    // Falls back to the discovery website when enrichment recorded none.
    expect(screen.getByRole('link', { name: /beta-tools\.example/ })).toBeInTheDocument()
  })

  it('a company never enriched is "Not enriched yet", not "None detected"', async () => {
    ctx.company = { crmCompanyId: 'co_c', companyName: 'Gamma Co' }
    ctx.companies = [ctx.company]
    render(<ContextPanel />)
    expect(await screen.findByText(/Not enriched yet/)).toBeInTheDocument()
    expect(screen.queryByText(/None detected/)).toBeNull()
  })
})

const row = (over: Record<string, unknown> = {}) => ({
  id: 'enr_1',
  crmCompanyId: 'co_a',
  companyName: 'Acme Parts',
  status: 'enriched',
  sourceUrl: 'https://acme-parts.example/',
  technologies: [{ name: 'Shopify', category: 'ecommerce', evidence: 'cdn.shopify.com/s' }],
  technologyCount: 1,
  failureReason: null,
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  signals: {},
  provenance: [],
  ...over,
})

describe('Enrichment engine', () => {
  beforeEach(() => {
    ctx.company = { crmCompanyId: 'co_a', companyName: 'Acme Parts' }
  })

  it('disables Run enrichment while the latest run is queued', async () => {
    routes = [[/\/enrichment\/companies\/co_a/, () => json(row({ status: 'queued', finishedAt: null, technologies: [], technologyCount: 0 }))]]
    render(<Enrichment />)
    await screen.findByText(/Waiting to run|Queued and waiting/)
    const btn = screen.getAllByRole('button', { name: /run enrichment/i })[0]!
    expect(btn).toBeDisabled()
  })

  it('enables Run enrichment once the run has finished', async () => {
    routes = [[/\/enrichment\/companies\/co_a/, () => json(row())]]
    render(<Enrichment />)
    await screen.findByText('Technology detected on the site')
    const btn = screen.getAllByRole('button', { name: /run enrichment/i })[0]!
    expect(btn).not.toBeDisabled()
  })

  it('re-reads the shared company register after requesting a run', async () => {
    routes = [
      [/\/enrichment\/companies\/co_a/, () => json(row())],
      [/\/enrichment\/companies$/, () => json({ queued: 1, enrichments: [{ id: 'enr_2', crmCompanyId: 'co_a' }] }, 202)],
    ]
    render(<Enrichment />)
    await screen.findByText('Technology detected on the site')
    const btn = screen.getAllByRole('button', { name: /run enrichment/i })[0]!
    btn.click()
    await waitFor(() => expect(ctx.reload).toHaveBeenCalled())
  })

  it('counts companies in the register, not runs', async () => {
    routes = [
      [/\/enrichment\/companies\/co_a/, () => json(row())],
      [
        /\/enrichment(\?|$)/,
        () =>
          json({
            enrichments: [
              row({ id: 'r3', crmCompanyId: 'co_a', createdAt: '2026-09-03T00:00:00Z' }),
              row({ id: 'r2', crmCompanyId: 'co_b', companyName: 'Beta', createdAt: '2026-09-02T00:00:00Z' }),
              row({ id: 'r1', crmCompanyId: 'co_a', createdAt: '2026-09-01T00:00:00Z' }),
            ],
          }),
      ],
    ]
    render(<Enrichment />)
    expect(await screen.findByText('2 companies')).toBeInTheDocument()
  })

  it("explains a no-website run with the run's own reason", async () => {
    const reason = 'The website field holds a social profile (facebook.com), which is not a company website.'
    routes = [
      [
        /\/enrichment\/companies\/co_a/,
        () =>
          json(
            row({
              status: 'no_website',
              sourceUrl: null,
              technologies: [],
              technologyCount: 0,
              failureReason: null,
              provenance: [
                { label: 'crm_data', statement: 'Company "Acme Parts" loaded from NXT Sales.' },
                { label: 'crm_data', statement: 'Industry: UNKNOWN; country: UNKNOWN.' },
                { label: 'crm_data', statement: reason },
              ],
            }),
          ),
      ],
    ]
    render(<Enrichment />)
    await waitFor(() => expect(document.body.textContent).toContain(`with no website this stage could read. ${reason}`))
    expect(document.body.textContent).not.toContain('neither a domain nor a product URL')
  })
})
