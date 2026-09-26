import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { DecisionMakers, providerStatusLabel, type ProviderRow } from './DecisionMakers'

// "NOBODY VERIFIED" AND "NOBODY ASKED" AND "NOBODY ANSWERED" ARE THREE THINGS.
//
// GET /decision-makers/companies/:id/candidates answers 404 until a discovery
// run has COMPLETED for the company. The screen used to send that 404 into a
// discarded error and render its zero state anyway: an account map, four
// metrics reading 0, and "Nobody verified yet". So in the browser, a company
// nobody had run discovery for was reported as a company the engine had
// searched and found nobody at — and a route that was not answering at all was
// reported the same way again.
//
// Only one of those three is a finding about the company. These pin all three
// apart, and pin that the candidate presentation itself is untouched.

const COMPANY = { crmCompanyId: 'cms7fj3g707ppqj7627lbm0bg', companyName: 'A1 Building Supply', domain: 'a1building.test' }

vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: COMPANY }) }))
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

/** The backend's own sentence for a company discovery has not completed for. */
const NOT_RUN = 'No completed decision-maker discovery run exists for that company yet.'

function serve(status: number, body: unknown, contentType = 'application/json') {
  vi.stubGlobal('fetch', async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': contentType },
    }),
  )
}

const person = {
  id: 'dm-1',
  fullName: 'Mariella Mizzi',
  rawTitle: 'General Manager',
  normalizedTitle: 'general manager',
  roleGroup: 'Executive Sponsor',
  seniority: 'manager',
  companyMatch: 'verified',
  profileUrl: 'https://www.linkedin.com/in/mariella-mizzi',
  location: null,
  email: null,
  phone: null,
  confidence: 'high',
  contactability: 'profile_only',
  outcome: 'shortlisted',
  rank: 1,
}

describe('a company discovery has not run for is not a company with nobody in it', () => {
  it('quotes the API’s own sentence instead of reporting zero people', async () => {
    serve(404, { error: { code: 'not_found', message: NOT_RUN } })
    render(<DecisionMakers />)

    expect(await screen.findByText(NOT_RUN)).toBeInTheDocument()
    // The claim that used to be made here, and the numbers that made it.
    expect(screen.queryByText(/Nobody verified yet/i)).toBeNull()
    expect(screen.queryByText(/Verified people/i), 'a metric reading 0 is a measurement nobody took').toBeNull()
    expect(screen.queryByText(/No people have been verified for this company/i)).toBeNull()
  })

  it('offers the action that would produce them', async () => {
    serve(404, { error: { code: 'not_found', message: NOT_RUN } })
    render(<DecisionMakers />)

    await screen.findByText(NOT_RUN)
    expect(screen.getAllByRole('button', { name: /find decision makers/i }).length).toBeGreaterThan(0)
  })
})

