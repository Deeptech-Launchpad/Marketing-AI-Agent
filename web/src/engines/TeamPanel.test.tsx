import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '../lib/theme'
import { TeamPanel } from './TeamPanel'

// THE ADMIN VIEW OF WHO IS REGISTERED.
//
// It has to answer four questions per person without the reader guessing: the
// address, whether the account is active, how they sign in, and when they were
// last here. And it must not offer admin as something that can be granted from
// a screen — that list lives on the server, and a screen that appeared to
// change it would be lying about where access comes from.

const me = { email: 'manoj@altiusnxt.com' }
vi.mock('../lib/auth', () => ({ useAuth: () => ({ principal: { email: me.email, permissions: ['view', 'admin'] } }) }))

interface Call {
  url: string
  method: string
  body: unknown
}
let calls: Call[] = []
let accounts: Record<string, unknown>[] = []

const account = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'newstarter@altiusnxt.com',
  name: 'New Starter',
  status: 'active',
  emailVerified: true,
  signInMethods: ['password'],
  pictureUrl: null,
  linkedToCrm: false,
  role: 'operator',
  isAdmin: false,
  signInCount: 3,
  lastLoginAt: '2026-09-29T09:15:00.000Z',
  createdAt: '2026-09-20T09:15:00.000Z',
  ...over,
})

beforeEach(() => {
  calls = []
  me.email = 'manoj@altiusnxt.com'
  accounts = [account()]
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null })
    const body = method === 'GET' ? { accounts } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})

const render = () => rtlRender(<ThemeProvider><TeamPanel /></ThemeProvider>)

describe('the registered users panel', () => {
  it('shows the address, the name, how they sign in and when they were last here', async () => {
    render()
    expect(await screen.findByText('New Starter')).toBeInTheDocument()
    expect(screen.getByText('newstarter@altiusnxt.com')).toBeInTheDocument()
    expect(screen.getByText(/password/i)).toBeInTheDocument()
    expect(screen.getByText(/3 times/i)).toBeInTheDocument()
  })

  it('says both ways in when an account has both', async () => {
    accounts = [account({ signInMethods: ['google', 'password'] })]
    render()
    expect(await screen.findByText(/google and password/i)).toBeInTheDocument()
  })

  it('does not pretend somebody has signed in when they have not', async () => {
    accounts = [account({ signInCount: 0, lastLoginAt: null })]
    render()
    expect(await screen.findByText(/has not signed in yet/i)).toBeInTheDocument()
  })

  it('marks a disabled account, and offers to enable it', async () => {
    accounts = [account({ status: 'disabled' })]
    render()
    expect(await screen.findByText('Disabled')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /enable/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toMatch(/\/admin\/accounts\/u1\/status$/)
    expect(patch.body).toEqual({ status: 'active' })
  })

  it('disables an active account through the server, never locally', async () => {
    render()
    await userEvent.click(await screen.findByRole('button', { name: /disable/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'disabled' })
  })

  it('marks an address that has never been proved', async () => {
    accounts = [account({ emailVerified: false })]
    render()
    expect(await screen.findByText('Unverified')).toBeInTheDocument()
  })

  it('offers no way to make somebody an administrator, and says where that list lives', async () => {
    accounts = [account({ email: 'manoj@altiusnxt.com', name: 'Manoj', isAdmin: true, role: 'admin' })]
    render()
    expect(await screen.findByText('Admin')).toBeInTheDocument()
    expect(screen.getByText(/AUTH_ADMIN_EMAILS/)).toBeInTheDocument()

    // An admin has no role selector at all: their role is not this screen's to
    // change, in either direction.
    expect(screen.queryByRole('combobox')).toBeNull()
    for (const option of screen.queryAllByRole('option')) expect(option).not.toHaveTextContent(/admin/i)
  })

  it('will not offer to disable your own account', async () => {
    accounts = [account({ email: 'manoj@altiusnxt.com', isAdmin: true, role: 'admin' })]
    render()
    await screen.findByText('Admin')
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  it('shows an address that was granted a role but has no account as invited', async () => {
    accounts = [account({ id: null, status: 'no_account', signInMethods: [], signInCount: 0, lastLoginAt: null })]
    render()
    expect(await screen.findByText('Invited')).toBeInTheDocument()
    // Nothing to disable: there is no account yet.
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
  })
})
