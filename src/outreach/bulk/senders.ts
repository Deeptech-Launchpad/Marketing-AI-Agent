import { randomBytes } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { ImapFlow } from 'imapflow'
import { strictEmail } from './extract.js'
import { smtpTransport, type TransportAccount } from './transport.js'

// IS THIS SMTP ACCOUNT ALLOWED TO SEND AS THIS FROM ADDRESS? (2026-10-08)
//
// The From the customer sees is the address the user set; the account that
// carries the email is set on the server. A From is only used when it is
// shown to be genuine — never by simply writing someone else's address in the
// header:
//
//   1. The account's own address: allowed (the user typed it themselves).
//   2. Another domain that publishes a DMARC policy of quarantine or reject
//      (altiusnxt.com does: p=reject): refused. Receiving servers reject or
//      bin mail claiming that domain unless the domain's own servers sent it,
//      and this account is not one of them.
//   3. Gmail / Google Workspace (smtp.gmail.com): Gmail quietly replaces a
//      From that is not a verified "Send mail as" address of the account with
//      the account's own address. So one check message is sent from the
//      chosen From TO THE ACCOUNT ITSELF, read back over IMAP, and the From
//      Gmail actually used is compared. Rewritten = refused.
//   4. Any other mail server: its send-as permission cannot be read, so only
//      the account's own address is allowed.
//
// A check that cannot complete (DNS or IMAP error) refuses; it never passes.

export interface SenderCheck {
  fromEmail: string
  accountEmail: string
  authorized: boolean
  method: 'is_account' | 'gmail_send_as' | null
  /** In plain words, either way. */
  reason: string
  /** Delivered, but worth knowing (for example "via gmail.com" in some mail programs). */
  warning: string | null
  checkedAt: string
}

export interface DmarcResult {
  policy: 'none' | 'quarantine' | 'reject' | null
  error: string | null
}

export type ProbeResult = { deliveredFrom: string | null } | { error: string }

interface Deps {
  dmarc: (domain: string) => Promise<DmarcResult>
  probe: (account: TransportAccount, from: string) => Promise<ProbeResult>
}

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN'])

