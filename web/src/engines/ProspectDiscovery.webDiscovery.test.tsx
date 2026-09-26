import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { ProspectDiscovery } from './ProspectDiscovery'

// FIND NEW COMPANY — ONE GENUINE PRODUCT PER COMPANY.
//
// A search result is not a prospect. Each company's own website is opened,
// ONE genuine individual product is analysed, and only a company whose
// product information has a real gap gets a full card: the product URL, the
// issues identified, why our service is relevant, and what the Marketing
// Agent should do next. Everything else is one line with its reason.
//
// This must never touch /prospects or /companies/search (the CRM), and must
// carry a discovered company's OWN id forward when it has no crmCompanyId yet.

const SEARCH_ROW = {
  id: 'wds_1',
  objective: 'Safety and Health companies in the USA',
  requestedCount: null,
  status: 'completed',
  totalCandidatesFound: 5,
  totalAssessed: 3,
  failureReason: null,
  createdAt: '2026-09-24T00:00:00.000Z',
  finishedAt: '2026-09-24T00:01:00.000Z',
}

const analysis = (over: Record<string, unknown>) => ({
  status: 'analysed',
  statusReason: 'Product page found and audited.',
  websiteUrl: null,
  pagesChecked: [],
  product: null,
  audit: null,
  gaps: [],
  issues: [],
  missingInformation: [],
  recommendedActions: [],
  serviceNeed: 'not_assessed',
  whyNeeded: null,
  nextStep: null,
  ...over,
})

const productOf = (name: string, url: string) => ({
  name,
  url,
  description: 'A vented hard hat for construction sites.',
  imageUrl: null,
  brand: null,
  sku: 'X200-WHT',
  category: null,
  price: '$24.99',
  attributes: [
    { name: 'Colour', value: 'White', source: 'specification table' },
    { name: 'Shell material', value: 'HDPE', source: 'specification table' },
  ],
  structure: {
    structuredData: [],
    fieldsPublished: 5,
    fieldsTotal: 16,
    specificationRows: 2,
    wordCount: 180,
    fields: [],
  },
})

const company = (over: Record<string, unknown>) => ({
  domain: null,
  websiteUrl: null,
  websiteSummary: null,
  fitAssessment: null,
  discoverySourceTitle: null,
  productPageUrl: null,
  productAnalysis: null,
  serviceNeed: null,
  status: 'candidate',
  crmCompanyId: null,
  createdAt: '2026-09-24T00:00:30.000Z',
  ...over,
})

const ACME_PRODUCT = 'https://acmesafety.test/products/titan-hard-hat-x200'

