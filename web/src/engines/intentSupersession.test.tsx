import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { IntentSignals } from './IntentSignals'

// A NEGATIVE SIGNAL THAT IS NO LONGER TRUE MUST STOP COUNTING.
//
// Ultra Taps' website loads in 200ms. Its Intent Signals screen showed three
// cards reading "Website unreachable · high confidence · counts against
// outreach", recorded during a spell when the host was resetting connections
// and never withdrawn.
//
// The backend now expires a signal a later run has observed to be false, and
// writes the observation that overtook it onto the row. This screen has to
// honour that in two ways: the red "counts against outreach" chip is for
// ACTIVE evidence only, and the withdrawal is shown rather than left as a bare
// "expired" that tells the reader nothing.
//
// The card is NOT removed. That the site was once unreachable is itself a
// fact, and the history stays readable.

const COMPANY = { crmCompanyId: 'co_ultrataps', companyName: 'Ultra Taps', sourceUrl: 'https://ultratapsmt.com/' }

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

const WITHDRAWAL =
  'The website was read successfully on 2026-09-11 (https://ultratapsmt.com/), so it is no longer unreachable.'

const signal = (over: Record<string, unknown> = {}) => ({
  id: 'sig_1',
  intentRunId: 'run_old',
  signalType: 'website_unreachable',
  signalCategory: 'website',
  summary: 'Company website could not be reached',
  interpretation: 'The site failed to load when checked.',
  evidence: 'https://ultratapsmt.com/ — The site reset the connection.',
  sourceUrl: 'https://ultratapsmt.com/',
  sourceType: 'company_website',
  provider: 'technology',
  confidence: 'high',
  polarity: 'negative',
  status: 'expired',
  freshness: 'aging',
  detectedAt: '2026-09-04T05:10:09.000Z',
  observedAt: '2026-09-04T05:10:06.000Z',
  metadata: { supersededBy: { runId: 'run_new', at: '2026-09-11T06:10:00.000Z', reason: WITHDRAWAL } },
  ...over,
})

function serve(signals: unknown[]) {
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    const body = /\/signals/.test(u)
      ? { crmCompanyId: COMPANY.crmCompanyId, total: signals.length, byCategory: {}, byPolarity: {}, signals }
      : /\/runs/.test(u)
        ? { total: 1, runs: [{ id: 'run_new', crmCompanyId: COMPANY.crmCompanyId, status: 'completed', signalCount: 0, createdAt: '2026-09-11T06:10:00.000Z', completedAt: '2026-09-11T06:10:05.000Z' }] }
        : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* no storage */ }
})
afterEach(() => vi.unstubAllGlobals())

describe('a superseded signal stops counting against the company', () => {
  it('does not chip an expired negative as counting against outreach', async () => {
    serve([signal()])
    render(<IntentSignals />)

    await screen.findByText(/Company website could not be reached/i)
    expect(screen.queryByText(/counts against outreach/i)).toBeNull()
  })

  it('still chips a negative that is genuinely current', async () => {
    serve([signal({ status: 'active', metadata: {} })])
    render(<IntentSignals />)

    await screen.findByText(/Company website could not be reached/i)
    expect(screen.getByText(/counts against outreach/i)).toBeInTheDocument()
  })

  it('says what overtook it, rather than a bare "expired"', async () => {
    serve([signal()])
    render(<IntentSignals />)

    expect(await screen.findByText(WITHDRAWAL)).toBeInTheDocument()
    expect(screen.getByText('expired')).toBeInTheDocument()
  })

  it('keeps the card, because the site really was unreachable then', async () => {
    serve([signal()])
    render(<IntentSignals />)

    // The claim, its date and its evidence all survive the withdrawal.
    expect(await screen.findByText(/Company website could not be reached/i)).toBeInTheDocument()
    expect(document.body.textContent).toContain('2026')
  })

  it('adds no withdrawal note to a signal nothing has superseded', async () => {
    serve([signal({ status: 'active', metadata: {} })])
    render(<IntentSignals />)

    await screen.findByText(/Company website could not be reached/i)
    expect(screen.queryByText(WITHDRAWAL)).toBeNull()
    expect(document.querySelector('.sig__superseded')).toBeNull()
  })
})

// 2026-10-07: a social signal is a recent post, and is titled by what it is
// about — the post's own address and date are the source.
describe('a recent social post', () => {
  it('is titled by what the post is about and links to the post itself', async () => {
    serve([
      signal({
        id: 'sig_post',
        signalType: 'social_activity_product_launch',
        signalCategory: 'catalog',
        summary: 'New product launch — Ultra Taps on Facebook: new mixer tap range. “Our new mixer tap range is in store now.”',
        interpretation: 'New products need complete descriptions, attributes and specifications from day one.',
        outreachAngle: 'Open on the launch, and offer to check that the new product’s pages carry complete specifications.',
        evidence: 'Our new mixer tap range is in store now.',
        sourceUrl: 'https://www.facebook.com/ultrataps/posts/new-range/1234567890123/',
        sourceType: 'social_profile',
        provider: 'social_profiles',
        polarity: 'positive',
        status: 'active',
        freshness: 'fresh',
        confidence: 'medium',
        metadata: {},
      }),
    ])
    render(<IntentSignals />)
    expect(await screen.findByText('New product launch — recent social post')).toBeInTheDocument()
    expect(document.querySelector('a[href="https://www.facebook.com/ultrataps/posts/new-range/1234567890123/"]')).not.toBeNull()
  })
})

