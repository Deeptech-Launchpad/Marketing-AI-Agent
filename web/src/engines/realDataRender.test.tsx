import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { runKeyFor } from '../lib/auditLineage'
import captured from '../test/real-responses.json'
import { WebsiteAudit } from './WebsiteAudit'
import { AuditReport } from './AuditReport'
import { Approval } from './Approval'
import { Workbench } from './Workbench'
import { Enrichment } from './Enrichment'
import { IntentSignals } from './IntentSignals'
import { DecisionMakers } from './DecisionMakers'
import { IntentScoring } from './IntentScoring'
import { Qualification } from './Qualification'
import { Outreach } from './Outreach'
import { Engagement } from './Engagement'

// THE MANAGER FLOW, RENDERED AGAINST REAL RESPONSES.
//
// Every response below was captured from the running local backend for Jamesco
// Trading Ltd (scripts/demo-capture.ts) and is replayed verbatim. Nothing here
// is hand-written, which is the whole point: the Website Audit crash survived a
// passing test suite because every fixture had been written from the frontend's
// own types, and so agreed with the frontend rather than with the API.
//
// This is NOT a browser. It cannot see layout, CSS or a real console. What it
// does prove is that each page renders these exact payloads without throwing —
// which is precisely the failure that took the workspace into RouteBoundary.

const DATA = captured as unknown as {
  runId: string
  crmCompanyId: string
  captured: Record<string, { status: number; body: unknown }>
}

const COMPANY = { crmCompanyId: DATA.crmCompanyId, companyName: 'Jamesco Trading Ltd', domain: 'jamescotrading.com' }

vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: COMPANY }) }))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'crm-user-jey', email: 'jey@deeptechskills.com', name: 'Jey', role: 'admin', permissions: ['view', 'operate', 'approve'] },
  }),
}))

const render = (ui: ReactElement) =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

/** Routes a request to the captured response for that endpoint. */
function serveReal() {
  const c = DATA.captured
  // Order matters and the patterns are exact: a loose prefix served the
  // qualification detail payload to the HISTORY endpoint, whose component then
  // read `transitions` off an object that never had it. That was this harness
  // being wrong, not the page — the real /history does return `transitions`.
  const routes: Array<[RegExp, { status: number; body: unknown }]> = [
    [/\/sales-qualification\/companies\/[^/]+\/history/, c.qualificationHistory!],
    [/\/intent-score\/companies\/[^/]+\/history/, c.scoreHistory!],
    [/\/intent-score\/companies\/[^/]+\/breakdown/, c.scoreBreakdown!],
    [/\/engagement\/companies\/[^/]+\/timeline/, c.engagementTimeline!],
    [/\/engagement\/companies\/[^/]+\/summary/, c.engagementSummary!],
    [/\/runs\/[^/]+\/pages/, c.auditPages!],
    [/\/runs\/[^/]+\/findings/, c.auditFindings!],
    [/\/runs\/[^/]+\/approval$/, c.auditApproval!],
    [/\/runs\/[^/]+\/workbench$/, c.workbench!],
    [/\/runs\/[^/]+$/, c.auditRun!],
    [/\/enrichment\/companies\//, c.enrichment!],
    [/\/intent\/companies\/[^/]+\/signals/, c.intentSignals!],
    [/\/decision-makers\/companies\//, c.decisionMakers!],
    [/\/intent-score\/companies\/[^/]+$/, c.intentScore!],
    [/\/sales-qualification\/companies\/[^/]+$/, c.qualification!],
    [/\/crm-sync\/approvals\/pending/, c.crmPending!],
    [/\/outreach/, c.outreachChannels!],
  ]
  vi.stubGlobal('fetch', async (url: string) => {
    for (const [pattern, res] of routes) {
      if (pattern.test(String(url))) {
        return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } })
      }
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no capture for this path' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

/** Anything React would have logged as an uncaught render error. */
let errors: string[] = []
let spy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errors = []
  serveReal()
  try {
    localStorage.clear()
    localStorage.setItem(runKeyFor(DATA.crmCompanyId), DATA.runId)
  } catch { /* no storage */ }
  spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
})

afterEach(() => spy.mockRestore())

const PAGES: Array<[string, ReactElement]> = [
  ['Enrichment', <Enrichment />],
  ['Intent Signals', <IntentSignals />],
  ['Decision Makers', <DecisionMakers />],
  ['Website Audit', <WebsiteAudit />],
  ['Audit Report', <AuditReport />],
  ['Approval', <Approval />],
  ['Workbench', <Workbench />],
  ['Intent Score', <IntentScoring />],
  ['Qualification', <Qualification />],
  ['Outreach', <Outreach />],
  ['Engagement', <Engagement />],
]

describe('every manager-demo page renders real backend data without throwing', () => {
  for (const [name, ui] of PAGES) {
    it(`${name} renders`, async () => {
      const { container } = render(ui)
      // Let the async loads settle, then confirm something actually rendered.
      await waitFor(() => expect(container.innerHTML.length).toBeGreaterThan(200))

      const uncaught = errors.filter(
        (e) => /Cannot read properties of undefined|is not a function|Uncaught|The above error occurred/i.test(e),
      )
      expect(uncaught, `${name} logged a render error:\n${uncaught.join('\n')}`).toEqual([])
    })
  }
})
