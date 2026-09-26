import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { CommandCentre } from './CommandCentre'
import { Engagement } from './Engagement'
import { IntentScoring } from './IntentScoring'
import { Qualification } from './Qualification'
import { CrmSync } from './CrmSync'
import { WebsiteAudit } from './WebsiteAudit'
import { AuditReport } from './AuditReport'
import { Approval } from './Approval'
import { Workbench } from './Workbench'
import { ContextPanel } from '../components/shell/ContextPanel'

// THE DEMO-PHASE FEATURE LOCK.
//
// Intent Scoring, Sales Qualification and CRM Handoff are withheld from the
// interface for the current phase, and the Engagement screen's aggregate
// Summary with them. The engines are untouched — every policy, calculation,
// queue and endpoint still exists and still runs. What is under test here is
// that the PRESENTATION cannot leak them.
//
// WHY THESE ASSERTIONS ARE SHAPED THE WAY THEY ARE.
//
// "The component does not render the score" is far too weak a promise. A
// screen that still FETCHES a value can leak it through a loading skeleton, an
// error message quoting the response body, a footer completion strip, or
// simply a network tab open on a projector during the demo. So every test
// below serves a FULLY POPULATED response — the real numbers from the
// screenshots: 733 events, 100 of 100 HIGH, a threshold of 70 — and then
// asserts two separate things:
//
//   1. none of those values reaches the document, and
//   2. the endpoint carrying them was never requested at all.
//
// The second is the one that actually holds. If a future edit re-adds a fetch
// "just to decide whether to show the panel", these fail.

const COMPANY = {
  crmCompanyId: 'co-1st-ayd',
  companyName: '1st Ayd',
  sourceUrl: 'https://1stayd.com/',
  technologyCount: 1,
}

vi.mock('../lib/companyContext', () => ({
  useCompany: () => ({ company: COMPANY, companies: [COMPANY], select: () => undefined }),
}))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'Manikandan dtlp', role: 'admin', permissions: ['view', 'operate', 'approve'] },
  }),
}))

const render = (ui: ReactElement, route = '/') =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </ThemeProvider>,
  )

// ── The responses a leak would be built from ──────────────────────────────
//
// Deliberately the REAL values from the screens being locked, so a test that
// passes proves the numbers were withheld rather than merely absent from a
// thin fixture.

const SUMMARY = {
  crmCompanyId: COMPANY.crmCompanyId,
  totalEvents: 752,
  prospectEvents: 19,
  ourEvents: 733,
  systemEvents: 0,
  distinctSessions: 5,
  lastEventAt: '2026-09-04T16:44:42.000Z',
  lastEventAgeHours: 162,
  lastEventFreshness: 'recent',
  channelsObserved: ['email'],
  channelsNotObserved: ['whatsapp', 'linkedin'],
  note: 'These are counts of observed acts.',
}

const BREAKDOWN = {
  crmCompanyId: COMPANY.crmCompanyId,
  score: 100,
  rawScore: 138,
  level: 'HIGH',
  scoreRange: { min: 0, max: 100 },
  clamped: true,
  policyVersion: 'v1-provisional',
  policyStatus: 'provisional',
  calculationVersion: 'calc-1',
  evaluatedAt: '2026-09-04T16:44:28.000Z',
  totals: { counted: 17, setAside: 709 },
  contactability: { status: 'ok' },
  note: 'Rule-based intent score derived from observed engagement.',
  contributions: [],
  setAside: [],
}

const QUALIFICATION = {
  id: 'q-1',
  crmCompanyId: COMPANY.crmCompanyId,
  evaluated: true,
  status: 'qualified_unassigned',
  intentScore: 100,
  threshold: 70,
  aboveThreshold: 30,
  reason: 'The current intent score of 100 meets the configured high-intent threshold of 70.',
  qualificationPolicyVersion: 'sq1-provisional',
  qualificationEngineVersion: 'qual-1',
  scorePolicyVersion: 'v1-provisional',
  scoreCalculationVersion: 'calc-1',
  evaluationCount: 3,
  owner: { name: null, source: 'none', reason: 'No account owner is set in NXT Sales.' },
  whyQualified: { keyObservedActions: [] },
}

const SYNC = {
  syncId: 'sync-1',
  prepared: true,
  state: 'blocked_no_adapter',
  stateLabel: 'Prepared, held',
  mappingVersion: 'map-1',
  payloadVersion: 'pv-1',
  attempts: 2,
  externalKey: 'ext-1',
  provider: { name: 'nxt_sales', status: 'not_configured' },
  owner: { status: 'unassigned' },
  resources: [],
  validation: { ok: true, issues: [] },
  lastAttemptAt: null,
}