const COMPANIES = [
  // Deliberately out of order: the screen, not the API, groups by need.
  company({
    id: 'disc_3',
    companyName: 'Gamma Supply',
    domain: 'gamma.test',
    websiteUrl: 'https://gamma.test/',
    discoverySourceUrl: 'https://gamma.test/',
    productPageUrl: 'https://gamma.test/p/respirator',
    serviceNeed: 'not_needed',
    productAnalysis: analysis({
      websiteUrl: 'https://gamma.test/',
      product: productOf('Pro Respirator', 'https://gamma.test/p/respirator'),
      serviceNeed: 'not_needed',
      whyNeeded: 'The "Pro Respirator" page already presents its product information completely.',
      nextStep: 'No action: this product’s information is already complete.',
    }),
  }),
  company({
    id: 'disc_4',
    companyName: 'https://unreachable.test/about',
    discoverySourceUrl: 'https://www.unreachable.test/about',
    serviceNeed: 'not_assessed',
    productAnalysis: analysis({
      status: 'source_unreadable',
      statusReason: 'The page the search pointed to could not be read (Connection refused), so no company was identified on it.',
    }),
  }),
  company({
    id: 'disc_5',
    companyName: 'Delta Gloves',
    domain: 'deltagloves.test',
    websiteUrl: 'https://deltagloves.test/',
    discoverySourceUrl: 'https://directory.test/delta',
    serviceNeed: 'not_assessed',
    productAnalysis: analysis({
      status: 'no_product_page',
      statusReason: 'The website was opened and 3 page(s) were checked, but none of them showed a single product with its details.',
    }),
  }),
  company({
    id: 'disc_2',
    companyName: 'Beta Industrial Health',
    domain: 'betahealth.test',
    websiteUrl: 'https://betahealth.test/',
    discoverySourceUrl: 'https://directory.test/listing/beta',
    productPageUrl: 'https://betahealth.test/products/ear-defender',
    serviceNeed: 'possible',
    productAnalysis: analysis({
      websiteUrl: 'https://betahealth.test/',
      product: productOf('Ear Defender E5', 'https://betahealth.test/products/ear-defender'),
      gaps: [{ key: 'code', severity: 'gap', title: 'No product code', detail: 'No SKU, part number or model number is shown.' }],
      serviceNeed: 'possible',
      whyNeeded: 'The "Ear Defender E5" page is missing a product code.',
      nextStep: 'Worth a conversation.',
    }),
  }),
  company({
    id: 'disc_1',
    companyName: 'Acme Safety Co',
    domain: 'acmesafety.test',
    websiteUrl: 'https://acmesafety.test/',
    discoverySourceUrl: 'https://acmesafety.test/',
    productPageUrl: ACME_PRODUCT,
    serviceNeed: 'needed',
    productAnalysis: analysis({
      websiteUrl: 'https://acmesafety.test/',
      pagesChecked: [
        { url: 'https://acmesafety.test/', outcome: 'homepage opened' },
        { url: ACME_PRODUCT, outcome: 'product page — "Titan Hard Hat X200"' },
      ],
      product: productOf('Titan Hard Hat X200', ACME_PRODUCT),
      gaps: [
        { key: 'description', severity: 'major', title: 'No product description', detail: 'The page does not describe the product.' },
        { key: 'attributes', severity: 'major', title: 'Attributes and values missing', detail: 'Only 2 attribute(s) are published.' },
        { key: 'gtin', severity: 'minor', title: 'No barcode', detail: 'No GTIN is published.' },
        { key: 'schema', severity: 'minor', title: 'Not machine-readable', detail: 'x' },
      ],
      issues: [],
      missingInformation: [
        { label: 'Brand', recommendation: 'Publish the brand in a dedicated structured field.' },
        { label: 'GTIN / barcode', recommendation: 'Publish the gtin / barcode in a dedicated structured field.' },
      ],
      recommendedActions: [
        {
          title: 'Write a complete product description',
          remediation: 'Write buyer-facing copy from the product’s own specifications.',
          impact: 'x',
          effort: 'Low',
        },
      ],
      serviceNeed: 'needed',
      whyNeeded: 'The "Titan Hard Hat X200" page is missing core product information: no description; only 2 attributes.',
      nextStep: 'Contact this company. Use the "Titan Hard Hat X200" page as the example.',
    }),
  }),
]

const select = vi.fn()
vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: null, select }) }))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate'] },
  }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

let requests: Array<{ url: string; method: string; body: unknown }> = []
let searches: unknown[] = []
let companies: unknown[] = COMPANIES

function stubApi() {
  requests = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    requests.push({ url: u, method, body: init.body ? JSON.parse(String(init.body)) : null })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

    if (method === 'DELETE' && u.includes('/company-discovery/searches/')) {
      const id = u.split('/company-discovery/searches/')[1]!.split(/[?/]/)[0]
      searches = (searches as Array<{ id: string }>).filter((s) => s.id !== id)
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && u.includes('/company-discovery/searches')) {
      searches = [SEARCH_ROW]
      return json({ id: SEARCH_ROW.id, status: 'queued' }, 202)
    }
    if (u.includes('/company-discovery/searches/') && u.includes('/companies')) {
      return json({ status: 'completed', companies })
    }
    if (u.includes('/company-discovery/searches')) return json({ searches })
    return json({})
  })
}

