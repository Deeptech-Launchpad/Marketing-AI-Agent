import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { AppShell } from '../components/shell/AppShell'
import { UserManual } from './UserManual'
import { MANUAL } from './manual'
import type { Block } from './manualTypes'
import app from '../App.tsx?raw'

// THE USER MANUAL AND THE HELP ICON (2026-10-01).
//
// Two things are checked: that a first-time user can reach the manual and
// move through it, and that it keeps covering everything it was asked to.
// The second matters as much as the first — a manual that quietly loses the
// "Mark as sent" step is worse than none.

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    signOut: () => undefined,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'operator', permissions: ['view', 'operate'] },
  }),
}))
vi.mock('../lib/companyContext', () => ({ useCompany: () => ({ company: null }) }))
vi.mock('../components/shell/ContextPanel', () => ({ ContextPanel: () => null }))

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })
})

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.pathname + l.hash}</output>
}

const renderShell = (path = '/') =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>command centre</p>} />
            <Route path="/help" element={<UserManual />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </ThemeProvider>,
  )

const renderManual = (path = '/help') =>
  rtlRender(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/help" element={<UserManual />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </ThemeProvider>,
  )

/** Every word in a section, for checking what it covers. */
const textOf = (blocks: Block[]) =>
  blocks
    .map((b) => {
      switch (b.kind) {
        case 'steps':
        case 'list':
          return b.items.join(' ')
        case 'terms':
          return b.items.map((t) => `${t.term} ${t.meaning}`).join(' ')
        case 'example':
          return `${b.title ?? ''} ${b.text}`
        default:
          return b.text
      }
    })
    .join(' ')

