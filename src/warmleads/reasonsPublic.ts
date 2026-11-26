// WARM LEADS — NOTHING SECRET LEAVES THE SERVER IN A STORED REASON.
//
// An opt-out proposal's evidence line carries a keyed fingerprint of the proposed address (and the id of the key), because the administrator's
// approval is checked against it on the server. They are server-side facts only: they must never reach a browser, a log, or NXT Sales. Every
// place that hands stored evaluation reasons to anything outside this process goes through redactReasons() (pure; no database, no environment).

/** " · fp 0123456789abcdef" and " · key 01234567" as written into an evidence line by proposalLine(). */
const SERVER_ONLY = / · (?:fp [0-9a-f]{16}|key [0-9a-f]{8})/g

/** The evidence text without the server-only parts. */
export function redactEvidence(evidence: string): string {
  return evidence.replace(SERVER_ONLY, '')
}

/** Stored reasons (any shape) with the server-only parts removed from every evidence line. Returns the input untouched when it is not a list. */
export function redactReasons<T>(reasons: T): T {
  if (!Array.isArray(reasons)) return reasons
  return reasons.map((r) => (r && typeof r === 'object' && typeof (r as { evidence?: unknown }).evidence === 'string' ? { ...(r as object), evidence: redactEvidence((r as { evidence: string }).evidence) } : r)) as unknown as T
}

/** An evaluation row with its reasons redacted (used for everything an API returns or NXT Sales receives). */
export function publicEvaluation<E extends { reasons?: unknown }>(e: E): E {
  return 'reasons' in e && e.reasons != null ? { ...e, reasons: redactReasons(e.reasons) } : e
}