const objectiveBox = () => screen.findByLabelText(/Describe the companies you're looking for/i)
/** One company's card in the opportunity list. */
const card = async (name: string) =>
  (await screen.findByText(name, { selector: 'h4 *, h4' })).closest('article') as HTMLElement

const region = async (name: string) =>
  ((await screen.findAllByLabelText(name)).find((el) => el.tagName === 'SECTION' || el.tagName === 'DETAILS') ??
    null) as HTMLElement

beforeEach(() => {
  select.mockClear()
  searches = [SEARCH_ROW]
  companies = COMPANIES
  stubApi()
  try { localStorage.clear() } catch { /* jsdom without storage */ }
})

describe('the CRM search elements are gone', () => {
  it('draws no New search panel, run result card, searches table or Discover button', async () => {
    render(<ProspectDiscovery />)
    await objectiveBox()

    expect(screen.queryByText('New search')).toBeNull()
    expect(screen.queryByText('Result of this run')).toBeNull()
    expect(screen.queryByText('Searches')).toBeNull()
    expect(screen.queryByText(/New lead discovered/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^discover$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /run discovery/i })).toBeNull()
    expect(screen.queryByLabelText(/^Objective/i)).toBeNull()
  })

  it('never asks the CRM anything', async () => {
    render(<ProspectDiscovery />)
    await screen.findByText('Acme Safety Co')

    expect(requests.some((r) => /\/prospects\/|\/companies\/(search|[^/]+$)/.test(r.url))).toBe(false)
  })
})

describe('Find New Company searches the public web', () => {
  it('posts the objective to /company-discovery/searches', async () => {
    searches = []
    const user = userEvent.setup()
    render(<ProspectDiscovery />)

    await user.type(await objectiveBox(), 'Safety and Health companies in the USA')
    await user.click(screen.getByRole('button', { name: /search the public web/i }))

    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
    const post = requests.find((r) => r.method === 'POST')!
    expect(post.url).toContain('/company-discovery/searches')
    expect(post.body).toEqual({ objective: 'Safety and Health companies in the USA' })
  })

  it('cannot be pressed with nothing to look for', async () => {
    render(<ProspectDiscovery />)
    await objectiveBox()
    expect(screen.getByRole('button', { name: /search the public web/i })).toBeDisabled()
  })
})

