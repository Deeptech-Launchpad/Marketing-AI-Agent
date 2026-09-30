import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '../../lib/theme'
import { AuthProvider } from '../../lib/auth'
import { SignIn } from './SignIn'

// THE SIGN-IN SCREEN — TWO WAYS IN, BOTH REACHABLE.
//
// What matters here is that a person can actually get to each one, that
// creating an account cannot skip the code, and that a refusal reaches the
// screen in the server's own words rather than as "sign in failed".
//
// There is deliberately no third-party sign-in on this screen: it was removed
// until this platform has a domain, and the first test below is what keeps a
// button for it from reappearing by accident.

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | null
}
let calls: Call[] = []

const CAPABILITIES = {
  ready: true,
  reason: null,
  emailSignIn: true,
  mailConfigured: false,
  allowedDomains: ['altiusnxt.com'],
  otpMinutes: 10,
  adminCount: 4,
}

const SIGNED_IN = {
  token: 'a-session-token',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  email: 'newstarter@altiusnxt.com',
  name: 'New Starter',
  pictureUrl: null,
  role: 'operator',
  isAdmin: false,
}

/** Refusals the server can send, keyed by the path that should answer with one. */
let refusals: Record<string, { status: number; code: string; message: string }> = {}
let capabilities: Record<string, unknown> = CAPABILITIES

beforeEach(() => {
  calls = []
  refusals = {}
  capabilities = CAPABILITIES
  localStorage.clear()

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url: path, method, body: init.body ? JSON.parse(String(init.body)) : null })

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

    const refused = Object.entries(refusals).find(([p]) => path.includes(p))
    if (refused) return json({ error: { code: refused[1].code, message: refused[1].message } }, refused[1].status)

    if (path.includes('/auth/capabilities')) return json(capabilities)
    if (path.includes('/auth/register/start')) return json({ message: 'A 10-minute code has been sent.', expiresInMinutes: 10, devCode: '123456' })
    if (path.includes('/auth/forgot/start')) return json({ message: 'If an account exists, a code has been sent.', expiresInMinutes: 10 })
    if (path.includes('/auth/register/verify')) return json(SIGNED_IN, 201)
    if (path.includes('/auth/forgot/verify')) return json(SIGNED_IN)
    if (path.includes('/auth/login')) return json(SIGNED_IN)
    if (path.endsWith('/me')) return json({ email: SIGNED_IN.email, name: SIGNED_IN.name, permissions: ['view', 'operate'], role: 'operator' })
    return json({ error: { code: 'not_found', message: `nothing routes ${path}` } }, 404)
  })
})

const render = () =>
  rtlRender(
    <ThemeProvider>
      <AuthProvider>
        <SignIn />
      </AuthProvider>
    </ThemeProvider>,
  )

const sent = (fragment: string) => calls.find((c) => c.url.includes(fragment))

describe('the sign-in screen', () => {
  it('offers a password, Create account and Forgot password — and no third-party button', async () => {
    render()
    expect(await screen.findByLabelText(/^email$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^create account$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /forgot password/i })).toBeInTheDocument()

    // Nothing offers a sign-in this server cannot perform.
    expect(screen.queryByText(/google/i)).toBeNull()
    for (const b of screen.getAllByRole('button')) expect(b).not.toHaveTextContent(/google/i)
  })

  it('says which addresses may have an account here', async () => {
    render()
    expect(await screen.findByText(/altiusnxt\.com/i)).toBeInTheDocument()
  })

  it('signs in with an email address and password', async () => {
    render()
    await userEvent.type(await screen.findByLabelText(/^email$/i), 'newstarter@altiusnxt.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'correct-horse-9')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    await waitFor(() => expect(sent('/auth/login')).toBeTruthy())
    expect(sent('/auth/login')!.body).toEqual({ email: 'newstarter@altiusnxt.com', password: 'correct-horse-9' })
    // The token is kept, and the session is then re-read from the server rather
    // than assembled from the sign-in response.
    await waitFor(() => expect(sent('/me')).toBeTruthy())
  })

  it('shows the server’s own words when a sign-in is refused', async () => {
    refusals['/auth/login'] = {
      status: 401,
      code: 'unauthorized',
      message: 'That email and password do not match an account here.',
    }
    render()
    await userEvent.type(await screen.findByLabelText(/^email$/i), 'newstarter@altiusnxt.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'wrong-password-1')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password do not match an account here.')
  })

  it('says so plainly when the server cannot accept a sign-in at all', async () => {
    capabilities = { ...CAPABILITIES, ready: false, reason: 'Sign-in is not configured on this server.' }
    render()
    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured on this server/i)
    expect(screen.queryByLabelText(/^password$/i)).toBeNull()
  })

  it('never calls a sign-in endpoint this server does not have', async () => {
    render()
    await userEvent.type(await screen.findByLabelText(/^email$/i), 'newstarter@altiusnxt.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'correct-horse-9')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))
    await waitFor(() => expect(sent('/auth/login')).toBeTruthy())
    expect(calls.every((c) => !c.url.includes('/auth/google'))).toBe(true)
  })
})

