import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmCompany } from '../../src/crm/types.js'

// A FAILED MODEL READ IS NOT "NOBODY ON THE PAGE".
//
// readPeopleFromPage reports a model failure with a reason, and both page
// providers used to ignore it: a site whose every read timed out was recorded
// as "none listed a person alongside a job title" — a claim about the company
// that nobody had actually checked.

vi.mock('../../src/research/pageFetch.js', () => ({
  fetchPageRaw: async (url: string) => ({
    ok: true,
    html: '<html><body><p>Welcome to our company. We supply things.</p></body></html>',
    status: 200,
    bytes: 100,
    finalUrl: url,
    reason: null,
  }),
  fetchPage: async (url: string) => ({ ok: false, reason: 'The site returned HTTP 404.', finalUrl: url }),
}))

let readFails = true
vi.mock('../../src/decisionmakers/modelReader.js', () => ({
  readPeopleFromPage: async () =>
    readFails
      ? { people: [], rejected: 0, reason: 'The model could not read this page: timeout', failed: true, model: null, costUsd: 0 }
      : { people: [], rejected: 0, reason: null, failed: false, model: 'stub', costUsd: 0 },
}))

vi.mock('../../src/research/publicResearch.js', () => ({
  NO_EVIDENCE: 'No additional public evidence found.',
  discoverPublicSources: async () => ({
    status: 'available',
    provider: 'stub',
    queriesRun: ['q'],
    sources: [{ url: 'https://news.test/a', title: 'A' }],
    costUsd: 0,
  }),
  readPublicSources: async () => [
    {
      url: 'https://news.test/a',
      title: 'A',
      finalUrl: 'https://news.test/a',
      text: 'An article about the company that is long enough to read.',
      loginWall: false,
      reason: null,
    },
  ],
}))

const { WebCorroborationProvider } = await import('../../src/decisionmakers/providers/webCorroborationProvider.js')
const { PublicResearchProvider } = await import('../../src/decisionmakers/providers/publicResearchProvider.js')

const company = {
  id: 'co_1',
  name: 'Some Company',
  email: null,
  emails: [],
  phone: null,
  domain: 'some.test',
  contactPersons: [],
  linkedProfiles: [],
} as unknown as CrmCompany

const ctx = { tenantId: 't1', company, companyDomain: 'some.test', maxResults: 10 }

beforeEach(() => {
  readFails = true
})

describe('company website provider', () => {
  it('reports an error, not "no results", when every model read failed and nothing was found', async () => {
    const r = await new WebCorroborationProvider().search(ctx)
    expect(r.status).toBe('error')
    expect(r.reason).toMatch(/model read failed/)
    expect(r.reason).not.toMatch(/none listed a person/)
  })

  it('still reports no results when the reads succeeded and found nobody', async () => {
    readFails = false
    const r = await new WebCorroborationProvider().search(ctx)
    expect(r.status).toBe('no_results')
  })
})

describe('public research provider', () => {
  it('reports an error when every fetched page failed to be read by the model', async () => {
    const r = await new PublicResearchProvider().search(ctx)
    expect(r.status).toBe('error')
    expect(r.reason).toMatch(/could not read any of them/)
    expect((r.metadata as { modelReadFailures: number }).modelReadFailures).toBe(1)
  })

  it('reports no results when the pages were read and named nobody', async () => {
    readFails = false
    const r = await new PublicResearchProvider().search(ctx)
    expect(r.status).toBe('no_results')
  })
})
