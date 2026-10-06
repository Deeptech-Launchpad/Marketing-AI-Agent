import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from './auth'
import { api, getToken, setToken } from './api'

// AN ENDED SESSION RETURNS TO SIGN-IN, ONCE, SAYING WHY (2026-10-06).
//
// After the session's hours ran out, every screen showed its own "Invalid or
// expired session" box and the person stayed inside a half-signed-in app
// until they reloaded. The live log showed 53 such refusals in a week.

let meStatus = 200
beforeEach(() => {
  meStatus = 200
  setToken('a-session-token')
  vi.stubGlobal('fetch', async (url: string) => {
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
    if (String(url).includes('/auth/capabilities')) return json({ ready: true, reason: null, emailSignIn: true, mailConfigured: true, allowedDomains: [], otpMinutes: 10, adminCount: 4 })
    if (String(url).endsWith('/me')) return json({ email: 'a@b.test', name: 'A', role: 'operator', permissions: ['view', 'operate'] }, meStatus)
    if (String(url).includes('/expired-elsewhere')) return json({ error: { code: 'unauthorized', message: 'Invalid or expired session. Sign in again.', requestId: 'r1' } }, 401)
    if (String(url).includes('/not-mine')) return json({ error: { code: 'forbidden', message: 'Requires the "approve" permission; your role is "operator".', requestId: 'r2' } }, 403)
    return json({ ok: true })
  })
})

function Who() {
  const { principal, error } = useAuth()
  return (
    <p>
      {principal ? `signed in as ${principal.email}` : 'signed out'} | {error ?? 'no message'}
    </p>
  )
}

describe('when a session ends mid-use', () => {
  it('signs the person out with one clear message, and forgets the token', async () => {
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>,
    )
    await screen.findByText(/signed in as a@b\.test/)

    await act(async () => {
      await api.get('/engagement/expired-elsewhere').catch(() => undefined)
    })

    await waitFor(() => expect(screen.getByText(/signed out/)).toBeInTheDocument())
    expect(screen.getByText(/Your session has ended — sign in again/)).toBeInTheDocument()
    expect(getToken()).toBeNull()
  })

  it('does not sign anyone out for a permission refusal', async () => {
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>,
    )
    await screen.findByText(/signed in as a@b\.test/)
    await act(async () => {
      await api.get('/not-mine').catch(() => undefined)
    })
    expect(screen.getByText(/signed in as a@b\.test/)).toBeInTheDocument()
    expect(getToken()).toBe('a-session-token')
  })
})
