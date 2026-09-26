import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { runKeyFor } from '../lib/auditLineage'
import { Enrichment } from './Enrichment'
import { IntentSignals } from './IntentSignals'
import { DecisionMakers } from './DecisionMakers'

// EVERY EXECUTABLE ENGINE ACTION, CHECKED AGAINST THE REQUEST IT MAKES.
//
// The Website Audit bug was a request-contract mismatch that no test could see,
// because nothing asserted what the button actually sent. These do, for each
// action added since: the endpoint, the method, and the body shape the backend
// schema accepts. A rename or a singular/plural slip fails here.

const COMPANY = {
  crmCompanyId: 'cmt89cr640rf0s9d3x48vge96',
  companyName: 'Jamesco Trading Ltd',
  domain: 'jamescotrading.com',
}
const RUN_ID = 'run-abc-123'

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

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
const posts = () => calls.filter((c) => c.method === 'POST')

function stubApi() {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({
      url: String(url),
      method,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    })
    if (method === 'POST') {
      return new Response(JSON.stringify({ queued: 1, runs: [{ id: RUN_ID }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // Workbench and Outreach now read the report's approval state before
    // offering their action, so a doomed 409 is never fired. Both are offered
    // only against an APPROVED report, which is what this says.
    if (/\/approval$/.test(String(url))) {
      return new Response(JSON.stringify({ status: 'approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // The Workbench and the Audit Report read the customer story to decide
    // what to render and whether the build may be offered at all.
    if (/customer-view/.test(String(url))) {
      return new Response(
        JSON.stringify({
          crmCompanyId: COMPANY.crmCompanyId,
          auditRunId: RUN_ID,
          companyName: COMPANY.companyName,
          website: `https://${COMPANY.domain}`,
          auditDate: '2026-09-04',
          pagesInspected: 15,
          productPagesInspected: 12,
          categoryPagesInspected: 2,
          reportStatus: 'approved',
          approved: true,
          headline: 'Product Data Health Check',
          summary: '',
          scopeNote: '',
          businessValue: [],
          nextStep: '',
          ctaLabel: 'Book a 15-minute walkthrough',
          priorities: { high: 1, medium: 0, low: 0 },
          gaps: [],
          caseStudies: [],
          sectors: { sectors: [], productPagesInspected: 12, catalogueGaps: [], note: '' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // Reads answer 404, which is what these endpoints genuinely return before
    // anything has been produced. Handing back a half-shaped object instead
    // makes a page crash on a field the real API would never have omitted.
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'none yet' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

beforeEach(() => {
  stubApi()
  try { localStorage.setItem(runKeyFor(COMPANY.crmCompanyId), RUN_ID) } catch { /* no storage */ }
})

const click = async (name: RegExp) => {
  const btns = await screen.findAllByRole('button', { name })
  await userEvent.click(btns[0]!)
}

describe('batch engines send the plural array the schema accepts', () => {
  const cases: Array<[string, ReactElement, RegExp, string]> = [
    ['Enrichment', <Enrichment />, /run enrichment/i, '/enrichment/companies'],
    ['Intent Signals', <IntentSignals />, /detect signals/i, '/intent/detect'],
    ['Decision Makers', <DecisionMakers />, /find decision makers/i, '/decision-makers/discover'],
  ]

  for (const [label, ui, button, endpoint] of cases) {
    it(`${label} posts crmCompanyIds to ${endpoint}`, async () => {
      render(ui)
      await click(button)
      await waitFor(() => expect(posts().length).toBeGreaterThan(0))

      const call = posts().find((c) => c.url.includes(endpoint))
      expect(call, `${label} must call ${endpoint}`).toBeTruthy()
      expect(call!.body).toEqual({ crmCompanyIds: [COMPANY.crmCompanyId] })
      // The singular form is what the API rejects; it must never reappear.
      expect(Object.keys(call!.body!)).not.toContain('crmCompanyId')
    })
  }
})

describe('the UI never invents data or sends more than a reference', () => {
  it('sends no company name, domain, score or status with any action', async () => {
    for (const ui of [<Enrichment />, <IntentSignals />, <DecisionMakers />]) {
      stubApi()
      const { unmount } = render(ui)
      const btns = await screen.findAllByRole('button')
      const primary = btns.find((b) => /run enrichment|detect signals|find decision makers/i.test(b.textContent ?? ''))
      if (primary) await userEvent.click(primary)
      await waitFor(() => expect(posts().length).toBeGreaterThan(0))

      const sent = JSON.stringify(posts().map((p) => p.body))
      for (const forbidden of [COMPANY.companyName, COMPANY.domain, 'intentScore', 'qualificationStatus', 'score', 'status', 'ownerId']) {
        expect(sent, forbidden).not.toContain(forbidden)
      }
      unmount()
    }
  })

  it('issues no send, and no CRM write, from any engine action', async () => {
    for (const ui of [<Enrichment />, <IntentSignals />, <DecisionMakers />]) {
      stubApi()
      const { unmount } = render(ui)
      const btns = screen.queryAllByRole('button')
      for (const b of btns) await userEvent.click(b)
      await waitFor(() => expect(calls.length).toBeGreaterThan(0))

      for (const c of calls) {
        expect(c.method, 'no destructive verb').not.toBe('DELETE')
        expect(c.method).not.toBe('PUT')
        expect(c.url, 'no outreach send endpoint').not.toMatch(/\/outreach\/.*\/(send|dispatch)/)
        expect(c.url, 'no CRM approve endpoint fired incidentally').not.toMatch(/\/crm-sync\/approvals\/.*\/(approve|reject)/)
      }
      unmount()
    }
  })

  it('does not fire a duplicate run while one is in flight', async () => {
    const gate: { release?: () => void } = {}
    calls = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null })
      if (method === 'POST') await new Promise<void>((r) => { gate.release = r })
      return new Response(JSON.stringify({ queued: 1, runs: [{ id: RUN_ID }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    render(<Enrichment />)
    const btns = await screen.findAllByRole('button', { name: /run enrichment/i })
    await userEvent.click(btns[0]!)
    await waitFor(() => expect(posts()).toHaveLength(1))
    await userEvent.click(btns[0]!)
    expect(posts(), 'a second click while running must not dispatch').toHaveLength(1)
    gate.release?.()
  })
})
