import { env } from '../config/env.js'

// No search provider is wired in Phase 1 — which one to use is still an open
// question (SEARCH_API_PROVIDER is currently only ever "none").
//
// This is honest about that rather than pretending: it returns an explicit
// "unavailable" marker, and the RESEARCH step degrades to page fetches over the
// domains already known from the CRM audience. It does not fail the run, and it
// does not fabricate results. Adding a provider is a new branch here and
// nothing else.

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface SearchResult {
  ok: boolean
  provider: string
  hits: SearchHit[]
  reason?: string
}

export async function webSearch(_query: string): Promise<SearchResult> {
  if (env.SEARCH_API_PROVIDER === 'none') {
    return {
      ok: false,
      provider: 'none',
      hits: [],
      reason:
        'No web search provider is configured (SEARCH_API_PROVIDER=none). Research is running from CRM-known domains only.',
    }
  }
  return { ok: false, provider: env.SEARCH_API_PROVIDER, hits: [], reason: 'Provider not implemented.' }
}
