import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { CompanyProvider, useCompany } from './companyContext'

// The shared register must be re-readable: the context panel showed data from
// before an enrichment run because the register was loaded exactly once.

let registerCalls = 0
let register: unknown[] = []

beforeEach(() => {
  registerCalls = 0
  register = []
  try {
    localStorage.clear()
  } catch {
    /* no storage */
  }
  vi.stubGlobal('fetch', async (url: string) => {
    if (/\/enrichment(\?|$)/.test(String(url))) {
      registerCalls += 1
      return new Response(JSON.stringify({ enrichments: register }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
  })
})

let reload: () => void = () => undefined

function Probe() {
  const c = useCompany()
  reload = c.reload
  const entry = c.companies.find((x) => x.crmCompanyId === 'co_a')
  return (
    <p data-testid="probe">
      {entry ? `${entry.enrichmentStatus ?? 'none'}|${(entry.technologies ?? []).join(',')}|${entry.sourceUrl ?? ''}` : 'absent'}
    </p>
  )
}

describe('CompanyProvider register', () => {
  it('reload() re-reads the register and carries status and technology names', async () => {
    render(
      <CompanyProvider>
        <Probe />
      </CompanyProvider>,
    )
    await waitFor(() => expect(registerCalls).toBe(1))
    expect(screen.getByTestId('probe').textContent).toBe('absent')

    register = [
      {
        id: 'r2',
        crmCompanyId: 'co_a',
        companyName: 'Acme',
        status: 'enriched',
        sourceUrl: 'https://acme.example/',
        technologies: [{ name: 'Shopify' }],
        technologyCount: 1,
        failureReason: null,
        createdAt: '2026-09-02T00:00:00Z',
        finishedAt: null,
      },
      {
        id: 'r1',
        crmCompanyId: 'co_a',
        companyName: 'Acme',
        status: 'unreachable',
        sourceUrl: null,
        technologies: [],
        technologyCount: 0,
        failureReason: 'x',
        createdAt: '2026-09-01T00:00:00Z',
        finishedAt: null,
      },
    ]
    act(() => reload())
    await waitFor(() => expect(registerCalls).toBe(2))
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('enriched|Shopify|https://acme.example/'))
  })
})