/** What GET /crm-sync/providers answers with — a different shape to the record. */
const PROVIDERS = {
  providers: [
    {
      name: 'nxt_sales',
      destination: 'NXT Sales CRM',
      status: 'write_not_supported',
      reason: 'The CRM port exposes no write method.',
      remediation: 'Approve a CRM write adapter and add the write methods to the CRM port.',
      capabilities: { canCreate: false, canUpdate: false, canLookup: true },
    },
  ],
  note: 'Availability is detected, never assumed.',
}

// ── Fixtures for the 4 modules locked in the 2026-09-24 restructure ────────
//
// Same discipline as above: real-shaped values from the Jamesco Trading Ltd
// capture (scripts/demo-capture.ts), not a thin fixture, so a pass proves the
// values were withheld rather than merely never generated.

const AUDIT_RUN = {
  id: 'x16g6j0n4gkcp5fco5jaxd2p',
  crmCompanyId: COMPANY.crmCompanyId,
  companyName: 'Jamesco Trading Ltd',
  startUrl: 'https://jamescotrading.com/',
  status: 'partial',
  pagesFetched: 15,
  productPages: 12,
  categoryPages: 2,
}

const AUDIT_PAGES = {
  pages: [
    { id: 'ppe41zki6iutobp7gesptism', requestedUrl: 'https://jamescotrading.com/shop/', finalUrl: 'https://jamescotrading.com/shop/', outcome: 'fetched', pageType: 'product' },
  ],
}

const AUDIT_FINDINGS = {
  findings: [
    { id: 'f1', title: 'Brand not stated on inspected product pages', metric: '8 of 12 product pages', severity: 'high' },
  ],
}

const AUDIT_COLLATERAL = { status: 'ready', pdfUrl: 'https://altiusnxt.com/reports/wvdn0jg47gortepadnryg6m8.pdf' }

const AUDIT_APPROVAL = {
  auditRunId: AUDIT_RUN.id,
  reportId: 'wvdn0jg47gortepadnryg6m8',
  companyName: 'Jamesco Trading Ltd',
  status: 'approved',
  findingCount: 8,
  reviewer: { crmUserId: 'crm-user-approver', email: 'approver@deeptechskills.com' },
}

const AUDIT_APPROVAL_HISTORY = { events: [{ id: 'ev1', action: 'approved', crmUserId: 'crm-user-approver', at: '2026-09-04T06:42:05.306Z' }] }

const WORKBENCH = {
  id: 'nojdhh7efceg8qqfcym3o53r',
  auditRunId: AUDIT_RUN.id,
  crmCompanyId: COMPANY.crmCompanyId,
  productPageUrl: 'https://jamescotrading.com/shop/',
  status: 'ready',
  theme: { primary: '#a7144c' },
  fields: [{ fieldName: 'title', beforeValue: 'Wire Rope', afterValue: 'Galvanised Wire Rope, 6mm — Jamesco Trading' }],
}

const TIMELINE = {
  events: [
    {
      id: 'ev-1',
      crmCompanyId: COMPANY.crmCompanyId,
      actor: 'altiusnxt',
      eventType: 'outreach_action_blocked',
      channel: 'whatsapp',
      occurredAt: '2026-09-04T16:44:42.000Z',
      freshnessLabel: 'recent',
      source: 'outreach_engine',
      sourceProvider: 'outreach_engine',
      evidence: { what: 'A WhatsApp outreach action was blocked.', where: 'outreach_engine', how: 'Recorded by the outreach engine.', referenceId: 'ref-1' },
    },
  ],
}

/** GET /engagement/companies/:id/understanding — real-shaped, real numbers withheld already at the source. */
const UNDERSTANDING = {
  crmCompanyId: COMPANY.crmCompanyId,
  intentSource: {
    count: 1,
    byCategory: { hiring: 1 },
    signals: [
      { id: 'sig-1', signalType: 'careers_page_role', signalCategory: 'hiring', summary: 'Careers page mentions a Product Data role', sourceUrl: 'https://1stayd.com/careers', detectedAt: '2026-09-04T16:44:28.000Z' },
    ],
  },
  engagement: { level: 'HIGH', policyStatus: 'provisional' },
  qualification: { status: 'qualified_unassigned' },
  disclaimers: [
    'Intent Source, Engagement and Qualification are shown side by side, not combined into one number. Each keeps its own evidence.',
    'The engagement level uses provisional, business-unapproved weights (Task #984). Shown as a level, not a score, for that reason.',
    'Qualification uses a provisional, business-unapproved threshold (Task #985). Shown as a status only.',
  ],
}

