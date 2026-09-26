import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { DecisionMakers } from './DecisionMakers'

// SHOWING WHAT THE SEARCH FOUND, WITHOUT CALLING IT A DECISION MAKER.
//
// Domaco's run saw two people — "Joshua, founder of Codingo" and "Babaji, a
// spiritual consultant" — both read off one third-party page, neither tied to
// Domaco by any source. The screen reported "set aside 2" and named nobody, so
// there was no way to see what had been found or to check the judgement.
//
// Both halves are under test: the people are shown, and they are not presented
// as candidates.

const COMPANY = { crmCompanyId: 'co-domaco', companyName: 'Domaco', technologyCount: 0 }

vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: COMPANY, select: vi.fn() }) }))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate'] },
  }),
}))

const person = (over: Record<string, unknown>) => ({
  id: 'p1',
  fullName: 'Joshua',
  rawTitle: 'founder of Codingo',
  normalizedTitle: null,
  roleGroup: null,
  seniority: null,
  companyMatch: 'unverified',
  profileUrl: null,
  location: null,
  email: null,
  phone: null,
  confidence: 'low',
  contactability: 'none',
  outcome: 'excluded',
  exclusionReason:
    'No source ties this person to this company, so their employment is unproven. Only people whose employment is verified or probable are shortlisted.',
  rank: null,
  evidence: [{ provider: 'public_web_research', sourceUrl: 'https://college.carousell.com/domaco-success-story/' }],
  ...over,
})

const ASIDE_ONLY = {
  crmCompanyId: COMPANY.crmCompanyId,
  companyName: 'Domaco',
  peopleSeen: 2,
  shortlistedCount: 0,
  excludedCount: 2,
  candidates: [person({}), person({ id: 'p2', fullName: 'Babaji', rawTitle: 'spiritual consultant' })],
}

let asked: string[] = []

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

function serve(body: unknown) {
  asked = []
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    asked.push(u)
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/candidates')) return json(body)
    if (u.includes('/runs/latest')) return json({ run: { id: 'r1', status: 'completed' } })
    return json({})
  })
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* no storage */ }
})
afterEach(() => vi.unstubAllGlobals())

describe('people the search found but could not verify', () => {
  it('asks for everyone the run saw, not only the shortlist', async () => {
    serve(ASIDE_ONLY)
    render(<DecisionMakers />)
    await screen.findByText('Found but set aside')
    expect(asked.some((u) => /candidates\?includeExcluded=true/.test(u))).toBe(true)
  })

  it('names them under the reason they share, said once', async () => {
    serve(ASIDE_ONLY)
    render(<DecisionMakers />)
    const panel = (await screen.findByText('Found but set aside')).closest('section')!
    expect(within(panel).getByText('Joshua')).toBeInTheDocument()
    expect(within(panel).getByText('Babaji')).toBeInTheDocument()
    // One heading for both, rather than the same paragraph twice.
    expect(within(panel).getByText('Not tied to this company')).toBeInTheDocument()
    expect(within(panel).getByText(/no source states that they work here/i)).toBeInTheDocument()
  })

  it('keeps the exact sentence the run recorded, on the name itself', async () => {
    serve(ASIDE_ONLY)
    render(<DecisionMakers />)
    const panel = (await screen.findByText('Found but set aside')).closest('section')!
    expect(within(panel).getByText('Joshua')).toHaveAttribute(
      'title',
      expect.stringContaining('No source ties this person to this company') as unknown as string,
    )
  })

  it('separates people set aside for different reasons', async () => {
    serve({
      ...ASIDE_ONLY,
      excludedCount: 2,
      candidates: [
        person({}),
        person({ id: 'p2', fullName: 'Liam Bonner', rawTitle: 'Director', companyMatch: 'verified', roleGroup: null }),
      ],
    })
    render(<DecisionMakers />)
    const panel = (await screen.findByText('Found but set aside')).closest('section')!
    expect(within(panel).getByText('Not tied to this company')).toBeInTheDocument()
    expect(within(panel).getByText('Role does not own product data')).toBeInTheDocument()
  })

  it('links to the page each was read on, so the judgement can be checked', async () => {
    serve(ASIDE_ONLY)
    render(<DecisionMakers />)
    const panel = (await screen.findByText('Found but set aside')).closest('section')!
    const link = within(panel).getAllByRole('link', { name: /Where this was read/ })[0]!
    expect(link).toHaveAttribute('href', 'https://college.carousell.com/domaco-success-story/')
  })

  it('does not present them as candidates', async () => {
    serve(ASIDE_ONLY)
    render(<DecisionMakers />)
    await screen.findByText('Found but set aside')
    expect(screen.queryByText('Candidates')).toBeNull()
    expect(screen.getByText('Nobody verified yet')).toBeInTheDocument()
    expect(screen.getByText(/will not present an unverified person as a decision maker/)).toBeInTheDocument()
  })

  it('keeps the contact counters about the shortlist, not everyone seen', async () => {
    // A set-aside person with an email must not be counted as a person we hold
    // an email for: we do not approach them.
    serve({
      ...ASIDE_ONLY,
      candidates: [person({ email: 'someone@example.test' }), person({ id: 'p2', fullName: 'Babaji' })],
    })
    render(<DecisionMakers />)
    await screen.findByText('Found but set aside')
    const label = screen.getByText('With an email')
    expect(label.closest('div')?.textContent).toMatch(/0/)
  })

  it('shows the shortlist as candidates when the run verified somebody', async () => {
    serve({
      ...ASIDE_ONLY,
      shortlistedCount: 1,
      candidates: [
        person({ id: 'p3', fullName: 'Mariella Mizzi', rawTitle: 'General Manager', companyMatch: 'verified', outcome: 'shortlisted', exclusionReason: null }),
        person({}),
      ],
    })
    render(<DecisionMakers />)
    expect(await screen.findByText('Candidates')).toBeInTheDocument()
    const candidates = screen.getByText('Candidates').closest('section')!
    expect(within(candidates).getByText('Mariella Mizzi')).toBeInTheDocument()
    expect(within(candidates).queryByText('Joshua')).toBeNull()
    expect(screen.getByText('Found but set aside')).toBeInTheDocument()
  })
})
