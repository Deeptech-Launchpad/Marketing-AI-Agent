// Small, pure readings of enrichment rows shared by the Enrichment engine and
// the shared context panel. No React, no requests.

export interface EnrichmentSummaryRow {
  crmCompanyId?: string
  status?: string | null
  technologies?: unknown
  technologyCount?: number | null
  createdAt?: string | null
}

/** Each company's newest row. Order of first appearance is kept. */
export function latestPerCompany<T extends { crmCompanyId: string; createdAt?: string | null }>(rows: T[] | null | undefined): T[] {
  const byCompany = new Map<string, T>()
  for (const r of Array.isArray(rows) ? rows : []) {
    const seen = byCompany.get(r.crmCompanyId)
    if (!seen || (r.createdAt && seen.createdAt && r.createdAt > seen.createdAt)) byCompany.set(r.crmCompanyId, r)
  }
  return [...byCompany.values()]
}

/** The distinct technology names a row carries, in stored order. */
export function technologyNames(technologies: unknown): string[] {
  if (!Array.isArray(technologies)) return []
  const names = technologies
    .map((t) => (t && typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name.trim() : ''))
    .filter(Boolean)
  return [...new Set(names)]
}

/**
 * A run's technologies as a reader would say them: the names, not a count.
 *
 * A bare "1" could not tell "Shopify" from anything else, and a bare "0" could
 * not tell "read and nothing matched" from "never read". So the empty state is
 * chosen by the run's STATUS, and a list is only ever shown for a run that
 * actually read the site.
 */
export function technologySummary(row: EnrichmentSummaryRow | null | undefined, max = 3): string {
  if (!row || !row.status) return 'Not enriched yet'
  const names = technologyNames(row.technologies)
  switch (row.status) {
    case 'queued':
    case 'running':
      return 'Enrichment in progress'
    case 'no_website':
      return 'No website on record'
    case 'unreachable':
      return 'Website unreachable'
    case 'failed':
      return 'Enrichment failed'
    case 'partial':
      return names.length ? listNames(names, max) : 'Not attributed — site redirected elsewhere'
    case 'enriched':
      return names.length ? listNames(names, max) : 'None detected'
    default:
      return names.length ? listNames(names, max) : 'Unknown'
  }
}

function listNames(names: string[], max: number): string {
  const shown = names.slice(0, max).join(', ')
  return names.length > max ? `${shown} +${names.length - max} more` : shown
}