/** Every URL the screen asked for, in order. */
let requested: string[] = []

function serve() {
  requested = []
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    requested.push(u)
    const body = /engagement\/.*\/summary/.test(u)
      ? SUMMARY
      : /engagement\/.*\/timeline/.test(u)
        ? TIMELINE
        : /engagement\/.*\/understanding/.test(u)
          ? UNDERSTANDING
          : /intent-score\/.*\/breakdown/.test(u)
          ? BREAKDOWN
          : /intent-score\/.*\/history/.test(u)
            ? { snapshots: [{ snapshotId: 's1', score: 100, evaluatedAt: '2026-09-04T16:44:28.000Z', trigger: 'recalculation', change: null }] }
            : /intent-score\/companies/.test(u)
              ? { scored: true, score: 100, level: 'HIGH' }
              : /sales-qualification\/.*\/history/.test(u)
                ? { transitions: [] }
                : /sales-qualification/.test(u)
                  ? QUALIFICATION
                  : /crm-sync\/providers/.test(u)
                    ? PROVIDERS
                    : /crm-sync/.test(u)
                      ? SYNC
                      : /website-audit\/runs\/[^/]+\/pages/.test(u)
                        ? AUDIT_PAGES
                        : /website-audit\/runs\/[^/]+\/findings/.test(u)
                          ? AUDIT_FINDINGS
                          : /website-audit\/runs\/[^/]+\/collateral/.test(u)
                            ? AUDIT_COLLATERAL
                            : /website-audit\/runs\/[^/]+\/approval\/history/.test(u)
                              ? AUDIT_APPROVAL_HISTORY
                              : /website-audit\/runs\/[^/]+\/approval/.test(u)
                                ? AUDIT_APPROVAL
                                : /website-audit\/runs\/[^/]+\/workbench/.test(u)
                                  ? WORKBENCH
                                  : /website-audit\/runs\/[^/]+$/.test(u)
                                    ? AUDIT_RUN
                                    : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

/** Did any request touch an engine that is locked this phase? */
const lockedCalls = () => requested.filter((u) => /intent-score|sales-qualification/.test(u))

beforeEach(() => {
  serve()
  try { localStorage.clear() } catch { /* no storage */ }
})
afterEach(() => vi.unstubAllGlobals())

// ── 1. ENGAGEMENT ─────────────────────────────────────────────────────────

describe('Engagement shows acts, never an aggregate', () => {
  it('has no Summary panel at all', async () => {
    render(<Engagement />)
    await screen.findByText('Timeline')
    expect(screen.queryByText('Summary')).toBeNull()
    expect(screen.queryByText(/By the prospect/i)).toBeNull()
    expect(screen.queryByText(/By AltiusNXT/i)).toBeNull()
    expect(screen.queryByText(/Infrastructure/i)).toBeNull()
    expect(screen.queryByText(/Distinct visits/i)).toBeNull()
    expect(screen.queryByText(/Last observed/i)).toBeNull()
  })

  it('does not render 733, the count that could not be defended', async () => {
    render(<Engagement />)
    await screen.findByText('Timeline')
    // The whole document, not just one node: a count can arrive split across
    // elements or inside a title attribute.
    expect(document.body.textContent).not.toContain('733')
    expect(document.body.textContent).not.toContain('162h ago')
  })

  it('never asks for the aggregate, so it cannot leak through a loading or error state', async () => {
    render(<Engagement />)
    await screen.findByText('Timeline')
    expect(requested.some((u) => /engagement\/.*\/summary/.test(u))).toBe(false)
    expect(requested.some((u) => /engagement\/.*\/timeline/.test(u))).toBe(true)
  })

  it('still shows each act with its channel, time and reference', async () => {
    render(<Engagement />)
    await screen.findByText('Timeline')
    expect(screen.getByText(/Outreach blocked/i)).toBeInTheDocument()
    expect(screen.getByText('whatsapp')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reference/i })).toBeInTheDocument()
  })

  it('keeps the honest empty state when nothing has been observed', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ events: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    render(<Engagement />)
    expect(await screen.findByText('No prospect engagement observed yet.')).toBeInTheDocument()
  })
})

