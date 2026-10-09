import { crmBulkRequest } from '../../crm/nxtSales/httpClient.js'

// BULK EMAIL THROUGH NXT SALES (2026-10-09).
//
// With BULK_SEND_VIA=crm, this platform still prepares, reviews, approves and
// times every email; at each email's time it asks NXT Sales to send it
// (POST /api/marketing-bulk/send). NXT Sales sends it through its own Gmail
// send pipeline, as the one sender a CRM admin configured, adds that Gmail
// account's signature and its own open tracking, and records it. Nothing is
// sent from this platform's mailbox, and there is no fallback to it.
//
// Every email carries a stable idempotency key, so asking again (after a
// timeout, a restart, a retry) can never send it twice — NXT Sales answers
// from its record instead.

export interface CrmSender {
  ready: boolean
  problem: string | null
  name: string | null
  fromEmail: string | null
}

export interface CrmSendResult {
  /** sent; failed = NXT Sales refused before sending; unknown = it may or may not have gone. */
  outcome: 'sent' | 'failed' | 'unknown'
  messageId: string | null
  activityId: string | null
  fromEmail: string | null
  tracked: boolean
  error: string | null
}

export interface CrmStatus {
  idempotencyKey: string
  status: 'sending' | 'sent' | 'failed' | 'unknown'
  error: string | null
  sentAt: string | null
  messageId: string | null
  activityId: string | null
  fromEmail: string | null
  tracked: boolean
  openCount: number | null
  firstOpenedAt: string | null
  lastOpenedAt: string | null
}

export interface CrmBulkApi {
  sender(): Promise<CrmSender>
  send(email: { key: string; campaignId: string; recipientId: string; to: string; cc: string[]; subject: string; html: string; text: string }): Promise<CrmSendResult>
  statuses(keys: string[]): Promise<CrmStatus[]>
}

const BASE = '/api/marketing-bulk'
/** NXT Sales waits up to two minutes for its own pipeline; allow a little more. */
const SEND_TIMEOUT_MS = 150_000

/** The idempotency key of one email: its recipient row, which is sent once. */
export const crmKeyOf = (recipientId: string) => `bulk:${recipientId}`

const message = (body: unknown, status: number) => {
  const m = (body as { message?: string; error?: string } | null)?.message ?? (body as { error?: string } | null)?.error
  return m ? String(m) : `NXT Sales answered HTTP ${status}.`
}

const realApi: CrmBulkApi = {
  async sender() {
    try {
      const r = await crmBulkRequest<CrmSender & { message?: string }>('GET', `${BASE}/sender`)
      if (r.status === 200 && r.body) return { ready: Boolean(r.body.ready), problem: r.body.problem ?? null, name: r.body.name ?? null, fromEmail: r.body.fromEmail ?? null }
      return { ready: false, problem: `NXT Sales bulk sending is not available: ${message(r.body, r.status)}`, name: null, fromEmail: null }
    } catch (err) {
      return { ready: false, problem: `NXT Sales could not be reached: ${String((err as Error).message).split('\n')[0]}`, name: null, fromEmail: null }
    }
  },

  async send(e) {
    let r: { status: number; body: (Partial<CrmStatus> & { message?: string }) | null }
    try {
      r = await crmBulkRequest('POST', `${BASE}/send`, { idempotencyKey: e.key, campaignId: e.campaignId, recipientId: e.recipientId, to: e.to, cc: e.cc, subject: e.subject, htmlBody: e.html, text: e.text }, SEND_TIMEOUT_MS)
    } catch (err) {
      // No answer: it may have been sent. Never treated as "not sent".
      return { outcome: 'unknown', messageId: null, activityId: null, fromEmail: null, tracked: false, error: `No answer from NXT Sales (${String((err as Error).message).split('\n')[0]}). The email may or may not have been sent; its status is checked with NXT Sales.` }
    }
    const b = r.body
    const base = { messageId: b?.messageId ?? null, activityId: b?.activityId ?? null, fromEmail: b?.fromEmail ?? null, tracked: Boolean(b?.tracked) }
    if (b?.status === 'sent') return { outcome: 'sent', ...base, error: null }
    if (b?.status === 'failed') return { outcome: 'failed', ...base, error: b.error ?? message(b, r.status) }
    if (b?.status === 'unknown' || b?.status === 'sending') return { outcome: 'unknown', ...base, error: b.error ?? 'NXT Sales has not confirmed this email yet; its status is checked with NXT Sales.' }
    // Refused before anything was claimed or sent (validation, configuration, authorization).
    if (r.status >= 400 && r.status < 500) return { outcome: 'failed', ...base, error: message(b, r.status) }
    return { outcome: 'unknown', ...base, error: `NXT Sales answered HTTP ${r.status}; the email may or may not have been sent. Its status is checked with NXT Sales.` }
  },

  async statuses(keys) {
    if (!keys.length) return []
    const r = await crmBulkRequest<{ results?: CrmStatus[] }>('GET', `${BASE}/status?keys=${keys.map(encodeURIComponent).join(',')}`)
    if (r.status !== 200 || !Array.isArray(r.body?.results)) throw new Error(`NXT Sales status check failed: ${message(r.body, r.status)}`)
    return r.body!.results
  },
}

let override: CrmBulkApi | null = null

export function crmBulk(): CrmBulkApi {
  return override ?? realApi
}

export function setCrmBulkForTests(api: CrmBulkApi | null): void {
  override = api
}