describe('the Help icon', () => {
  it('is in the top bar and opens the manual', async () => {
    renderShell('/')
    const help = screen.getByRole('link', { name: 'Help' })
    expect(help).toHaveAttribute('href', '/help')
    await userEvent.click(help)
    expect(screen.getByRole('heading', { level: 1, name: 'User Manual' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/help')
  })

  it('names the page "User Manual" in the top bar rather than the home screen', () => {
    renderShell('/help')
    expect(document.querySelector('.topbar__engine')).toHaveTextContent('User Manual')
  })

  it('does not change the left menu', () => {
    renderShell('/')
    expect(within(screen.getByRole('navigation', { name: 'Engines' })).queryByText(/help/i)).toBeNull()
  })

  it('is a real route in the application, not only in this test', () => {
    expect(app).toContain('<Route path="/help" element={<UserManual />} />')
  })
})

describe('reading the manual', () => {
  it('opens on Getting Started, with every part listed in the contents', () => {
    renderManual()
    expect(screen.getByRole('heading', { level: 2, name: 'Getting Started' })).toBeInTheDocument()
    const toc = screen.getByRole('navigation', { name: 'Manual contents' })
    expect(within(toc).getAllByRole('button').map((b) => b.textContent?.replace(/^\d+/, ''))).toEqual(
      MANUAL.map((s) => s.title),
    )
  })

  it('moves to a part from the contents, and records it in the address', async () => {
    renderManual()
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Manual contents' })).getByRole('button', { name: /Outreach/ }))
    expect(screen.getByRole('heading', { level: 2, name: 'Outreach' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/help#outreach')
  })

  it('opens straight on a part from its address', () => {
    renderManual('/help#troubleshooting')
    expect(screen.getByRole('heading', { level: 2, name: 'Troubleshooting' })).toBeInTheDocument()
  })

  it('falls back to the start for an address it does not know', () => {
    renderManual('/help#no-such-part')
    expect(screen.getByRole('heading', { level: 2, name: 'Getting Started' })).toBeInTheDocument()
  })

  it('can be read start to finish with Next', async () => {
    renderManual()
    for (let i = 1; i < MANUAL.length; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`^Next: ${MANUAL[i]!.title}`) }))
      expect(screen.getByRole('heading', { level: 2, name: MANUAL[i]!.title })).toBeInTheDocument()
    }
    // The last part has nowhere further to go.
    expect(screen.queryByRole('button', { name: /^Next:/ })).toBeNull()
  })

  it('goes back one part with the Previous button', async () => {
    renderManual('/help#enrichment')
    await userEvent.click(screen.getByRole('button', { name: /^Prospects$/ }))
    expect(screen.getByRole('heading', { level: 2, name: 'Prospects' })).toBeInTheDocument()
  })

  it('marks where you are', () => {
    renderManual('/help#intent-signals')
    const current = within(screen.getByRole('navigation', { name: 'Manual contents' })).getByRole('button', { current: 'page' })
    expect(current).toHaveTextContent('Intent Signals')
    expect(screen.getByText(`Part 4 of ${MANUAL.length}`)).toBeInTheDocument()
  })
})

describe('what the manual covers', () => {
  it('has the parts that were asked for, in the order of the work', () => {
    expect(MANUAL.map((s) => s.title)).toEqual([
      'Getting Started',
      'Prospects',
      'Enrichment',
      'Intent Signals',
      'Decision Makers',
      'Outreach',
      'Several Companies',
      'Troubleshooting',
    ])
  })

  it('explains each step the same way: what, why, what you enter, what happens, what you get, what next', () => {
    const steps = MANUAL.filter((s) => !['getting-started', 'troubleshooting', 'several-companies'].includes(s.id))
    for (const s of steps) {
      const headings = s.blocks.filter((b) => b.kind === 'heading').map((b) => (b as { text: string }).text)
      expect(headings, s.title).toContain('What it is')
      expect(headings, s.title).toContain('Why we use it')
      expect(headings, s.title).toContain('What to do next')
      expect(headings.some((h) => /What you (enter|get)/.test(h)) || headings.some((h) => /^Step 1/.test(h)), s.title).toBe(true)
    }
  })

  // Every topic named in the request, and the part it must be explained in.
  const TOPICS: Array<[string, RegExp]> = [
    ['prospects', /Search the public web/],
    ['prospects', /no separate drop-down filters/],
    ['prospects', /Our service is needed/],
    ['prospects', /Product page/],
    ['prospects', /Start pipeline for this company/],
    ['enrichment', /Run enrichment/],
    ['intent-signals', /Detect signals/],
    ['decision-makers', /Find decision makers/],
    ['decision-makers', /Company mailbox/],
    ['outreach', /Start outreach/],
    ['outreach', /V1/],
    ['outreach', /Save changes/],
    ['outreach', /Approve/],
    ['outreach', /Open in Gmail/],
    ['outreach', /Other mail app/],
    ['outreach', /Mark as sent/],
    ['outreach', /Day 9–10/],
    ['outreach', /Confirm reading/],
    ['outreach', /Waiting for approval/],
    ['several-companies', /New send/],
    ['several-companies', /Minutes between companies/],
    ['several-companies', /Greeting name/],
    ['several-companies', /Open in Gmail/],
    ['getting-started', /\(i\)/],
    ['getting-started', /Create account/],
  ]
  it.each(TOPICS)('the %s part explains %s', (id, pattern) => {
    const section = MANUAL.find((s) => s.id === id)!
    expect(textOf(section.blocks)).toMatch(pattern)
  })

  it('never tells the reader the application sends customer email', () => {
    const all = MANUAL.map((s) => textOf(s.blocks)).join(' ')
    expect(all).toMatch(/never emails a customer by itself/)
    expect(all).not.toMatch(/the application (will )?send(s)? (the|your) email/i)
  })

  it('gives every part a summary and at least some content', () => {
    for (const s of MANUAL) {
      expect(s.summary.length, s.title).toBeGreaterThan(20)
      expect(s.blocks.length, s.title).toBeGreaterThan(3)
    }
  })
})