// ── 2. INTENT SCORING ─────────────────────────────────────────────────────

describe('Intent Scoring is locked', () => {
  it('shows the locked state and nothing else', async () => {
    render(<IntentScoring />)
    expect(await screen.findByTestId('locked-engine')).toBeInTheDocument()
    expect(screen.getByText('Coming in the next phase')).toBeInTheDocument()
    expect(
      screen.getByText('Intent scoring is currently locked while the core pipeline engines are being validated.'),
    ).toBeInTheDocument()
  })

  it('renders no score, level, total or policy value', async () => {
    render(<IntentScoring />)
    await screen.findByTestId('locked-engine')
    const text = document.body.textContent ?? ''
    for (const leak of ['100', '138', 'HIGH', '/100', 'Raw total', 'Counted', 'Set aside', 'v1-provisional', 'Provisional weights', 'How it moved']) {
      expect(text, `"${leak}" must not appear on a locked screen`).not.toContain(leak)
    }
  })

  it('calls no intent-score endpoint', async () => {
    render(<IntentScoring />)
    await screen.findByTestId('locked-engine')
    expect(lockedCalls()).toEqual([])
  })

  it('offers no recalculation, because that would produce the withheld value', async () => {
    render(<IntentScoring />)
    await screen.findByTestId('locked-engine')
    expect(screen.queryByRole('button', { name: /recalculate/i })).toBeNull()
  })
})

// ── 3. SALES QUALIFICATION ────────────────────────────────────────────────

describe('Sales Qualification is locked', () => {
  it('shows the locked state and nothing else', async () => {
    render(<Qualification />)
    expect(await screen.findByTestId('locked-engine')).toBeInTheDocument()
    expect(screen.getByText('Coming in the next phase')).toBeInTheDocument()
    expect(
      screen.getByText('Sales qualification is currently locked while the core pipeline engines are being validated.'),
    ).toBeInTheDocument()
  })

  it('renders no score, threshold, verdict or owner routing', async () => {
    render(<Qualification />)
    await screen.findByTestId('locked-engine')
    const text = document.body.textContent ?? ''
    for (const leak of ['100', '70', 'HIGH-INTENT', 'Qualified', 'Unassigned', 'Threshold', 'Above threshold', 'Decision snapshot', 'sq1-provisional']) {
      expect(text, `"${leak}" must not appear on a locked screen`).not.toContain(leak)
    }
  })

  it('calls no qualification endpoint', async () => {
    render(<Qualification />)
    await screen.findByTestId('locked-engine')
    expect(lockedCalls()).toEqual([])
  })

  it('offers no evaluation, because that would produce the withheld decision', async () => {
    render(<Qualification />)
    await screen.findByTestId('locked-engine')
    expect(screen.queryByRole('button', { name: /evaluate/i })).toBeNull()
  })
})

// ── 4. CRM HANDOFF — UNLOCKED ─────────────────────────────────────────────
//
// The handoff screen is open again: the CRM is to stay in step with this
// platform, so the state of that handoff has to be visible. Intent Score and
// Sales Qualification stay locked, and this screen is held to that — it reads
// the qualification it is downstream of, and reports the handoff, but it does
// not put the withheld SCORE on the page.

describe('CRM handoff is open', () => {
  it('shows the handoff rather than a locked state', async () => {
    render(<CrmSync />)
    expect(await screen.findByText('Handoff')).toBeInTheDocument()
    expect(screen.queryByTestId('locked-engine')).toBeNull()
  })

  it('reads the handoff and the qualification it depends on', async () => {
    render(<CrmSync />)
    await screen.findByText('Handoff')
    expect(requested.some((u) => /crm-sync/.test(u))).toBe(true)
  })

  it('states the handoff record and the provider that would carry it', async () => {
    render(<CrmSync />)
    expect(await screen.findByText('Handoff record')).toBeInTheDocument()
    expect(screen.getByText('Providers')).toBeInTheDocument()
  })

  it('still shows no intent score, which stays locked', async () => {
    render(<CrmSync />)
    await screen.findByText('Handoff')
    expect(requested.some((u) => /intent-score/.test(u))).toBe(false)
    expect(document.body.textContent ?? '').not.toContain('HIGH')
  })
})

// ── 5. THE RIGHT SIDEBAR ──────────────────────────────────────────────────