export function parseDmarc(records: string[][], subdomain: boolean): DmarcResult | null {
  const rec = records.map((r) => r.join('')).find((r) => /^v=DMARC1\b/i.test(r.trim()))
  if (!rec) return null
  const tag = (k: string) => new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;\\s]+)`, 'i').exec(rec)?.[1]?.toLowerCase()
  const p = (subdomain ? tag('sp') ?? tag('p') : tag('p')) ?? 'none'
  const pct = Number(tag('pct') ?? '100')
  const policy = p === 'reject' || p === 'quarantine' ? p : 'none'
  return { policy: pct === 0 ? 'none' : policy, error: null }
}

/** The domain's DMARC policy (falling back to the organisational domain). */
export async function lookupDmarc(domain: string): Promise<DmarcResult> {
  const labels = domain.toLowerCase().split('.')
  const org = labels.slice(-2).join('.')
  for (const [name, sub] of [[domain, false], ...(org !== domain ? [[org, true] as const] : [])] as Array<[string, boolean]>) {
    try {
      const found = parseDmarc(await dns.resolveTxt(`_dmarc.${name}`), sub)
      if (found) return found
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      if (!NOT_FOUND.has(code)) return { policy: null, error: code || String((err as Error).message) }
    }
  }
  return { policy: null, error: null }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sends one check message from `from` to the account itself and reads back the From Gmail kept. */
export async function gmailSendAsProbe(account: TransportAccount, from: string): Promise<ProbeResult> {
  const token = `chk${randomBytes(6).toString('hex')}`
  try {
    await smtpTransport(account).sendMail({
      from,
      to: account.user,
      subject: `Bulk Email sender check ${token}`,
      text: `Internal check by the Marketing AI Agent: may this account send as ${from}? This message was sent only to this mailbox and can be deleted.`,
      envelope: { from: account.user, to: [account.user] },
    })
  } catch (err) {
    return { error: `the mail server refused the check message (${String((err as Error).message).split('\n')[0]})` }
  }
  const imap = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: account.user, pass: account.pass }, logger: false })
  try {
    await imap.connect()
    const boxes = await imap.list()
    const box = boxes.find((b) => b.specialUse === '\\All')?.path ?? boxes.find((b) => b.specialUse === '\\Sent')?.path ?? 'INBOX'
    for (let attempt = 0; attempt < 10; attempt++) {
      const lock = await imap.getMailboxLock(box)
      try {
        const uids = await imap.search({ gmraw: `subject:${token}` }, { uid: true })
        if (uids && uids.length) {
          const msg = await imap.fetchOne(String(uids[uids.length - 1]), { envelope: true }, { uid: true })
          const addr = msg ? msg.envelope?.from?.[0]?.address : undefined
          return { deliveredFrom: addr ? addr.toLowerCase() : null }
        }
      } finally {
        lock.release()
      }
      await sleep(2000)
    }
    return { error: 'the check message did not appear in the mailbox within 20 seconds' }
  } catch (err) {
    return { error: `the mailbox could not be read over IMAP (${String((err as Error).message).split('\n')[0]}) — IMAP must be on for this account` }
  } finally {
    await imap.logout().catch(() => undefined)
  }
}

let deps: Deps = { dmarc: lookupDmarc, probe: gmailSendAsProbe }

export function setSenderCheckDepsForTests(d: Partial<Deps> | null): void {
  deps = d ? { ...deps, ...d } : { dmarc: lookupDmarc, probe: gmailSendAsProbe }
}

const GMAIL_HOSTS = new Set(['smtp.gmail.com', 'smtp.googlemail.com'])

export async function checkSender(fromInput: string, account: TransportAccount | null, now = new Date()): Promise<SenderCheck> {
  const from = strictEmail(fromInput)
  const acct = account?.user.toLowerCase() ?? ''
  const result = (authorized: boolean, method: SenderCheck['method'], reason: string, warning: string | null = null): SenderCheck => ({
    fromEmail: from ?? fromInput,
    accountEmail: acct,
    authorized,
    method,
    reason,
    warning,
    checkedAt: now.toISOString(),
  })
  if (!from) return result(false, null, `"${fromInput}" is not a valid email address.`)
  if (!account) return result(false, null, 'No SMTP account is configured on the server, so no From address can be checked.')
  if (from === acct) return result(true, 'is_account', `${from} is the sending account itself.`)

  const fromDomain = from.split('@')[1]!
  const acctDomain = acct.split('@')[1]!
  let warning: string | null = null
  if (fromDomain !== acctDomain) {
    const d = await deps.dmarc(fromDomain)
    if (d.error) {
      return result(false, null, `${fromDomain}'s DMARC policy could not be read (${d.error}), so it is not known whether ${acct} may send as ${from}. Nothing is sent from it until the check succeeds — check again.`)
    }
    if (d.policy === 'reject' || d.policy === 'quarantine') {
      return result(
        false,
        null,
        `${fromDomain} publishes a DMARC policy of "${d.policy}": receiving mail servers ${d.policy === 'reject' ? 'reject' : 'put in spam'} email that says it is from @${fromDomain} unless ${fromDomain}'s own mail servers sent it. The sending account ${acct} is not one of them, so ${from} cannot be used with it. To send as ${from}, the server's sending account must be a mailbox on ${fromDomain} (BULK_SMTP_USER and BULK_SMTP_PASS).`,
      )
    }
    warning = `${fromDomain} and the sending account's domain (${acctDomain}) differ; some mail programs show the email as sent "via ${acctDomain}".`
  }

  if (!GMAIL_HOSTS.has(account.host.toLowerCase())) {
    return result(false, null, `The sending account's mail server (${account.host}) cannot be checked automatically for permission to send as ${from}. With it, only ${acct} can be the From address.`)
  }
  const probe = await deps.probe(account, from)
  if ('error' in probe) return result(false, null, `The sender check could not complete: ${probe.error}. Nothing is sent from ${from} until it does.`)
  if (probe.deliveredFrom === from) {
    return result(true, 'gmail_send_as', `Checked: Gmail sends as ${from} — it is a verified "Send mail as" address of the sending account.`, warning)
  }
  return result(
    false,
    null,
    `Gmail did not send as ${from}: it changed the From to ${probe.deliveredFrom ?? 'another address'}, because ${from} is not a verified "Send mail as" address of the sending account. Add and confirm it in that Google account (Gmail → Settings → Accounts → Send mail as), then check again.`,
  )
}
