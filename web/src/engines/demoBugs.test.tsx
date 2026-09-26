import { describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { Outreach } from './Outreach'

// A BUG FOUND IN THE BROWSER, PINNED WITH THE SHAPE THAT CAUSED IT.
//
// This file used to cover three bugs (Website Audit's crash, the Workbench
// 404/409, and this one). The first two engines are now locked (see
// WebsiteAudit.tsx / Workbench.tsx) and their coverage was removed with them.
// What's left is the Outreach case, rewritten twice: for the 2026-09-24 gate,
// and again for the Sales-approved sequence (2026-09-26), whose only gate is a
// shortlisted decision maker and which never sends anything itself.

const COMPANY = { crmCompanyId: 'cmt89cr640rf0s9d3x48vge96', companyName: 'Jamesco Trading Ltd', domain: 'jamescotrading.com' }

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

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = []
const posts = () => calls.filter((c) => c.method === 'POST')

const SENDER = { configured: true, firstName: 'Ada', fullName: 'Ada Lovelace', email: 'ada@altius.test', companyName: 'AltiusNxt', signature: '' }
const FACTS = {
  companyName: COMPANY.companyName,
  companyDomain: COMPANY.domain,
  companySummary: null,
  decisionMaker: { id: 'dm1', fullName: 'Jamie Fox', title: 'Purchasing Manager', email: 'jamie@jamescotrading.com', profileUrl: null },
  product: null,
  signals: [],
  discovered: false,
}
const NOT_STARTED = { crmCompanyId: COMPANY.crmCompanyId, facts: FACTS, gate: { ready: true, reason: null }, sender: SENDER, campaign: null, sequence: null, drafts: [], callPoints: null, replies: [], history: [] }
const NO_DM = {
  ...NOT_STARTED,
  facts: { ...FACTS, decisionMaker: null },
  gate: { ready: false, reason: 'No decision maker has been shortlisted for this company yet. Run Decision Makers first — every approved email is addressed to a named person.' },
}

function stub(routes: Array<[RegExp, { status: number; body: unknown }]>) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null })
    for (const [pattern, res] of routes) {
      if (pattern.test(String(url))) {
        return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } })
      }
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'none' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

// ── THE OUTREACH GATE ───────────────────────────────────────────────────────

describe('Outreach starts only when the backend would accept it', () => {
  it('explains a missing decision maker in the backend\'s words, and posts nothing', async () => {
    stub([
      [/\/outreach\/sequence\/prospects/, { status: 200, body: { prospects: [] } }],
      [/\/outreach\/sequence\/companies\//, { status: 200, body: NO_DM }],
    ])
    render(<Outreach />)

    expect(await screen.findByText(/outreach cannot start yet/i)).toBeInTheDocument()
    expect(screen.getByText(/no decision maker has been shortlisted/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start outreach/i })).toBeNull()
    expect(posts()).toHaveLength(0)
  })

  it('starts the sequence through the sequence endpoint, sending only the company reference', async () => {
    stub([
      [/\/outreach\/sequence\/prospects/, { status: 200, body: { prospects: [] } }],
      [/\/start$/, { status: 201, body: { campaignId: 'c1', created: true } }],
      [/\/outreach\/sequence\/companies\//, { status: 200, body: NOT_STARTED }],
    ])
    render(<Outreach />)

    await userEvent.click(await screen.findByRole('button', { name: /start outreach/i }))
    await waitFor(() => expect(posts().length).toBeGreaterThan(0))

    const call = posts()[0]!
    expect(call.url).toMatch(new RegExp(`/outreach/sequence/companies/${COMPANY.crmCompanyId}/start$`))
    expect(call.body).toEqual({})
    // The legacy endpoints that actually send must never be touched.
    for (const c of calls) {
      expect(c.url).not.toMatch(/\/release$/)
      expect(c.url).not.toMatch(/\/execute$/)
      expect(c.url).not.toMatch(/\/outreach\/campaigns/)
    }
  })

  it('offers no Send control anywhere on the page', async () => {
    stub([
      [/\/outreach\/sequence\/prospects/, { status: 200, body: { prospects: [] } }],
      [/\/outreach\/sequence\/companies\//, { status: 200, body: NOT_STARTED }],
    ])
    render(<Outreach />)
    await screen.findByRole('button', { name: /start outreach/i })
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent ?? '', 'no send control').not.toMatch(/^\s*(send|release|execute)\b/i)
    }
  })
})