describe('the shared context panel holds no placeholder for a removed engine', () => {
  it('carries no Intent or Qualification block, and no "coming in the next phase" sentence', async () => {
    render(<ContextPanel />)
    await waitFor(() => expect(screen.getByText('Account')).toBeInTheDocument())
    // Intent Score and Sales Qualification were removed from the interface
    // when Engagement absorbed them, so the panel no longer reserves a slot
    // that says they are coming.
    expect(screen.queryByText('Intent')).toBeNull()
    expect(screen.queryByText('Qualification')).toBeNull()
    expect(screen.queryByText('CRM handoff')).toBeNull()
    expect(screen.queryByText('Coming in the next phase')).toBeNull()
  })

  it('leaks no score, verdict, owner or CRM result', async () => {
    render(<ContextPanel />)
    await waitFor(() => expect(screen.getByText('Account')).toBeInTheDocument())
    const text = document.body.textContent ?? ''
    for (const leak of ['100', 'HIGH', '70', 'Prepared, held', 'Unassigned', '733']) {
      expect(text, `"${leak}" must not appear in the sidebar`).not.toContain(leak)
    }
  })

  it('asks for no locked engine', async () => {
    render(<ContextPanel />)
    await waitFor(() => expect(screen.getByText('Account')).toBeInTheDocument())
    // Same non-vacuity guard as on the board.
    expect(requested.some((u) => /engagement\/.*\/timeline/.test(u))).toBe(true)
    expect(lockedCalls()).toEqual([])
  })

  it('still shows the engagement acts themselves', async () => {
    render(<ContextPanel />)
    expect(await screen.findByText(/Outreach action blocked/i)).toBeInTheDocument()
  })
})

// ── 6. THE COMMAND CENTRE ─────────────────────────────────────────────────
//
// The board is the first screen of the demo. It reported the same values in
// miniature — "100 / 100 · HIGH", "Qualified", "Prepared, held" — which would
// have made the lock on the other four screens pointless.

describe('the Command Centre reports no locked value', () => {
  it('shows the locked sentence only for the one engine still held: the CRM handoff', async () => {
    render(<CommandCentre />)
    await waitFor(() => expect(screen.getByText('Where this company stands')).toBeInTheDocument())
    // Its row on the board only. CRM Sync moved to Settings, so it is no
    // longer a pipeline node, and the two removed engines have no row.
    expect(screen.getAllByText('Coming in the next phase')).toHaveLength(1)
    expect(screen.queryByText('Intent score')).toBeNull()
    expect(screen.queryByText('Qualification')).toBeNull()
  })

  it('renders no score, verdict, sync state or engagement count', async () => {
    render(<CommandCentre />)
    await waitFor(() => expect(screen.getByText('Where this company stands')).toBeInTheDocument())
    const text = document.body.textContent ?? ''
    for (const leak of ['100 / 100', '/ 100 —', 'HIGH', 'Qualified', 'Below threshold', 'Prepared, held', 'Synchronised', '733', '19 prospect acts']) {
      expect(text, `"${leak}" must not appear on the board`).not.toContain(leak)
    }
  })

  it('asks for no locked engine and no engagement aggregate', async () => {
    render(<CommandCentre />)
    await waitFor(() => expect(screen.getByText('Where this company stands')).toBeInTheDocument())
    // Non-vacuity: the board DID make a request, and the recorder saw it. An
    // empty lockedCalls() therefore means "asked for none of them", not
    // "nothing was recorded".
    expect(requested.some((u) => /engagement\/.*\/timeline/.test(u))).toBe(true)
    expect(lockedCalls()).toEqual([])
    expect(requested.some((u) => /engagement\/.*\/summary/.test(u))).toBe(false)
  })
})

// ── 7. WEBSITE AUDIT, AUDIT REPORT, APPROVAL, WORKBENCH ───────────────────
//
// Locked in the 2026-09-24 restructure: the CEO moved the pipeline to
// Gemini-led prospect discovery, Intent Signals and Direct Outreach. Same
// non-negotiable as the three engines above: a locked screen makes NO
// request for the thing it withholds, so a real, fully-populated response
// from each engine's own endpoints (audit run, pages, findings, approval,
// workbench) never has a chance to leak through a loading state, an error,
// or a devtools network tab.

/** Did any request touch a website-audit endpoint? */
const auditCalls = () => requested.filter((u) => /website-audit/.test(u))