describe('only real opportunities get a full card', () => {
  it('groups opportunities first, then one-line lists for no need, no product page, and not checked', async () => {
    render(<ProspectDiscovery />)
    await screen.findByText('Acme Safety Co')

    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(groups).toEqual([
      'Our service is needed',
      'Possible opportunity',
      'No clear need',
      'No genuine product page',
      'Could not be checked',
    ])
  })

  it('puts each opportunity in its own section', async () => {
    render(<ProspectDiscovery />)
    expect(within(await region('Our service is needed')).getByText('Acme Safety Co')).toBeInTheDocument()
    expect(within(await region('Possible opportunity')).getByText('Beta Industrial Health')).toBeInTheDocument()
  })

  it('states the totals in one line', async () => {
    render(<ProspectDiscovery />)
    await screen.findByText('Acme Safety Co')

    const line = document.querySelector('.found__summary-line')!
    expect(line.textContent).toMatch(/5\s*companies found/)
    expect(line.textContent).toMatch(/3\s*products analysed, one\s*per company/)
    expect(line.textContent).toMatch(/2\s*opportunities/)
  })

  it('shows the company, the one product, and its URL', async () => {
    render(<ProspectDiscovery />)
    const needed = await card('Acme Safety Co')

    expect(within(needed).getByText('Acme Safety Co')).toBeInTheDocument()
    expect(within(needed).getByText('The one product analysed')).toBeInTheDocument()
    expect(within(needed).getByRole('link', { name: 'Titan Hard Hat X200' })).toHaveAttribute('href', ACME_PRODUCT)
    expect(within(needed).getByText(ACME_PRODUCT)).toBeInTheDocument()
  })

  it('shows the issues identified, why our service is relevant, and what the Marketing Agent should do next', async () => {
    render(<ProspectDiscovery />)
    const needed = await card('Acme Safety Co')

    expect(within(needed).getByText('Issues identified')).toBeInTheDocument()
    expect(within(needed).getByText('No product description.')).toBeInTheDocument()
    expect(within(needed).getByText('Attributes and values missing.')).toBeInTheDocument()
    expect(within(needed).getByText(/Also noted: no barcode, not machine-readable/)).toBeInTheDocument()
    expect(within(needed).getByText('Why our service is relevant')).toBeInTheDocument()
    expect(within(needed).getByText(/no description; only 2 attributes/)).toBeInTheDocument()
    expect(within(needed).getByText(/Write a complete product description/)).toBeInTheDocument()
    expect(within(needed).getByText('What the Marketing Agent should do next')).toBeInTheDocument()
    expect(within(needed).getByText(/^Contact this company/)).toBeInTheDocument()
  })

  it('is not a website audit: no score and no audit wording', async () => {
    render(<ProspectDiscovery />)
    await screen.findByText('Acme Safety Co')

    expect(screen.queryByText(/\/100/)).toBeNull()
    expect(screen.queryByText(/15-point|scorecard|audited/i)).toBeNull()
  })

  it('keeps the product details — description, attributes and their values, structure — one click away', async () => {
    render(<ProspectDiscovery />)
    const needed = await card('Acme Safety Co')

    expect(within(needed).getByText('Product details')).toBeInTheDocument()
    expect(within(needed).getByText('A vented hard hat for construction sites.')).toBeInTheDocument()
    expect(within(needed).getByRole('rowheader', { name: 'Shell material' })).toBeInTheDocument()
    expect(within(needed).getByText('HDPE')).toBeInTheDocument()
    expect(within(needed).getByText(/5 of 16 product-information fields published/)).toBeInTheDocument()
  })

  it('cites the page a company was found on when that is not its own website', async () => {
    render(<ProspectDiscovery />)
    const possible = await region('Possible opportunity')

    expect(within(possible).getByRole('link', { name: /Found via · directory\.test\/listing\/beta/ })).toHaveAttribute(
      'href',
      'https://directory.test/listing/beta',
    )
  })

  it('lists a company whose product is already complete in one line, with the reason, not as a prospect', async () => {
    render(<ProspectDiscovery />)
    const none = await region('No clear need')

    expect(within(none).getByText('Gamma Supply')).toBeInTheDocument()
    expect(within(none).getByText(/already presents its product information completely/)).toBeInTheDocument()
    expect(within(none).queryByText('Why our service is relevant')).toBeNull()
    expect(within(none).getByRole('link', { name: /gamma\.test\/p\/respirator/ })).toBeInTheDocument()
  })

  it('marks a website with no genuine individual product page accordingly', async () => {
    render(<ProspectDiscovery />)
    const noPage = await region('No genuine product page')

    expect(within(noPage).getByText('Delta Gloves')).toBeInTheDocument()
    expect(within(noPage).getByText(/none of them showed a single product/)).toBeInTheDocument()
  })

  it('does not show a search engine’s redirect link as a source', async () => {
    companies = [
      ...COMPANIES,
      company({
        id: 'disc_9',
        companyName: 'Redirected Co',
        discoverySourceUrl: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
        serviceNeed: 'not_assessed',
        productAnalysis: analysis({ status: 'source_unreadable', statusReason: 'The page could not be read.' }),
      }),
    ]
    render(<ProspectDiscovery />)
    const notChecked = await region('Could not be checked')

    expect(within(notChecked).queryByRole('link', { name: /vertexaisearch/ })).toBeNull()
    expect(within(notChecked).getAllByText('Found by web search').length).toBeGreaterThan(0)
  })
})

