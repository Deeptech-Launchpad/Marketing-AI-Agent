// WARM LEADS - the run summary NXT Sales stores (PUT /api/marketing-warm-leads/runs/:id). Pure: no I/O.
//
// NXT Sales reads a fixed set of fields and ignores any other; it has no field for companies held for human review, and it must not be
// changed for this. So those companies are not counted as processed THERE, and its own categories add up:
//   processed = warm + earlySignal + cold + insufficient + existingCustomer + activeOpportunity + doNotContact + failed
// The held count stays visible in the Marketing AI Agent (runCounts / the Warm Leads screen).

export interface RunCounts {
  processed: number
  warm: number
  earlySignal: number
  cold: number
  insufficient: number
  existingCustomer: number
  activeOpportunity: number
  doNotContact: number
  humanReview: number
  failed: number
}

export interface RunRow {
  kind: string
  status: string
  requestedBy: string | null
  total: number
  approvedAt: Date | null
  approvedBy: string | null
  startedAt: Date | null
  finishedAt: Date | null
}

/** The classifications NXT Sales accepts for one company (its CLASSIFICATIONS list). Anything else is refused there with a 400. */
export const NXT_ACCEPTED_CLASSIFICATIONS: readonly string[] = ['warm', 'early_signal', 'cold', 'insufficient_data', 'existing_customer', 'active_opportunity', 'do_not_contact']

/**
 * The last line of defence before a company result is sent to NXT Sales: only a classification NXT accepts (or null for a failed evaluation) may
 * go. `human_review` - and anything added later - is refused here, whatever the caller believed about the company.
 */
export function assertNxtSendable(classification: string | null): void {
  if (classification !== null && !NXT_ACCEPTED_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`The classification "${classification}" is not one NXT Sales accepts, so it is not sent.`)
  }
}

export function runSummaryPayload(run: RunRow, c: RunCounts) {
  return {
    kind: run.kind,
    status: run.status,
    requestedBy: run.requestedBy,
    total: run.total,
    processed: c.processed - c.humanReview,
    warm: c.warm,
    cold: c.cold,
    insufficient: c.insufficient,
    earlySignal: c.earlySignal,
    existingCustomer: c.existingCustomer,
    activeOpportunity: c.activeOpportunity,
    doNotContact: c.doNotContact,
    failed: c.failed,
    approvedAt: run.approvedAt?.toISOString() ?? null,
    approvedBy: run.approvedBy,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }
}
