import { describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from '../lib/theme'
import { Settings } from './Settings'

// CRM Sync moved off the engine rail (2026-09-24). Settings is now where it is
// opened from, so this is the one way in that the interface offers.

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    can: () => true,
    signOut: () => undefined,
    principal: { crmUserId: 'u1', email: 'a@b.test', name: 'A', role: 'admin', permissions: ['view', 'operate'] },
  }),
}))

describe('Settings opens CRM Sync', () => {
  it('offers CRM Sync and takes you to it', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ provider: 'gemini', configured: false, available: false, note: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const user = userEvent.setup()
    rtlRender(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <Routes>
            <Route path="/settings" element={<Settings />} />
            <Route path="/settings/crm-sync" element={<p>crm sync workspace</p>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    )

    expect(screen.getByText('CRM Sync')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /open crm sync/i }))
    expect(await screen.findByText('crm sync workspace')).toBeInTheDocument()
  })
})
