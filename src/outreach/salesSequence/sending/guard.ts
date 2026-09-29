// THE TEST-MODE GUARD (2026-09-28).
//
// Every email the platform hands to a mail server passes through here, and
// here only. In this phase there is exactly one way an email can leave:
//
//   OUTREACH_EMAIL_MODE = "test", and EVERY recipient is on the internal
//   test-inbox allow-list (OUTREACH_TEST_RECIPIENTS).
//
// The customer's address is recorded as the intended recipient and shown in
// the subject and a banner, but it is never an addressee. There is no "live"
// mode: the configuration cannot even express one (env.ts), and this guard
// refuses anything that is not "test". Pure functions — no network, no clock.

export type EmailMode = 'off' | 'test'

export interface AllowList {
  addresses: Set<string>
  domains: Set<string>
}

/** "a@x.com, @altiusnxt.com" → exact addresses and whole domains. */
export function parseAllowList(raw: string): AllowList {
  const addresses = new Set<string>()
  const domains = new Set<string>()
  for (const part of raw.split(/[,;\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    if (part.startsWith('@') && part.length > 3 && part.includes('.')) domains.add(part.slice(1))
    else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(part)) addresses.add(part)
  }
  return { addresses, domains }
}

export function isAllowed(email: string | null | undefined, list: AllowList): boolean {
  const e = String(email ?? '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false
  if (list.addresses.has(e)) return true
  const domain = e.split('@')[1]!
  return list.domains.has(domain)
}

export interface GuardConfig {
  mode: EmailMode
  allowList: AllowList
  /** Where scheduled test sends are delivered. */
  testInbox: string | null
}

export type Delivery =
  | { ok: true; to: string[]; subject: string; banner: string }
  | { ok: false; reason: string }

/**
 * Where a test email goes. `requester` is the signed-in person asking for a
 * "Send test to me" preview; scheduled sends have none and go to the test inbox.
 * The customer's address is never returned as an addressee.
 */
export function resolveTestDelivery(input: {
  config: GuardConfig
  intendedRecipient: string | null
  subject: string | null
  requester?: string | null
}): Delivery {
  const { config } = input
  if (config.mode !== 'test') {
    return { ok: false, reason: 'Sending is off (OUTREACH_EMAIL_MODE is not "test"). Nothing was sent.' }
  }
  if (config.allowList.addresses.size === 0 && config.allowList.domains.size === 0) {
    return { ok: false, reason: 'No internal test inboxes are configured (OUTREACH_TEST_RECIPIENTS is empty). Nothing was sent.' }
  }
  const requester = input.requester?.trim().toLowerCase() || null
  const target = requester && isAllowed(requester, config.allowList) ? requester : config.testInbox?.trim().toLowerCase() || null
  if (!target) {
    return {
      ok: false,
      reason: requester
        ? `${requester} is not on the internal test-inbox allow-list, and no test inbox (OUTREACH_TEST_INBOX) is set. Nothing was sent.`
        : 'No test inbox is set (OUTREACH_TEST_INBOX). Nothing was sent.',
    }
  }
  if (!isAllowed(target, config.allowList)) {
    return { ok: false, reason: `The test inbox ${target} is not on the allow-list (OUTREACH_TEST_RECIPIENTS). Nothing was sent.` }
  }
  const intended = input.intendedRecipient?.trim() || 'no recipient on record'
  return {
    ok: true,
    to: [target],
    subject: `[TEST → ${intended}] ${input.subject ?? '(no subject)'}`,
    banner:
      `*** TEST EMAIL — internal only. In real outreach this would go to: ${intended}. ` +
      `The customer was NOT contacted. ***`,
  }
}

/**
 * The last check before a mail server sees anything: every addressee on the
 * allow-list, and the mode still "test". Called by the transport itself, so no
 * caller can skip it.
 */
export function assertDeliverable(to: string[], config: GuardConfig): void {
  if (config.mode !== 'test') throw new Error('Refused: sending is not in test mode.')
  if (to.length === 0) throw new Error('Refused: no addressee.')
  const outside = to.filter((t) => !isAllowed(t, config.allowList))
  if (outside.length) throw new Error(`Refused: ${outside.join(', ')} is not an internal test inbox.`)
}
