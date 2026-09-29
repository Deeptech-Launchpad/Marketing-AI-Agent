import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '../lib/theme'
import { OutreachSenderPanel } from './OutreachSenderPanel'

// The shared part of the sender (the company name): set by an admin in
// Settings, read-only for everyone else. The person is always whoever starts
// the outreach — no person's name or email is entered here.

const perms = { value: ['view', 'operate', 'approve', 'admin'] as string[] }
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: (p: string) => perms.value.includes(p) }) }))

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = []
const EMPTY = { sender: { companyName: '', signature: '' }, configured: false }

beforeEach(() => {
  perms.value = ['view', 'operate', 'approve', 'admin']
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null })
    const body = method === 'POST' ? { sender: JSON.parse(String(init.body)), configured: true } : EMPTY
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})

const render = () => rtlRender(<ThemeProvider><OutreachSenderPanel /></ThemeProvider>)

describe('Outreach sender in Settings', () => {
  it('says plainly when no sender is set, and lets an admin save one', async () => {
    render()
    expect(await screen.findByText('Not set')).toBeInTheDocument()
    expect(screen.queryByLabelText(/first name/i)).toBeNull()
    expect(screen.queryByLabelText(/^email$/i)).toBeNull()
    await userEvent.type(screen.getByLabelText(/company name/i), 'AltiusNxt')
    await userEvent.click(screen.getByRole('button', { name: /save sender/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toMatch(/\/outreach\/sequence\/sender$/)
    expect(post.body).toEqual({ companyName: 'AltiusNxt', signature: '' })
  })

  it('is read-only for someone who is not an admin', async () => {
    perms.value = ['view', 'operate']
    render()
    expect(await screen.findByText(/only an administrator can change the sender/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save sender/i })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
