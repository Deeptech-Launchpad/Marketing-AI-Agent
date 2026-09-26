// AUDIT LINEAGE — one company's evidence, never another's.
//
// THE BUG THIS EXISTS TO PREVENT
//
// Website Audit, Audit Report and AI Workbench each opened "the most recent
// audit run", remembered under a single global localStorage key:
//
//   altiusnxt.marketing.recentAuditRun
//
// One key, no company in it. Neither the Audit Report nor the Workbench read
// the selected company at all. So auditing company A and then selecting
// company B left both screens showing A's report, A's findings, A's product
// pages and A's URLs, under B's name in the header — a customer looking at
// another customer's data.
//
// Two things fix it, and both are needed:
//
//   1. The remembered run is scoped PER COMPANY, so switching companies cannot
//      carry a run across.
//   2. Every loaded resource is checked against the selected company before it
//      renders. A run id can also arrive in the URL, where nothing stops it
//      naming another company's run — so the memory fix alone is not enough.
//      Validation is what makes the guarantee hold.
//
// On mismatch the screen renders NOTHING of the foreign record. Not a partial
// view, not a name swapped out: a stated mismatch, because quietly showing the
// wrong customer's data is the failure being prevented.

const RUN_KEY_PREFIX = 'altiusnxt.marketing.recentAuditRun'

/** The remembered run for ONE company. */
export function runKeyFor(crmCompanyId: string): string {
  return `${RUN_KEY_PREFIX}:${crmCompanyId}`
}

export function rememberRun(crmCompanyId: string, runId: string): void {
  try {
    localStorage.setItem(runKeyFor(crmCompanyId), runId)
  } catch {
    /* storage blocked: the run is still usable via the URL for this visit */
  }
}

export function recalledRun(crmCompanyId: string | null | undefined): string | null {
  if (!crmCompanyId) return null
  try {
    return localStorage.getItem(runKeyFor(crmCompanyId))
  } catch {
    return null
  }
}

/**
 * The run this screen should open for the selected company.
 *
 * A `?run=` parameter still wins — it is how a colleague shares a specific run —
 * but whatever it names is validated against the selected company before
 * anything is drawn.
 */
export function resolveRunId(params: URLSearchParams, crmCompanyId: string | null | undefined): string | null {
  return params.get('run') ?? recalledRun(crmCompanyId)
}

/** One row of GET /website-audit/companies/:crmCompanyId/runs. */
export interface CompanyRunRow {
  id: string
  crmCompanyId: string
  companyName: string | null
  startUrl: string | null
  status: string
  pagesFetched: number
  productPages: number
  categoryPages: number
  failureReason?: string | null
  createdAt: string
  completedAt?: string | null
}

export interface CompanyRuns {
  crmCompanyId: string
  total: number
  /** The newest run that actually inspected pages, or null. */
  latestUsableRunId: string | null
  runs: CompanyRunRow[]
}

/**
 * The run a screen should open, for a company selected in Shared Context.
 *
 * `resolveRunId` alone answers from the URL or from THIS browser's memory, and
 * neither exists for a company someone has merely selected — so a company with
 * three completed audits and an approved report read "No audit run open",
 * which is what "never audited" looks like. This adds the third source: the
 * company's own runs, from the server.
 *
 * Order matters. `?run=` wins because it is how a specific run is shared; the
 * remembered run comes next because it is the one this operator was last
 * working on; the server's latest USABLE run is the fallback. "Usable" is the
 * server's judgement — a run that inspected at least one page — so this can
 * never open a queued or zero-page run and let a zero-valued report be drawn
 * from it.
 */
export function resolveRunIdWithFallback(
  params: URLSearchParams,
  crmCompanyId: string | null | undefined,
  fetched: CompanyRuns | null,
): string | null {
  const direct = resolveRunId(params, crmCompanyId)
  if (direct) return direct
  // Only ever the company asked about: a payload naming another company is a
  // lineage failure, and opening its run is the exact bug this file exists to
  // prevent.
  if (!fetched || !crmCompanyId || fetched.crmCompanyId !== crmCompanyId) return null
  return fetched.latestUsableRunId
}

/** Anything the backend returns that says which company it belongs to. */
export interface CompanyScoped {
  crmCompanyId?: string | null
}

export type LineageResult =
  | { ok: true }
  | { ok: false; expected: string; found: string | null; what: string }

/**
 * Confirms a loaded resource belongs to the selected company.
 *
 * `null` data is fine — nothing loaded is not a mismatch. A resource that has
 * loaded and names a DIFFERENT company is the failure this catches.
 */
export function checkLineage(
  what: string,
  resource: CompanyScoped | null | undefined,
  selectedCompanyId: string | null | undefined,
): LineageResult {
  if (!resource || !selectedCompanyId) return { ok: true }
  const found = resource.crmCompanyId ?? null
  if (found === null) return { ok: true } // the endpoint does not carry it
  if (found === selectedCompanyId) return { ok: true }
  return { ok: false, expected: selectedCompanyId, found, what }
}

/** The first mismatch among several resources, so a screen can refuse as a whole. */
export function firstMismatch(...results: LineageResult[]): LineageResult | null {
  for (const r of results) if (!r.ok) return r
  return null
}

/**
 * Every row of a collection must belong to the selected company too.
 *
 * A run can be right while a row is not — findings and inspected pages each
 * carry their own company id, and this is what stops one foreign row being
 * drawn inside an otherwise correct report.
 */
export function checkRowLineage(
  what: string,
  rows: CompanyScoped[] | null | undefined,
  selectedCompanyId: string | null | undefined,
): LineageResult {
  if (!rows?.length || !selectedCompanyId) return { ok: true }
  for (const row of rows) {
    const r = checkLineage(what, row, selectedCompanyId)
    if (!r.ok) return r
  }
  return { ok: true }
}