describe('many companies are paginated, ten per page', () => {
  const many = Array.from({ length: 23 }, (_, i) =>
    company({
      id: `many_${i + 1}`,
      companyName: `Company ${String(i + 1).padStart(2, '0')}`,
      domain: `c${i + 1}.test`,
      websiteUrl: `https://c${i + 1}.test/`,
      discoverySourceUrl: `https://c${i + 1}.test/`,
      serviceNeed: 'needed',
      productAnalysis: analysis({
        websiteUrl: `https://c${i + 1}.test/`,
        product: productOf(`Product ${i + 1}`, `https://c${i + 1}.test/products/p${i + 1}`),
        gaps: [{ key: 'description', severity: 'major', title: 'No product description', detail: 'x' }],
        serviceNeed: 'needed',
        whyNeeded: 'x',
        nextStep: 'Contact this company.',
      }),
    }),
  )

  it('shows companies 1–10 on page 1, 11–20 on page 2, and 21–23 on page 3', async () => {
    companies = many
    const user = userEvent.setup()
    render(<ProspectDiscovery />)
    const qualified = await region('Our service is needed')

    const names = () => within(qualified).getAllByRole('heading', { level: 4 }).map((h) => h.textContent?.trim())
    expect(names()).toHaveLength(10)
    expect(within(qualified).getByText('1–10 of 23')).toBeInTheDocument()

    await user.click(within(qualified).getByRole('button', { name: 'Page 2' }))
    expect(names()).toHaveLength(10)
    expect(names()[0]).toBe('Company 11')
    expect(within(qualified).getByText('11–20 of 23')).toBeInTheDocument()

    await user.click(within(qualified).getByRole('button', { name: 'Next' }))
    expect(names()).toHaveLength(3)
    expect(within(qualified).getByText('21–23 of 23')).toBeInTheDocument()
    expect(within(qualified).getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('shows no pager when everything fits on one page', async () => {
    render(<ProspectDiscovery />)
    const qualified = await region('Our service is needed')
    expect(within(qualified).queryByRole('button', { name: 'Page 2' })).toBeNull()
  })
})

describe('a product page the website will not let us read', () => {
  it('is listed for manual review with its product link, not called "no product page"', async () => {
    companies = [
      ...COMPANIES,
      company({
        id: 'msc',
        companyName: 'MSC Industrial Supply Co.',
        domain: 'mscdirect.com',
        websiteUrl: 'https://www.mscdirect.com/',
        discoverySourceUrl: 'https://www.mscdirect.com/',
        productPageUrl: 'https://www.mscdirect.com/product/details/00222844',
        serviceNeed: 'not_assessed',
        productAnalysis: analysis({
          status: 'blocked',
          statusReason: 'A product page was found, but the website blocks automated reading (Incapsula bot protection), so it could not be analysed.',
          reviewUrl: 'https://www.mscdirect.com/product/details/00222844',
        }),
      }),
    ]
    render(<ProspectDiscovery />)
    const review = await region('Review manually')

    expect(within(review).getByText('MSC Industrial Supply Co.')).toBeInTheDocument()
    expect(within(review).getByText(/Incapsula bot protection/)).toBeInTheDocument()
    expect(within(review).getByRole('link', { name: /mscdirect\.com\/product\/details\/00222844/ })).toHaveAttribute(
      'href',
      'https://www.mscdirect.com/product/details/00222844',
    )
    const noPage = await region('No genuine product page')
    expect(within(noPage).queryByText('MSC Industrial Supply Co.')).toBeNull()
  })
})

describe('a company that could not be checked is listed apart, with the reason', () => {
  it('shows its host rather than a raw URL as its name, and the reason', async () => {
    render(<ProspectDiscovery />)
    const notChecked = await region('Could not be checked')

    expect(within(notChecked).getByText('unreachable.test')).toBeInTheDocument()
    expect(within(notChecked).queryByText('https://unreachable.test/about')).toBeNull()
    expect(within(notChecked).getByText(/could not be read \(Connection refused\)/)).toBeInTheDocument()
    expect(within(notChecked).getAllByRole('button', { name: /^select$/i }).length).toBeGreaterThan(0)
  })

  it('explains a result from before product analysis existed, rather than hiding it', async () => {
    companies = [company({ id: 'old_1', companyName: 'Old Result Ltd', discoverySourceUrl: 'https://old.test/' })]
    render(<ProspectDiscovery />)
    const notChecked = await region('Could not be checked')

    expect(within(notChecked).getByText(/Found before product analysis was added/)).toBeInTheDocument()
  })
})

describe('selecting a discovered company', () => {
  it('carries its own id forward, since it has no crmCompanyId yet', async () => {
    const user = userEvent.setup()
    render(<ProspectDiscovery />)
    const needed = await card('Acme Safety Co')

    await user.click(within(needed).getByRole('button', { name: /^select$/i }))

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        crmCompanyId: 'disc_1',
        companyName: 'Acme Safety Co',
        sourceUrl: 'https://acmesafety.test/',
        sourceProvider: 'company_web_discovery',
      }),
    )
  })
})