describe('a route that is not answering is reported as a failure', () => {
  it('does not turn a 404 with no application response into an empty result', async () => {
    // A dev proxy, a gateway, or a router that never mounted the endpoint.
    serve(404, '<!doctype html><title>Not Found</title>', 'text/html')
    render(<DecisionMakers />)

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument()
    expect(document.body.textContent).toContain('answered 404 without an application response')
    expect(screen.queryByText(/Nobody verified yet/i)).toBeNull()
    expect(screen.queryByText(/Verified people/i)).toBeNull()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('quotes the backend’s message and status on a server failure', async () => {
    serve(500, { error: { code: 'internal_error', message: 'The candidate store could not be read.' } })
    render(<DecisionMakers />)

    expect(await screen.findByText(/The candidate store could not be read\./)).toBeInTheDocument()
    expect(screen.getByText(/failed with status 500/i)).toBeInTheDocument()
  })
})

describe('a completed run that verified nobody is still a finding', () => {
  it('keeps the zero state for the case it was written for', async () => {
    serve(200, { crmCompanyId: COMPANY.crmCompanyId, candidates: [] })
    render(<DecisionMakers />)

    expect(await screen.findByText(/Nobody verified yet/i)).toBeInTheDocument()
    expect(screen.getByText(/will not invent one/i)).toBeInTheDocument()
    expect(screen.queryByText(NOT_RUN)).toBeNull()
  })
})

describe('the candidate presentation is unchanged', () => {
  it('still shows the person, the role, the match, the confidence and the reference', async () => {
    serve(200, { crmCompanyId: COMPANY.crmCompanyId, candidates: [person] })
    render(<DecisionMakers />)

    expect(await screen.findByText('Mariella Mizzi')).toBeInTheDocument()
    expect(screen.getByText('General Manager')).toBeInTheDocument()
    expect(screen.getByText('Executive Sponsor')).toBeInTheDocument()
    expect(screen.getByText(/high confidence/i)).toBeInTheDocument()
    expect(screen.getByText(/profile only/i)).toBeInTheDocument()
    // No contact detail was stated, and none is invented. The absence is now
    // stated WITH ITS REASON — a fixture that carries no `emailContact` falls
    // back to the plainest form of the same sentence, which is what this
    // capture exercises.
    expect(screen.getByText(/No verified person email found/i)).toBeInTheDocument()
    expect(screen.getByText(/guessed from the name or the domain/i)).toBeInTheDocument()
    expect(screen.getByText(/No phone number recorded/i)).toBeInTheDocument()
    // The affordance is labelled "Reference" for customers now; what matters
    // to this test is that it is still there and still opens.
    expect(screen.getAllByRole('button', { name: /reference/i }).length).toBeGreaterThan(0)
  })
})

// ── WHERE A CONTACT ADDRESS CAME FROM ────────────────────────────────────
//
// "No email address recorded" was printed for four situations that call for
// four different actions, and for one situation where an address genuinely
// existed on the CRM record and the matcher had thrown it away. The screen now
// reads the server's own derivation: the address with its source, or the
// specific reason there is none.
//
// It still shows only what a source stated. None of these tests asserts a
// constructed address, because there is no path that produces one.

describe('an email is shown with the source that stated it', () => {
  const withEmail = {
    ...person,
    fullName: 'Lloyd Robertson',
    rawTitle: 'Managing Director',
    email: 'lloyd@aes-sales.com',
    contactability: 'contactable',
    emailContact: {
      found: true,
      source: 'crm_contacts',
      sourceLabel: 'NXT Sales CRM record',
      note: 'Stated by NXT Sales CRM record and linked to Lloyd Robertson because the address itself names them.',
    },
  }

  it('shows the address, who it belongs to, and where it came from', async () => {
    serve(200, { crmCompanyId: COMPANY.crmCompanyId, candidates: [withEmail] })
    render(<DecisionMakers />)

    expect(await screen.findByText('lloyd@aes-sales.com')).toBeInTheDocument()
    expect(screen.getByText(/linked to Lloyd Robertson/i)).toBeInTheDocument()
    expect(screen.getByText(/source: NXT Sales CRM record/i)).toBeInTheDocument()
  })

  it('makes the address actionable without altering it', async () => {
    serve(200, { crmCompanyId: COMPANY.crmCompanyId, candidates: [withEmail] })
    render(<DecisionMakers />)

    const link = (await screen.findByText('lloyd@aes-sales.com')) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('mailto:lloyd@aes-sales.com')
  })

  it('names Hunter when Hunter is what saw it', async () => {
    serve(200, {
      crmCompanyId: COMPANY.crmCompanyId,
      candidates: [
        {
          ...withEmail,
          email: 'dana.reed@acme.test',
          fullName: 'Dana Reed',
          emailContact: {
            found: true,
            source: 'hunter',
            sourceLabel: 'Hunter (address observed on a public page)',
            note: 'Stated by Hunter.',
          },
        },
      ],
    })
    render(<DecisionMakers />)

    expect(await screen.findByText('dana.reed@acme.test')).toBeInTheDocument()
    expect(screen.getByText(/source: Hunter \(address observed on a public page\)/i)).toBeInTheDocument()
  })
})

// ── THE RUN, NOT ONLY ITS RESULT ─────────────────────────────────────────
//
// The screen used to POST, re-read once, and stop: a search still running, a
// search that failed, and a click that reused a search already in flight all
// looked like nothing had happened.

type Route = { status: number; body: unknown }
function serveRoutes(routes: { latest?: Route; candidates?: Route; discover?: Route }) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const pick = url.includes('/runs/latest')
      ? routes.latest
      : url.includes('/discover')
        ? routes.discover
        : routes.candidates
    const r = pick ?? { status: 404, body: { error: { code: 'not_found', message: NOT_RUN } } }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  status: 'running',
  failureReason: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  completedAt: null,
  ...over,
})

