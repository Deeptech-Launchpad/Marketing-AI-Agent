import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from '../../lib/theme'
import { ENGINES, PIPELINE, SETTINGS_TOOLS, engineForPath, numberWord } from '../../lib/engines'
import { AppShell } from './AppShell'
import app from '../../App.tsx?raw'

// WEBSITE AUDIT, AUDIT REPORT, HUMAN APPROVAL, AI WORKBENCH, INTENT SCORE AND
// SALES QUALIFICATION ARE GONE FROM THE INTERFACE (2026-09-24).
//
// The CEO moved the product to Gemini-led prospecting, Intent Signals and
// Direct Outreach, and asked for those four to be removed. Their screens are
// still in the repository, but nothing mounts them, the rail does not list
// them, and the stages were renumbered so the rail reads 1–7 without a gap.
// The last two were removed because Engagement now presents Intent Source,
// Engagement and Qualification together.

const REMOVED = ['Website Audit', 'Audit Report', 'Approval', 'Workbench', 'Intent Score', 'Qualification']

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    signOut: () => undefined,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate'] },
  }),
}))
vi.mock('../../lib/companyContext', () => ({ useCompany: () => ({ company: null }) }))
// The right-hand context panel makes its own requests and is not what is under test.
vi.mock('./ContextPanel', () => ({ ContextPanel: () => null }))

// The shell collapses its rail below 1180px and jsdom's window is narrower than
// that, which would hide every label and let a "not listed" check pass for the
// wrong reason. A desktop width keeps the rail open.
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })
})

const renderShell = (path = '/') =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>command centre</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  )

describe('the navigation rail', () => {
  it('lists none of the four removed engines', () => {
    renderShell()
    const nav = screen.getByRole('navigation')
    // Non-vacuity: the rail is open and does carry engine labels.
    expect(within(nav).getByText('Outreach')).toBeInTheDocument()
    for (const name of REMOVED) {
      expect(within(nav).queryByText(name), `${name} must not be in the rail`).toBeNull()
    }
  })

  it('still lists every engine that remains, in pipeline order', () => {
    renderShell()
    const nav = screen.getByRole('navigation')
    const labels = ['Prospect', 'Enrichment', 'Intent', 'Decision Makers', 'Outreach', 'Engagement']
    for (const label of labels) expect(within(nav).getByText(label)).toBeInTheDocument()

    const order = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent ?? '')
    const positions = labels.map((l) => order.findIndex((t) => t.includes(l)))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('numbers the rail 1 to 6 without a gap', () => {
    renderShell()
    const badges = [...document.querySelectorAll('.nav__stage')].map((n) => Number(n.textContent))
    expect(badges).toEqual([1, 2, 3, 4, 5, 6])
  })
})

// CRM Sync is a handoff to another system, not a stage a company moves
// through, so it moved off the engine rail to Settings.
describe('CRM Sync lives under Settings', () => {
  it('is not an engine row on the rail', () => {
    renderShell()
    const nav = screen.getByRole('navigation')
    expect(within(nav).getByText('Outreach')).toBeInTheDocument() // the rail is open
    expect(within(nav).queryByText('CRM Sync')).toBeNull()
  })

  it('is not a pipeline node, and has an address under Settings', () => {
    expect(ENGINES.map((e) => e.id)).not.toContain('crm')
    expect(PIPELINE.map((e) => e.id)).not.toContain('crm')
    const crm = SETTINGS_TOOLS.find((t) => t.id === 'crm')
    expect(crm?.path).toBe('/settings/crm-sync')
    // Its workspace keeps its own header.
    expect(engineForPath('/settings/crm-sync')?.title).toBe('CRM / NXT Sales')
  })

  it('is mounted at that address, and the old address still leads there', () => {
    expect(app).toContain('<Route path="/settings/crm-sync" element={<CrmSync />} />')
    expect(app).toContain('<Route path="/crm" element={<Navigate to="/settings/crm-sync" replace />} />')
  })
})

describe('the registry', () => {
  it('has no entry, route or pipeline node for the removed engines', () => {
    const ids = ENGINES.map((e) => e.id)
    for (const id of ['audit', 'report', 'approval', 'workbench', 'scoring', 'qualification']) expect(ids).not.toContain(id)
    for (const p of ['/audit', '/report', '/approval', '/workbench', '/scoring', '/qualification']) {
      expect(ENGINES.map((e) => e.path)).not.toContain(p)
    }
  })

  it('has one pipeline node per engine and unbroken stage numbers', () => {
    expect(PIPELINE.map((e) => e.id)).toEqual(ENGINES.map((e) => e.id))
    expect(ENGINES.map((e) => e.stage)).toEqual(ENGINES.map((_, i) => i + 1))
  })

  it('names how many engines there are from the registry, not from a constant', () => {
    expect(numberWord(ENGINES.length)).toBe('six')
  })
})

describe('the routes', () => {
  // App mounts the screens behind an auth gate, so the real route table is
  // read as text rather than rendered: nothing may mount a removed screen, and
  // an address for one falls through to the catch-all that returns to the
  // command centre.
  it('mounts none of the removed screens', () => {
    for (const name of ['WebsiteAudit', 'AuditReport', 'Approval', 'Workbench', 'IntentScoring', 'Qualification']) {
      expect(app, name).not.toMatch(new RegExp(`<${name}\\b`))
    }
    for (const path of ['/audit', '/report', '/approval', '/workbench', '/scoring', '/qualification']) {
      expect(app, path).not.toContain('path="' + path + '"')
    }
  })

  it('sends any unknown address back to the command centre', () => {
    expect(app).toContain('<Route path="*" element={<Navigate to="/" replace />} />')
  })
})