describe('creating an account', () => {
  const startRegistration = async () => {
    render()
    await userEvent.click(await screen.findByRole('button', { name: /^create account$/i }))
    await userEvent.type(screen.getByLabelText(/work email/i), 'newstarter@altiusnxt.com')
    await userEvent.click(screen.getByRole('button', { name: /send me a code/i }))
  }

  it('asks for the address first, and a code before any password', async () => {
    render()
    await userEvent.click(await screen.findByRole('button', { name: /^create account$/i }))

    // Nothing about a password yet: the address has to be proved first.
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/choose a password/i)).toBeNull()

    await userEvent.type(screen.getByLabelText(/work email/i), 'newstarter@altiusnxt.com')
    await userEvent.click(screen.getByRole('button', { name: /send me a code/i }))

    await waitFor(() => expect(sent('/auth/register/start')).toBeTruthy())
    expect(sent('/auth/register/start')!.body).toEqual({ email: 'newstarter@altiusnxt.com' })
    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/choose a password/i)).toBeInTheDocument()
  })

  it('creates the account with the code, the password and an optional name', async () => {
    await startRegistration()
    await userEvent.type(await screen.findByLabelText(/verification code/i), '123456')
    await userEvent.type(screen.getByLabelText(/your name/i), 'New Starter')
    await userEvent.type(screen.getByLabelText(/choose a password/i), 'correct-horse-9')
    await userEvent.type(screen.getByLabelText(/type it again/i), 'correct-horse-9')
    await userEvent.click(screen.getByRole('button', { name: /^create account$/i }))

    await waitFor(() => expect(sent('/auth/register/verify')).toBeTruthy())
    expect(sent('/auth/register/verify')!.body).toEqual({
      email: 'newstarter@altiusnxt.com',
      code: '123456',
      password: 'correct-horse-9',
      name: 'New Starter',
    })
  })

  it('will not submit two passwords that differ', async () => {
    await startRegistration()
    await userEvent.type(await screen.findByLabelText(/verification code/i), '123456')
    await userEvent.type(screen.getByLabelText(/choose a password/i), 'correct-horse-9')
    await userEvent.type(screen.getByLabelText(/type it again/i), 'correct-horse-8')

    expect(screen.getByText(/do not match/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^create account$/i })).toBeDisabled()
    expect(sent('/auth/register/verify')).toBeUndefined()
  })

  it('keeps only digits in the code box', async () => {
    await startRegistration()
    const code = await screen.findByLabelText(/verification code/i)
    await userEvent.type(code, '12ab34')
    expect(code).toHaveValue('1234')
  })

  it('shows the development code only when the server returns one', async () => {
    await startRegistration()
    // This server has no mail configured and is in development, so it said so.
    expect(await screen.findByText('123456')).toBeInTheDocument()
  })

  it('reports a refused address in the server’s words, and asks for no password', async () => {
    refusals['/auth/register/start'] = {
      status: 403,
      code: 'forbidden',
      message: 'Accounts here are for altiusnxt.com addresses.',
    }
    render()
    await userEvent.click(await screen.findByRole('button', { name: /^create account$/i }))
    await userEvent.type(screen.getByLabelText(/work email/i), 'someone@gmail.com')
    await userEvent.click(screen.getByRole('button', { name: /send me a code/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Accounts here are for altiusnxt.com addresses.')
    expect(screen.queryByLabelText(/verification code/i)).toBeNull()
  })

  it('reports a wrong code and stays on the same step', async () => {
    await startRegistration()
    refusals['/auth/register/verify'] = {
      status: 400,
      code: 'bad_request',
      message: 'That code is not right. Check the email and try again.',
    }
    await userEvent.type(await screen.findByLabelText(/verification code/i), '000000')
    await userEvent.type(screen.getByLabelText(/choose a password/i), 'correct-horse-9')
    await userEvent.type(screen.getByLabelText(/type it again/i), 'correct-horse-9')
    await userEvent.click(screen.getByRole('button', { name: /^create account$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.')
    expect(screen.getByLabelText(/verification code/i)).toBeInTheDocument()
  })

  it('can go back to sign in', async () => {
    render()
    await userEvent.click(await screen.findByRole('button', { name: /^create account$/i }))
    await userEvent.click(screen.getByRole('button', { name: /back to sign in/i }))
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
  })
})

describe('recovering an account', () => {
  it('sends a code, then sets a new password with it', async () => {
    render()
    await userEvent.click(await screen.findByRole('button', { name: /forgot password/i }))
    await userEvent.type(screen.getByLabelText(/work email/i), 'newstarter@altiusnxt.com')
    await userEvent.click(screen.getByRole('button', { name: /send me a code/i }))

    await waitFor(() => expect(sent('/auth/forgot/start')).toBeTruthy())
    // No name is asked for here: the account already has one.
    expect(screen.queryByLabelText(/your name/i)).toBeNull()

    await userEvent.type(await screen.findByLabelText(/verification code/i), '123456')
    await userEvent.type(screen.getByLabelText(/new password/i), 'a-new-password-7')
    await userEvent.type(screen.getByLabelText(/type it again/i), 'a-new-password-7')
    await userEvent.click(screen.getByRole('button', { name: /set new password/i }))

    await waitFor(() => expect(sent('/auth/forgot/verify')).toBeTruthy())
    expect(sent('/auth/forgot/verify')!.body).toEqual({
      email: 'newstarter@altiusnxt.com',
      code: '123456',
      password: 'a-new-password-7',
    })
  })

  it('passes on the server’s deliberately vague answer without embellishing it', async () => {
    render()
    await userEvent.click(await screen.findByRole('button', { name: /forgot password/i }))
    await userEvent.type(screen.getByLabelText(/work email/i), 'nobody@altiusnxt.com')
    await userEvent.click(screen.getByRole('button', { name: /send me a code/i }))

    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument()
    // And no code is invented for a server that sent none.
    expect(screen.queryByText('123456')).toBeNull()
  })
})