describe('Website Audit is locked', () => {
  it('shows the locked state and nothing else', async () => {
    render(<WebsiteAudit />)
    expect(await screen.findByTestId('locked-engine')).toBeInTheDocument()
    expect(screen.getByText('Coming in the next phase')).toBeInTheDocument()
  })

  it('renders no run, page or crawl value', async () => {
    render(<WebsiteAudit />)
    await screen.findByTestId('locked-engine')
    const text = document.body.textContent ?? ''
    // Not "12": every engine page's own header reads "Stage N of 12", which
    // would be a false positive here, not a leak of productPages.
    for (const leak of ['jamescotrading.com', 'partial', 'pagesFetched', '15', 'shop/', 'fetched']) {
      expect(text, `"${leak}" must not appear on a locked screen`).not.toContain(leak)
    }
  })

  it('calls no website-audit endpoint', async () => {
    render(<WebsiteAudit />)
    await screen.findByTestId('locked-engine')
    expect(auditCalls()).toEqual([])
  })

  it('offers no start-crawl action, because that would produce the withheld run', async () => {
    render(<WebsiteAudit />)
    await screen.findByTestId('locked-engine')
    expect(screen.queryByRole('button', { name: /start|crawl|audit/i })).toBeNull()
  })
})

describe('Audit Report is locked', () => {
  it('shows the locked state and nothing else', async () => {
    render(<AuditReport />)
    expect(await screen.findByTestId('locked-engine')).toBeInTheDocument()
    expect(screen.getByText('Coming in the next phase')).toBeInTheDocument()
  })

  it('renders no finding, metric or collateral value', async () => {
    render(<AuditReport />)
    await screen.findByTestId('locked-engine')
    const text = document.body.textContent ?? ''
    for (const leak of ['Brand not stated', '8 of 12', 'jamescotrading.com', AUDIT_COLLATERAL.pdfUrl]) {
      expect(text, `"${leak}" must not appear on a locked screen`).not.toContain(leak)
    }
  })

  it('calls no website-audit endpoint', async () => {
    render(<AuditReport />)
    await screen.findByTestId('locked-engine')
    expect(auditCalls()).toEqual([])
  })

  it('offers no regenerate action, because that would produce the withheld report', async () => {
    render(<AuditReport />)
    await screen.findByTestId('locked-engine')
    expect(screen.queryByRole('button', { name: /generate|regenerate/i })).toBeNull()
  })
})

describe('Human Approval is locked', () => {
  it('shows the locked state and nothing else', async () => {
    render(<Approval />)
    expect(await screen.findByTestId('locked-engine')).toBeInTheDocument()
    expect(screen.getByText('Coming in the next phase')).toBeInTheDocument()
  })

  it('renders no approval status, reviewer or finding count', async () => {
    render(<Approval />)
    await screen.findByTestId('locked-engine')
    const text = document.body.textContent ?? ''
    for (const leak of ['approved', 'approver@deeptechskills.com', 'jamescotrading.com']) {
      expect(text, `"${leak}" must not appear on a locked screen`).not.toContain(leak)
    }
  })

  it('calls no website-audit endpoint', async () => {
    render(<Approval />)
    await screen.findByTestId('locked-engine')
    expect(auditCalls()).toEqual([])
  })

  it('offers no approve or reject action, because that would act on a withheld report', async () => {
    render(<Approval />)
    await screen.findByTestId('locked-engine')
    expect(screen.queryByRole('button', { name: /approve|reject/i })).toBeNull()
  })
})

describe('AI Workbench is locked', () => {
  it('shows the locked state and nothing else', async () => {
    render(<Workbench />)
    expect(await screen.findByTestId('locked-engine')).toBeInTheDocument()
    expect(screen.getByText('Coming in the next phase')).toBeInTheDocument()
  })

  it('renders no demo field, theme colour or product page value', async () => {
    render(<Workbench />)
    await screen.findByTestId('locked-engine')
    const text = document.body.textContent ?? ''
    for (const leak of ['Wire Rope', 'Galvanised Wire Rope', '#a7144c', 'shop/']) {
      expect(text, `"${leak}" must not appear on a locked screen`).not.toContain(leak)
    }
  })

  it('calls no website-audit endpoint', async () => {
    render(<Workbench />)
    await screen.findByTestId('locked-engine')
    expect(auditCalls()).toEqual([])
  })

  it('offers no build action, because that would produce the withheld demo', async () => {
    render(<Workbench />)
    await screen.findByTestId('locked-engine')
    expect(screen.queryByRole('button', { name: /build|rebuild/i })).toBeNull()
  })
})