describe('a search in progress or failed is shown as such', () => {
  it('shows a running search and does not offer to start another', async () => {
    serveRoutes({ latest: { status: 200, body: { run: run() } } })
    render(<DecisionMakers />)

    expect(await screen.findByText(/decision-maker search is running/i)).toBeInTheDocument()
    const buttons = await screen.findAllByRole('button', { name: /search in progress/i })
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('shows why the latest search failed', async () => {
    serveRoutes({
      latest: { status: 200, body: { run: run({ status: 'failed', failureReason: 'The search could not be queued: queue down' }) } },
    })
    render(<DecisionMakers />)

    expect(await screen.findByText(/latest decision-maker search failed/i)).toBeInTheDocument()
    expect(screen.getByText(/queue down/)).toBeInTheDocument()
  })

  it('says a search is already running when the click reused one', async () => {
    serveRoutes({
      latest: { status: 200, body: { run: null } },
      discover: { status: 202, body: { runs: [{ id: 'run-9', crmCompanyId: COMPANY.crmCompanyId, reused: true }] } },
    })
    render(<DecisionMakers />)

    const [button] = await screen.findAllByRole('button', { name: /find decision makers/i })
    fireEvent.click(button!)
    expect(await screen.findByText(/already running, so another was not started/i)).toBeInTheDocument()
  })

  it('shows the error when the search could not be started', async () => {
    serveRoutes({
      latest: { status: 200, body: { run: null } },
      discover: { status: 503, body: { error: { code: 'queue_unavailable', message: 'Decision-maker discovery could not be queued.' } } },
    })
    render(<DecisionMakers />)

    const [button] = await screen.findAllByRole('button', { name: /find decision makers/i })
    fireEvent.click(button!)
    expect(await screen.findByText(/could not be started/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/could not be queued\./)).toBeInTheDocument())
  })
})

describe('the counts and designations are honest', () => {
  it('reports people seen from the run, not the length of the shortlist', async () => {
    serveRoutes({
      latest: { status: 200, body: { run: run({ status: 'completed' }) } },
      candidates: {
        status: 200,
        body: { crmCompanyId: COMPANY.crmCompanyId, candidates: [{ ...person, contactRole: 'primary' }], peopleSeen: 7, excludedCount: 6 },
      },
    })
    render(<DecisionMakers />)

    expect(await screen.findByText('Mariella Mizzi')).toBeInTheDocument()
    expect(screen.getByText('People seen')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('Primary contact')).toBeInTheDocument()
  })

  it('says contact details were withheld by policy rather than absent', async () => {
    serveRoutes({
      latest: { status: 200, body: { run: run({ status: 'completed' }) } },
      candidates: {
        status: 200,
        body: { crmCompanyId: COMPANY.crmCompanyId, candidates: [{ ...person, contactability: 'withheld_by_policy' }] },
      },
    })
    render(<DecisionMakers />)

    expect(await screen.findByText(/Contact details are withheld by policy/i)).toBeInTheDocument()
    expect(screen.queryByText(/No contact details are available/i)).toBeNull()
  })
})

describe('provider status labels', () => {
  const row = (over: Partial<ProviderRow>): ProviderRow => ({
    provider: 'apollo',
    status: 'no_results',
    queried: true,
    local: false,
    candidates: 0,
    reason: null,
    metadata: null,
    ...over,
  })

  it('keeps every outcome apart', () => {
    expect(providerStatusLabel(row({ status: 'unauthorized', queried: false })).text).toBe('no credential')
    expect(
      providerStatusLabel(row({ status: 'unauthorized', queried: false, metadata: { credentialValid: true } })).text,
    ).toBe('plan lacks access')
    expect(providerStatusLabel(row({ status: 'unavailable', queried: false })).text).toMatch(/not eligible/)
    expect(providerStatusLabel(row({ status: 'error' })).text).toMatch(/^error/)
    expect(providerStatusLabel(row({ status: 'rate_limited' })).text).toMatch(/rate-limited/)
    expect(providerStatusLabel(row({ status: 'no_results' })).text).toBe('queried — none found')
    expect(providerStatusLabel(row({ provider: 'crm_contacts', status: 'no_results', queried: false, local: true })).text).toBe(
      'checked — none on record',
    )
    expect(providerStatusLabel(row({ status: 'available', candidates: 3 })).text).toBe('3 found')
  })
})

describe('an absent email is explained, not merely reported', () => {
  const withReason = (note: string) => ({
    ...person,
    emailContact: { found: false, source: null, sourceLabel: null, note },
  })

  it('says a shared mailbox was rejected, and names it', async () => {
    serve(200, {
      crmCompanyId: COMPANY.crmCompanyId,
      candidates: [
        withReason(
          'No verified person email. The CRM record holds only shared mailbox(es) — info@1sourcesupply.net — and a shared inbox is never assigned to a person.',
        ),
      ],
    })
    render(<DecisionMakers />)

    expect(await screen.findByText(/shared mailbox\(es\) — info@1sourcesupply.net/i)).toBeInTheDocument()
    expect(screen.getByText(/never assigned to a person/i)).toBeInTheDocument()
  })

  it('distinguishes "names somebody else" from "none on the record"', async () => {
    serve(200, {
      crmCompanyId: COMPANY.crmCompanyId,
      candidates: [
        withReason('No verified person email. The CRM record holds addresses, but none of them names this person.'),
      ],
    })
    render(<DecisionMakers />)

    expect(await screen.findByText(/none of them names this person/i)).toBeInTheDocument()
    expect(screen.queryByText(/shared mailbox/i)).toBeNull()
  })
})