describe('the other states of a search', () => {
  it('says plainly when a search found nothing', async () => {
    companies = []
    render(<ProspectDiscovery />)
    expect(await screen.findByText('No company found')).toBeInTheDocument()
  })

  it('shows why a failed search failed', async () => {
    searches = [{ ...SEARCH_ROW, status: 'failed', failureReason: 'The search provider returned a 500.' }]
    render(<ProspectDiscovery />)
    expect(await screen.findByText('This search did not finish')).toBeInTheDocument()
    expect(screen.getByText(/The search provider returned a 500/)).toBeInTheDocument()
  })

  it('shows a working state, with progress, while a search is running', async () => {
    searches = [{ ...SEARCH_ROW, status: 'running', totalAssessed: 2 }]
    companies = []
    render(<ProspectDiscovery />)
    expect(await screen.findByText(/checking one product on each company’s website — 2 website\(s\) checked so far/i)).toBeInTheDocument()
  })
})

describe('recent searches, as a dropdown', () => {
  const two = () => [SEARCH_ROW, { ...SEARCH_ROW, id: 'wds_0', objective: 'Dental clinics in Ireland', totalCandidatesFound: 7 }]

  it('lists the previous searches and switches to the one chosen', async () => {
    searches = two()
    const user = userEvent.setup()
    render(<ProspectDiscovery />)
    await screen.findByText('Acme Safety Co')

    await user.click(screen.getByRole('button', { name: /Recent searches/ }))
    const menu = screen.getByRole('listbox', { name: 'Recent searches' })
    expect(within(menu).getAllByRole('option')).toHaveLength(2)

    await user.click(within(menu).getByRole('button', { name: /^Dental clinics in Ireland/ }))

    await waitFor(() =>
      expect(requests.some((r) => r.url.includes('/company-discovery/searches/wds_0/companies'))).toBe(true),
    )
    expect(screen.queryByRole('listbox', { name: 'Recent searches' })).toBeNull()
  })

  it('deletes one search from the history, after a confirmation', async () => {
    searches = two()
    const user = userEvent.setup()
    render(<ProspectDiscovery />)
    await screen.findByText('Acme Safety Co')

    await user.click(screen.getByRole('button', { name: /Recent searches/ }))
    await user.click(screen.getByRole('button', { name: /Delete search “Dental clinics in Ireland”/ }))
    // Nothing is deleted until it is confirmed.
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false)

    await user.click(screen.getByRole('button', { name: /^Delete$/ }))

    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE' && r.url.includes('/company-discovery/searches/wds_0'))).toBe(true))
    await waitFor(() =>
      expect(within(screen.getByRole('listbox', { name: 'Recent searches' })).queryByText('Dental clinics in Ireland')).toBeNull(),
    )
  })

  it('can cancel a delete', async () => {
    searches = two()
    const user = userEvent.setup()
    render(<ProspectDiscovery />)
    await screen.findByText('Acme Safety Co')

    await user.click(screen.getByRole('button', { name: /Recent searches/ }))
    await user.click(screen.getByRole('button', { name: /Delete search “Dental clinics in Ireland”/ }))
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }))

    expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
    expect(screen.getByRole('button', { name: /Delete search “Dental clinics in Ireland”/ })).toBeInTheDocument()
  })

  it('does not offer to delete a search that is still running', async () => {
    searches = [{ ...SEARCH_ROW, status: 'running' }]
    const user = userEvent.setup()
    render(<ProspectDiscovery />)

    await user.click(await screen.findByRole('button', { name: /Recent searches/ }))
    expect(screen.getByRole('button', { name: /Delete search/ })).toBeDisabled()
  })
})
