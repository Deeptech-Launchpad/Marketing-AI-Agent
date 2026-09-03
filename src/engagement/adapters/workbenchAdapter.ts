import type { Request } from 'express'
import { hashVisit, readCookie, VISIT_COOKIE } from '../../workbench/links.js'
import { recordEvent, type RecordResult } from '../store.js'
import { isPublicEventType, type EngagementEventType, type EventEvidence } from '../types.js'

// TASK #983 — capturing what a visitor did in the PUBLIC Workbench.
//
// THE SECURITY RULE THAT SHAPES THIS FILE
//
// A public client never supplies `crmCompanyId`, `tenantId`, a demo id or an
// audit run id. It presents a link token; the server resolves the token to a
// demo and reads the company from THAT row. Accepting an id from the body would
// let anyone write engagement history into any account by guessing a cuid.
//
// The event type is likewise checked against PUBLIC_EVENT_TYPES, not merely
// against the whitelist: a browser must not be able to record an email bounce
// or a call outcome.
//
// HOW EVENTS ARE OBSERVED, GIVEN THE WORKBENCH HAS NO JAVASCRIPT
//
// Task #981 renders the Workbench with no script at all and a CSP with no
// script-src. That is a deliberate property worth keeping, so engagement here
// is captured from REAL NAVIGATIONS the visitor makes — a page render, a
// redirect through our own server, a link to an expanded view — rather than
// from beacons or pixels.
//
// The honest consequence is that some events only exist when the visitor
// actually navigates. If they read the before/after panels without using the
// focus links, no `workbench_before_viewed` row is written. That is correct:
// this stage records what the server observed, and it did not observe that.

/** Everything the server knows about the visitor, resolved from the token. */
export interface WorkbenchContext {
  tenantId: string
  crmCompanyId: string
  demoId: string
  auditRunId: string | null
  linkId: string
  companyName: string | null
}

/**
 * The visit, as an opaque reference.
 *
 * This reads the anonymous `wb_visit` cookie, NOT the `wb_session` credential.
 * Two reasons:
 *
 *   It exists before registration, so an unregistered visitor's page views
 *   deduplicate against each other rather than against every other stranger who
 *   ever opened the link.
 *
 *   It stays the same across registration, so the acts before and after signing
 *   in belong to one visit instead of appearing as two.
 *
 * Only the hash is stored, so nothing in the events table can be replayed to
 * obtain access — and the value that COULD grant access is never put here.
 */
export function sessionRefFrom(req: Request): string | null {
  const token = readCookie(req.headers.cookie, VISIT_COOKIE)
  return token ? hashVisit(token) : null
}

/**
 * Whether this request arrived from a scanned QR code.
 *
 * The printed QR encodes `?s=qr`, so a scan identifies itself. Without that
 * marker the server knows only that a URL was opened, and this returns false.
 *
 * This is the difference between "someone scanned the code on the report we
 * sent" and "someone opened a link" — a distinction Task #983 requires us not
 * to blur. A pasted URL that happens to carry the marker would be recorded as a
 * scan; that is a known limit of an HTTP-only signal, and it is stated in the
 * evidence rather than hidden.
 */
export function isQrEntry(req: Request): boolean {
  return String(req.query.s ?? '') === 'qr'
}

export interface CaptureInput {
  eventType: EngagementEventType
  context: WorkbenchContext
  req: Request
  /** WHAT was observed, in plain words. */
  what: string
  /** HOW the server observed it. */
  how: string
  referenceKind?: string
  referenceId?: string | null
  where?: string | null
  metadata?: Record<string, unknown>
  /** What distinguishes this act from another of the same type. */
  dedupeDiscriminator?: string | null
}

/**
 * Records one Workbench act.
 *
 * Never throws: a failure to record engagement must not stop a prospect seeing
 * the page they asked for. The caller gets the outcome and decides whether to
 * care; the page renders either way.
 */
export async function captureWorkbenchEvent(input: CaptureInput): Promise<RecordResult> {
  if (!isPublicEventType(input.eventType)) {
    return {
      status: 'rejected',
      eventId: null,
      reason: `"${input.eventType}" cannot be recorded from a public request.`,
    }
  }

  const evidence: EventEvidence = {
    what: input.what,
    where: input.where ?? null,
    how: input.how,
    referenceKind: input.referenceKind ?? 'workbench_demo',
    referenceId: input.referenceId ?? input.context.demoId,
  }

  try {
    return await recordEvent({
      eventType: input.eventType,
      source: 'workbench_app',
      // Resolved server-side, every time. Never read from the request.
      tenantId: input.context.tenantId,
      crmCompanyId: input.context.crmCompanyId,
      workbenchDemoId: input.context.demoId,
      auditRunId: input.context.auditRunId,
      sessionRef: sessionRefFrom(input.req),
      // No `occurredAt` is accepted from a public client at all. The act
      // happened when the server observed it, which is now.
      occurredAt: null,
      evidence,
      metadata: input.metadata,
      dedupeDiscriminator: input.dedupeDiscriminator ?? null,
    })
  } catch {
    // Swallowed deliberately — see the note above. The store already logs.
    return { status: 'rejected', eventId: null, reason: 'The event could not be recorded.' }
  }
}
