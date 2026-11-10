import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// EXPLICIT MARKETING OPT-OUTS (owner decisions of 2026-11-05 and 2026-11-06):
//   - buying intent and permission to contact are separate;
//   - only a STRICT, STANDALONE, individual opt-out is ever recorded: one unambiguous sender address, never a domain or a company;
//   - everything else that looks like an opt-out is held for a person - with NO suppression write;
//   - the switch WARM_LEADS_RECORD_OPT_OUTS is OFF (dry run) until the owner approves; a person removes rows, automation never does.
// The database is replaced by a recording stand-in: nothing here touches any real suppression list.

const db = vi.hoisted(() => ({
  creates: [] as Array<Record<string, any>>,
  audits: [] as Array<Record<string, any>>,
  finds: [] as Array<Record<string, any>>,
  raw: [] as Array<{ sql: string; values: unknown[] }>,
  rawRows: [] as Array<{ matchValue: string; source: string; reason: string }>,
  existing: new Map<string, { expiresAt: Date | null }>(),
  failFor: new Set<string>(),
  failAudit: false,
  transactions: 0,
  race: null as null | { row: { expiresAt: Date | null } | 'gone' },
  others: [] as string[],
}))
vi.mock('../../src/platform/db.js', () => {
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      db.raw.push({ sql: strings.join('?'), values })
      return db.rawRows
    },
    // a stand-in transaction: if the callback throws, everything it wrote is undone - as the real database does
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      db.transactions++
      const creates = db.creates.length
      const audits = db.audits.length
      try {
        return await fn(prisma)
      } catch (err) {
        db.creates.length = creates
        db.audits.length = audits
        throw err
      }
    },
    auditEvent: {
      create: async (a: Record<string, any>) => {
        if (db.failAudit) throw new Error('audit insert failed')
        db.audits.push(a.data)
      },
    },
    suppressionEntry: {
      findUnique: async (a: Record<string, any>) => {
        db.finds.push(a)
        const key = a.where.tenantId_scope_matchType_matchValue.matchValue as string
        if (db.failFor.has(key)) throw new Error(`connection lost while reading ${key}`)
        return db.existing.get(key) ?? null
      },
      createMany: async (a: { data: Array<Record<string, any>> }) => {
        for (const d of a.data) if (db.failFor.has(d.matchValue)) throw new Error(`P1001 for ${d.matchValue}`)
        if (db.race) {
          // another writer inserted this address between our read and our insert: skipDuplicates does nothing and reports count 0
          if (db.race.row !== 'gone') db.existing.set(a.data[0]!.matchValue, db.race.row)
          db.race = null
          return { count: 0 }
        }
        db.creates.push(...a.data)
        return { count: a.data.length }
      },
      upsert: async () => void db.others.push('upsert'),
      create: async () => void db.others.push('create'),
      update: async () => void db.others.push('update'),
      updateMany: async () => void db.others.push('updateMany'),
      delete: async () => void db.others.push('delete'),
      deleteMany: async () => void db.others.push('deleteMany'),
    },
  }
  return { newId: () => 'id-1', prisma }
})

import { env } from '../../src/config/env.js'
import { ACTIVITY_ADDRESSES_MAX } from '../../src/crm/types.js'
import { lookupAddresses, parseAddresses, toActivity } from '../../src/crm/nxtSales/mappers.js'
import { addressFingerprint, candidateAddresses, fingerprintKeyConfigured, fingerprintKeyId, isIndividualOptOutRow, maskAddress, normaliseDomains, optOutSignals, persistedOptOuts, proposeOptOuts, signalsToReasons, trustedOwnDomains, writeApprovedOptOut } from '../../src/warmleads/optOut.js'
import { itemsFromReasons, latestPerSource } from '../../src/warmleads/optOutReview.js'
import { redactReasons } from '../../src/warmleads/reasonsPublic.js'
import { affirmsMarketingConsent, assessReply, engagementSignal, isStandaloneOptOut, summariseInbound } from '../../src/warmleads/replies.js'
import { LISTED_IN_CRM, DEFINITIVE, syncAction } from '../../src/warmleads/companyState.js'
import { assertNxtSendable, NXT_ACCEPTED_CLASSIFICATIONS, runSummaryPayload } from '../../src/warmleads/runSummary.js'
import { classify, type EvaluationInput, type ObservedSignal } from '../../src/warmleads/score.js'

// Server-side settings the opt-out code needs (test values only): the dedicated fingerprint key, and which domains are OURS.
env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
env.WARM_LEADS_OWN_DOMAINS = 'ours.example'

const NOW = new Date('2026-11-01T00:00:00Z')
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
interface Opts { from?: string | null; matched?: string; mailbox?: string | null; user?: string; to?: string | null; subject?: string; daysAgo?: number; direction?: string; id?: string }
/** A message as NXT Sales returns it, through the real mapper. */
const mail = (body: string, o: Opts = {}) =>
  toActivity(
    {
      id: o.id ?? `act_${Math.random().toString(36).slice(2, 8)}`,
      type: 'email',
      companyId: 'c1',
      subject: o.subject ?? 'Re: Product data proposal',
      direction: o.direction ?? 'inbound',
      createdAt: day(o.daysAgo ?? 3),
      body,
      fromEmail: o.from === undefined ? 'Ravi Kumar <Ravi@Acme.example>' : o.from,
      matchedCompanyEmail: o.matched ?? 'ravi@acme.example',
      mailboxEmail: o.mailbox === undefined ? 'sales@ours.example' : o.mailbox,
      toEmail: o.to === undefined ? 'sales@ours.example' : o.to,
      user: { email: o.user ?? 'rep@ours.example' },
    },
    true,
    NOW,
  )
const assess = (activities: ReturnType<typeof mail>[]) => summariseInbound(activities, NOW, undefined, true).assessed
const propose = (activities: ReturnType<typeof mail>[], record = false) => proposeOptOuts(assess(activities), record)
const OPT = 'UNSUBSCRIBE' // the strictest form

beforeEach(() => {
  db.creates.length = 0
  db.audits.length = 0
  db.failAudit = false
  db.transactions = 0
  db.race = null
  db.finds.length = 0
  db.raw.length = 0
  db.rawRows = []
  db.existing.clear()
  db.failFor.clear()
  db.others.length = 0
  env.WARM_LEADS_RECORD_OPT_OUTS = false
})

describe('address parsing: whole tokens only, never a different valid-looking address', () => {
  it('reads bare, lower-case addresses out of the raw Gmail header', () => {
    expect(parseAddresses('Ravi Kumar <Ravi@Acme.example>')).toEqual(['ravi@acme.example'])
    expect(parseAddresses('a@b.com')).toEqual(['a@b.com'])
    expect(parseAddresses('"Kumar, Ravi" <R.K+news@Sub.Acme.CO.IN>')).toEqual(['r.k+news@sub.acme.co.in'])
    expect(parseAddresses('A <a@b.com>, C <c@d.org>')).toEqual(['a@b.com', 'c@d.org'])
    expect(parseAddresses('a@b.com, A@B.com')).toEqual(['a@b.com'])
    // separators that are not white space never leave a different address behind
    for (const header of ['x"y@z.example', 'smith,john@z.example', 'john(vendor@z.example)', 'Name<j@x.example>', 'a@b.com;c@d.org', '"j@x.example"']) expect(parseAddresses(header), header).toEqual([])
    expect(parseAddresses('<j@x.example>,')).toEqual(['j@x.example'])
    // the loose reader is for LOOKUPS only (is one of the company's addresses already on the list?)
    expect(lookupAddresses('a@x.com;b@x.com, Ravi <r@x.com>')).toEqual(['a@x.com', 'b@x.com', 'r@x.com'])
  })
  it.each([
    ["Sean O'Brien <sean.o'brien@acme.example>"],
    ["d'souza@acme.example"],
    ['a&b@acme.example'],
    ['Hans Müller <hans.müller@acme.de>'],
    ['josé.m@acme.com'],
    ['x@sub.münchen.example'],
    ['"a b@c.example"@acme.example'],
    ['jo@acme.example-'],
    ['jo@acme.example.'],
    ['a@@b.com'],
    ['a@b'],
    ['one@good.example, d\'souza@bad.example'],
  ])('%s -> nothing (the whole header is refused; no address is "repaired")', (header) => {
    expect(parseAddresses(header)).toEqual([])
  })
  it('a header longer than what is read is refused, so the real sender cannot hide past the limit', () => {
    expect(parseAddresses('a@x.com' + ' '.repeat(2100) + '<b@y.com>')).toEqual([])
  })
  it('malformed, empty and hostile headers give nothing or something bounded, and do not hang', () => {
    for (const bad of [null, undefined, '', 'no address here', '@nothing', 'a@', '<>', '(((', 42]) expect(parseAddresses(bad as never), String(bad)).toEqual([])
    const many = Array.from({ length: 200 }, (_, i) => `u${i}@x.example`).join(', ')
    expect(parseAddresses(many.slice(0, 1900))).toHaveLength(ACTIVITY_ADDRESSES_MAX)
    for (const hostile of ['a'.repeat(1999), 'a@' + 'b'.repeat(1990), ('a@b' + '.').repeat(600), '<'.repeat(1900) + 'x@y.example', 'x'.repeat(65) + '@y.example', 'a'.repeat(500_000)]) {
      const t = Date.now()
      parseAddresses(hostile)
      expect(Date.now() - t).toBeLessThan(200)
    }
  })
  it('the mapper gives addresses only with the body opt-in, for inbound mail inside the window', () => {
    const raw = { id: 'a', type: 'email', companyId: 'c', subject: 's', direction: 'inbound', createdAt: day(3), body: 'hi', fromEmail: 'A <a@b.com>', matchedCompanyEmail: 'M <m@b.com>', mailboxEmail: 'me@ours.example', toEmail: 'me@ours.example', user: { email: 'rep@ours.example' } }
    expect(toActivity(raw, false, NOW)).not.toHaveProperty('fromAddresses')
    const a = toActivity(raw, true, NOW)
    expect(a).toMatchObject({ fromAddresses: ['a@b.com'], matchedAddress: 'm@b.com' })
    expect(a.ownAddresses!.sort()).toEqual(['me@ours.example', 'rep@ours.example'])
    expect(toActivity({ ...raw, direction: 'outbound' }, true, NOW)).not.toHaveProperty('fromAddresses')
    expect(toActivity({ ...raw, createdAt: day(120) }, true, NOW)).not.toHaveProperty('fromAddresses')
    expect(toActivity({ ...raw, fromEmail: null, matchedCompanyEmail: undefined }, true, NOW)).toMatchObject({ fromAddresses: [], matchedAddress: null })
  })
  it('masking shows enough to recognise, not the address; a one-letter local part is not shown at all', () => {
    expect(maskAddress('ravi@acme.example')).toBe('r***@acme.example')
    expect(maskAddress('x@acme.example')).toBe('***@acme.example')
    expect(maskAddress('nonsense')).toBe('***')
  })
})

describe('what counts as a STRICT, standalone opt-out (the only kind recorded)', () => {
  const strict = (body: string, subject = 'Re: Product data proposal') => assessReply(mail(body, { subject }), true)
  it.each([
    ['UNSUBSCRIBE'],
    ['Unsubscribe'],
    ['unsubscribe me'],
    ['Please unsubscribe me from your mailing list.'],
    ['STOP'],
    ['Stop.'],
    ['REMOVE ME'],
    ['Remove me from your mailing list'],
    ['REMOVE ME FROM YOUR MAILING LIST'],
    ['Please remove me from your list.'],
    ['DO NOT EMAIL ME'],
    ["Don't contact me again."],
    ['PLEASE STOP SENDING ME MARKETING EMAILS'],
    ['Please stop sending me marketing emails.'],
    ['Please do not send me any more emails'],
    ['Hi Sam,\n\nPlease unsubscribe me.\n\nThanks and regards,\nRavi Kumar\nPurchase Manager'],
    ['STOP\nUnsubscribe me'],
  ])('%j is strict', (body) => {
    const a = strict(body)
    expect(a).toMatchObject({ verdict: 'declined', kind: 'opt_out', strictOptOut: true })
  })
  it.each([
    ['asks for a quotation', "Please stop sending me marketing emails, but I do need a quote for 500 crates."],
    ['asks for product information', 'Unsubscribe me, and send the catalogue first.'],
    ['uses a different address', 'Please stop sending mails to the old address, use this one. We need a quote for 300 boxes.'],
    ['uses a different address (2)', 'Remove me from your list and write to my new address instead.'],
    ['refers to a colleague', 'Please unsubscribe my colleague Rahul from your list.'],
    ['refers to a colleague (2)', "Please don't contact Rahul about this, contact me instead. We need 500 crates, please send a quote."],
    ['is about "us" / the company', 'Please unsubscribe us from your mailing list.'],
    ['mixes the phrase with other instructions', 'Stop sending me emails on weekends, weekdays are fine. We need 2000 pallets.'],
    ['mixes the phrase with other instructions (2)', "I'd like to unsubscribe from the newsletter but I do want quotes for pallets."],
    ['is a plain opt-out inside a longer message', 'Thank you for your email. We reviewed it carefully with the team. Please stop sending me marketing emails and remove me from your list as discussed on the phone.'],
    ['is one word short of the exact phrase', 'Remove'],
  ])('is NOT strict - it %s', (_n, body) => {
    expect(strict(body).strictOptOut).toBe(false)
  })
  it('an opt-out only in the SUBJECT, or only in quoted text, is never strict', () => {
    expect(strict('Yes, please send the price list for 500 crates.', 'Re: Unsubscribe')).toMatchObject({ verdict: 'declined', kind: 'opt_out', strictOptOut: false })
    expect(strict('Thanks.', 'Unsubscribe')).toMatchObject({ strictOptOut: false })
    expect(strict('Please send the price list.\n\nOn Tue, 3 Nov 2026, Sales wrote:\n> to unsubscribe reply STOP\n> unsubscribe me').strictOptOut).toBe(false)
  })
  it('the standalone test itself: greetings and thanks do not count as "something else"; one extra word does', () => {
    expect(isStandaloneOptOut('Please unsubscribe me')).toBe(true)
    expect(isStandaloneOptOut('please unsubscribe me asap')).toBe(false)
    expect(isStandaloneOptOut('')).toBe(false)
    expect(isStandaloneOptOut('stop. thanks')).toBe(false) // thanks is stripped by the caller (substanceOf), not here
  })
  it('a clear refusal is NEVER positive buying intent: every wording of "do not send ... emails" is a refusal, not interest', () => {
    for (const body of [
      'Please do not send further emails to this address, we are not buying anything this year.',
      'Please do not send these emails again',
      'Please do not send further emails',
      'Please do not send mails',
      'Do not send us any more emails',
      'Please do not send future emails',
      "Don't send marketing emails",
      'We are not looking for this, please do not send further emails',
    ]) {
      const a = strict(body)
      expect(a.verdict, body).toBe('declined')
      expect(a.kind, body).toBe('opt_out')
    }
  })
})

describe('which address an explicit, strict opt-out may suppress', () => {
  it('the single, unambiguous sender of a strict opt-out - and nothing else', () => {
    const d = propose([mail(OPT, { id: 'act_1' })])
    expect(d.proposals).toHaveLength(1)
    expect(d.proposals[0]).toMatchObject({ address: 'ravi@acme.example', masked: 'r***@acme.example', suggestion: null, activityId: 'act_1', mode: 'dry_run' })
    expect(d.refused).toEqual([])
    expect(propose([mail(OPT)], true).proposals[0]!.mode).toBe('record')
  })
  it('a non-strict opt-out proposes NOTHING: it is listed for a person, with its activity, and no address', () => {
    const d = propose([mail('Please stop sending me marketing emails, but I do need a quote for 500 crates.', { id: 'act_7' })])
    expect(d.proposals).toEqual([])
    expect(d.refused).toHaveLength(1)
    expect(d.refused[0]).toMatchObject({ activityId: 'act_7', receivedOn: day(3).slice(0, 10) })
    expect(JSON.stringify(d.refused)).not.toMatch(/@/)
  })
  it('a different address we mailed on the conversation is only a masked SUGGESTION, never a second proposal', () => {
    const d = propose([mail(OPT, { matched: 'priya@acme.example' })])
    expect(d.proposals).toHaveLength(1)
    expect(d.proposals[0]!.address).toBe('ravi@acme.example')
    expect(d.proposals[0]!.suggestion).toBe('p***@acme.example')
    expect(JSON.stringify(d.proposals.map((p) => p.suggestion))).not.toContain('priya@')
  })
  it('refuses ambiguous, missing, unparseable, own, colleague, CRM-user, plus-alias and robot senders - and a message whose own mailbox is unknown', () => {
    const none = (m: ReturnType<typeof mail>) => expect(propose([m]).proposals).toEqual([])
    none(mail(OPT, { from: 'A <a@x.example>, B <b@x.example>' }))
    none(mail(OPT, { from: '"a@x.example" <b@y.example>' }))
    none(mail(OPT, { from: null }))
    none(mail(OPT, { from: "Sean O'Brien <sean.o'brien@acme.example>" })) // not repaired into a different address
    none(mail(OPT, { from: 'Sales <sales@ours.example>' })) // our mailbox
    none(mail(OPT, { from: 'Rep <rep@ours.example>' })) // the CRM user
    none(mail(OPT, { from: 'Bob <bob@ours.example>' })) // a colleague on our domain
    none(mail(OPT, { from: 'Sales <sales+campaign@ours.example>' })) // a plus alias of ours
    none(mail(OPT, { from: 'Ravi <ravi+news@acme.example>' })) // a plus alias: a person may use several
    none(mail(OPT, { mailbox: null, to: null, user: '' })) // nothing says who "we" are
    for (const robot of ['noreply@acme.example', 'no-reply@acme.example', 'no_reply@acme.example', 'do_not_reply@acme.example', 'do.not.reply@acme.example', 'no-reply-sales@acme.example', 'noreply+x@acme.example', 'donotreply2@acme.example', 'postmaster@acme.example', 'MAILER-DAEMON@acme.example', 'mailer_daemon@acme.example', 'mail-delivery-subsystem@acme.example', 'bounces@acme.example', 'bounce_123@acme.example', 'notifications@acme.example', 'alerts@acme.example', 'system@acme.example'])
      none(mail(OPT, { from: robot }))
    const why = propose([mail(OPT, { from: 'A <a@x.example>, B <b@x.example>' }), mail(OPT, { from: null }), mail(OPT, { from: 'noreply@acme.example' })]).refused
    expect(why).toHaveLength(3)
    expect(why.map((w) => w.reason).join(' ')).not.toMatch(/@/)
  })
  it('automated mail is never an opt-out (an auto-reply that quotes "unsubscribe")', () => {
    expect(propose([mail('Automatic reply: I am out of office. To unsubscribe from our newsletter click here to unsubscribe', { subject: 'Automatic reply: hi' })]).proposals).toEqual([])
  })
  it('only an EXPLICIT opt-out: not interested, one product, wrong person and a declined meeting write nothing and are not listed as opt-outs', () => {
    for (const body of ['Not interested.', 'We are not interested in crates.', 'Sorry, wrong person.', 'We will pass on this, thanks.']) {
      const d = propose([mail(body)])
      expect(d.proposals, body).toEqual([])
      expect(d.refused, body).toEqual([])
    }
    expect(propose([mail('Ravi Kumar has declined this invitation.', { subject: 'Declined: Product demo' })]).proposals).toEqual([])
  })
  it('never a domain-level or company-level row: a proposal is one bare address', () => {
    for (const body of ['Please remove our whole company from your database.', 'Unsubscribe everyone at acme.example', 'Stop emailing anyone at Acme', OPT]) {
      for (const p of propose([mail(body)], true).proposals) {
        expect(Object.keys(p).sort()).toEqual(['activityId', 'address', 'fingerprint', 'keyId', 'masked', 'mode', 'phrase', 'receivedOn', 'suggestion'])
        expect(p.address).toMatch(/^[^@\s]+@[^@\s]+$/)
      }
    }
  })
  it('a later friendly message does not undo it; the same address from two messages is proposed once, with the latest date and activity', () => {
    const d = propose([mail(OPT, { daysAgo: 40, id: 'old' }), mail(OPT, { daysAgo: 20, id: 'newer' }), mail('Thanks, please send the quote for 500 crates.', { daysAgo: 2 })])
    expect(d.proposals).toHaveLength(1)
    expect(d.proposals[0]).toMatchObject({ receivedOn: day(20).slice(0, 10), activityId: 'newer' })
  })
  it('forged mail from many other senders cannot push the real contact (the address we mailed) out of the capped list', () => {
    const real = mail(OPT, { from: 'real@cust.example', id: 'real', daysAgo: 60, matched: 'real@cust.example' })
    const forged = Array.from({ length: 40 }, (_, i) => mail(OPT, { from: `forged${i}@evil.example`, id: `f_${i}`, daysAgo: 1, matched: 'real@cust.example' }))
    const d = propose([...forged, real])
    expect(d.proposals).toHaveLength(25)
    expect(d.omitted!.proposals).toBe(16)
    expect(d.proposals.map((p) => p.activityId)).toContain('real') // the sender who IS the address we mailed comes first, however old
  })
  it('a sender on a SUBDOMAIN of one of our own domains is a colleague, not a proposal', () => {
    const d = propose([mail(OPT, { from: 'x@mail.ours.example', id: 'sub' })])
    expect(d.proposals).toEqual([])
    expect(d.refused[0]?.reason).toMatch(/own domains/)
  })
  it('a message dated in the future is never read, so a made-up date cannot take the newest slots', () => {
    const future = toActivity({ id: 'fut', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), body: 'UNSUBSCRIBE', fromEmail: 'x@y.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example' }, true, NOW)
    expect(future.body).toBeUndefined()
    expect(future.fromAddresses).toBeUndefined()
    expect(propose([future]).proposals).toEqual([])
  })
  it('text beyond the raw cut is never hidden behind a short opt-out: padded "UNSUBSCRIBE" is not a standalone opt-out', () => {
    const padded = toActivity({ id: 'pad', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: day(2), body: `UNSUBSCRIBE${' '.repeat(70_000)}but please send me a quote`, fromEmail: 'p@cust.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example' }, true, NOW)
    expect(padded.body).toMatch(/not read/)
    expect(propose([padded]).proposals).toEqual([])
  })
})

describe('bounded evidence: nothing grows with the number of hostile messages, and nothing is dropped silently', () => {
  it('more than 25 different senders: the first 25 are proposed and the rest are COUNTED (omitted)', () => {
    const many = Array.from({ length: 30 }, (_, i) => mail(OPT, { from: `u${i}@acme.example`, id: `act_${i}` }))
    const d = propose(many)
    expect(d.proposals).toHaveLength(25)
    expect(d.omitted).toEqual({ proposals: 5, notRecorded: 0 })
    expect(d.refused).toEqual([])
  })
  it('thousands of hostile "unsubscribe, and also send a quote" messages: 20 are listed, the rest counted, a few KB of stored reasons - not megabytes', () => {
    const msgs = Array.from({ length: 2000 }, (_, i) => mail('Unsubscribe me, and also please send a quote', { from: `h${i}@evil.example`, id: `h_${i}` }))
    const assessed = assess(msgs)
    const d = proposeOptOuts(assessed, false)
    expect(d.proposals).toEqual([])
    expect(d.refused).toHaveLength(20)
    expect(d.omitted).toEqual({ proposals: 0, notRecorded: 1980 })
    const reasons = signalsToReasons(optOutSignals({ assessed, decision: d, persisted: [], record: false }))
    expect(JSON.stringify(reasons).length).toBeLessThan(30_000)
    const om = reasons.find((r) => r.signal === 'opt_out_omitted')!
    expect(om.evidence).toBe('omitted proposals: 0 · not recorded: 1980')
    expect(om.summary).toMatch(/nothing was dropped silently|Nothing was dropped silently/)
  })
  it('the listed "not recorded" messages are the NEWEST ones', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => mail('Unsubscribe me, and also please send a quote', { from: `h${i}@evil.example`, id: `h_${i}`, daysAgo: i + 1 }))
    const d = proposeOptOuts(assess(msgs), false)
    expect(d.refused.map((r) => r.activityId)).toContain('h_0')
    expect(d.refused.map((r) => r.activityId)).not.toContain('h_29')
  })
  it('re-consent candidates: at most one per sender, at most 10, however many messages', () => {
    const optOut = mail(OPT, { from: 'a@acme.example', id: 'first', daysAgo: 40 })
    const again = Array.from({ length: 50 }, (_, i) => mail('Please subscribe me again', { from: 'a@acme.example', id: `re_${i}`, daysAgo: 1 + (i % 5) }))
    const assessed = assess([optOut, ...again])
    const sig = optOutSignals({ assessed, decision: proposeOptOuts(assessed, false), persisted: [], record: false })
    expect(sig.filter((s) => s.signalType === 'reconsent_candidate')).toHaveLength(1)
  })
})

describe('OUR OWN domains come from SERVER-SIDE configuration, never from the message; unknown ownership fails closed', () => {
  const restore = () => {
    env.WARM_LEADS_OWN_DOMAINS = 'ours.example'
    env.OUTREACH_FROM_EMAIL = ''
    env.SMTP_FROM = ''
    env.SMTP_USER = ''
  }
  beforeEach(restore)
  afterAll(restore)

  it('normalisation: lower case, no "@" or trailing dot, only well-formed names, no duplicates', () => {
    expect(normaliseDomains(' Ours.Example, @mail.ours.example; bad_domain  ours.example. , -x.example, a..b.example, localhost ')).toEqual(['ours.example', 'mail.ours.example'])
    expect(normaliseDomains('')).toEqual([])
    expect(normaliseDomains(undefined)).toEqual([])
  })
  it('trustedOwnDomains = WARM_LEADS_OWN_DOMAINS plus the domains of the configured sender addresses (OUTREACH_FROM_EMAIL, SMTP_FROM, SMTP_USER)', () => {
    env.OUTREACH_FROM_EMAIL = 'AltiusNXT <Sales@Sender.Example>'
    env.SMTP_FROM = 'noreply@smtp.example'
    env.SMTP_USER = 'mailer@ours.example'
    expect(trustedOwnDomains().sort()).toEqual(['ours.example', 'sender.example', 'smtp.example'])
  })
  it('UNKNOWN ownership fails closed: with no configured domain NO opt-out is proposed - each is listed as "not recorded" with the reason', () => {
    env.WARM_LEADS_OWN_DOMAINS = ''
    expect(trustedOwnDomains()).toEqual([])
    const d = propose([mail(OPT, { id: 'x' })], true)
    expect(d.proposals).toEqual([])
    expect(d.refused[0]).toMatchObject({ activityId: 'x' })
    expect(d.refused[0]!.reason).toMatch(/which domains are ours is not configured on the server/)
  })
  it('an attacker-controlled To header padded with junk addresses changes NOTHING: a colleague is still refused (the To header is not read at all)', () => {
    const junk = Array.from({ length: 30 }, (_, i) => `junk${i}@spam.example`).join(', ')
    const padded = toActivity({ id: 'pad-to', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: day(2), body: 'UNSUBSCRIBE', fromEmail: 'colleague@ours.example', toEmail: `${junk}, sales@ours.example`, mailboxEmail: 'sales@ours.example' }, true, NOW)
    expect(padded.ownAddresses).toEqual(['sales@ours.example']) // from NXT Sales' own record of the mailbox - NOT from the To header
    const d = proposeOptOuts(assess([padded]), true)
    expect(d.proposals).toEqual([])
    expect(d.refused[0]!.reason).toMatch(/own domains/)
    // with NO mailbox / user known and the To header padded the same way: still nothing (and the To header is never an "own address")
    const noMailbox = toActivity({ id: 'pad-to-2', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: day(2), body: 'UNSUBSCRIBE', fromEmail: 'colleague@ours.example', toEmail: `${junk}, sales@ours.example` }, true, NOW)
    expect(noMailbox.ownAddresses).toEqual([])
    expect(proposeOptOuts(assess([noMailbox]), true).proposals).toEqual([])
  })
  it('the To header cannot ADD an own address either: a message "to" a stranger\'s address does not make that stranger "ours"', () => {
    const a = mail(OPT, { to: 'victim@thirdparty.example', from: 'victim@thirdparty.example', id: 'to-victim' })
    expect(a.ownAddresses).not.toContain('victim@thirdparty.example')
  })
  it('colleagues, own subdomains, plus aliases and robots are refused; an outsider is proposed', () => {
    const one = (from: string) => propose([mail(OPT, { from, id: 'x' })], true)
    expect(one('Bob <bob@ours.example>').proposals).toEqual([])
    expect(one('Bob <bob@mail.eu.ours.example>').proposals).toEqual([])
    expect(one('Ravi <ravi+news@acme.example>').proposals).toEqual([])
    expect(one('no-reply@acme.example').proposals).toEqual([])
    expect(one('Ravi <ravi@acme.example>').proposals).toHaveLength(1)
    // a look-alike domain that merely ENDS with ours is not ours
    expect(one('Eve <eve@notours.example>').proposals).toHaveLength(1)
  })
  it('an explicit allowlist can be passed in (pure function): the only thing that decides is that list', () => {
    const a = mail(OPT, { from: 'Bob <bob@acme.example>', id: 'x' })
    expect(proposeOptOuts(assess([a]), true, ['acme.example']).proposals).toEqual([])
    expect(proposeOptOuts(assess([a]), true, ['other.example']).proposals).toHaveLength(1)
    expect(proposeOptOuts(assess([a]), true, []).proposals).toEqual([])
  })
})

describe('the fingerprint uses a DEDICATED key (never JWT_SECRET); a missing key fails closed', () => {
  const KEY = 'unit-test-fingerprint-key-0123456789abcdef-NOT-A-SECRET'
  beforeEach(() => {
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = KEY
  })
  afterAll(() => {
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = KEY
  })
  it('a configured key gives a 16-hex fingerprint and an 8-hex key id; neither contains or equals the address, and JWT_SECRET plays no part', () => {
    const p = propose([mail(OPT, { id: 'x' })], true).proposals[0]!
    expect(p.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(p.keyId).toMatch(/^[0-9a-f]{8}$/)
    const viaJwt = createHmac('sha256', env.JWT_SECRET).update('warmleads-optout|ravi@acme.example').digest('hex').slice(0, 16)
    expect(p.fingerprint).not.toBe(viaJwt)
    env.JWT_SECRET = 'a-completely-different-jwt-secret-for-this-test'
    expect(addressFingerprint('ravi@acme.example')).toBe(p.fingerprint) // changing JWT_SECRET changes nothing
  })
  it('NO key (or one under 32 characters) = NO fingerprint and no key id - JWT_SECRET is NEVER used instead', () => {
    for (const k of ['', 'too-short-key']) {
      env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = k
      expect(fingerprintKeyConfigured()).toBe(false)
      expect(fingerprintKeyId()).toBeNull()
      expect(addressFingerprint('ravi@acme.example')).toBeNull()
      const p = propose([mail(OPT, { id: 'x' })], true).proposals[0]!
      expect(p).toMatchObject({ fingerprint: null, keyId: null }) // still listed - but it cannot be approved
    }
  })
  it('another key gives another fingerprint and another key id (so a changed key is recognised)', () => {
    const a = { fp: addressFingerprint('ravi@acme.example'), id: fingerprintKeyId() }
    env.WARM_LEADS_OPT_OUT_FINGERPRINT_KEY = 'a-second-dedicated-key-0123456789abcdef-NOT-A-SECRET'
    expect(addressFingerprint('ravi@acme.example')).not.toBe(a.fp)
    expect(fingerprintKeyId()).not.toBe(a.id)
  })
  it('the evidence line carries fp and key (server side) - and reasonsPublic removes exactly those', () => {
    const p = propose([mail(OPT, { id: 'act_9' })], true).proposals
    const sig = optOutSignals({ assessed: assess([mail(OPT, { id: 'act_9' })]), decision: { proposals: p, refused: [] }, persisted: [], record: true })
    const line = signalsToReasons(sig).find((r) => r.signal === 'opt_out_proposal')!
    expect(line.evidence).toMatch(/ · fp [0-9a-f]{16} · key [0-9a-f]{8} · phrase: UNSUBSCRIBE/)
    const out = redactReasons([line])[0] as { evidence: string }
    expect(out.evidence).not.toMatch(/ · fp |· key |[0-9a-f]{16}/)
    expect(out.evidence).toMatch(/^status: awaiting_approval · NXT activity act_9 · received \d{4}-\d{2}-\d{2} · phrase: UNSUBSCRIBE/)
  })
})

describe('FAIL CLOSED: an unauthenticated or forged sender can never create a suppression row', () => {
  const rec = () => propose([mail(OPT, { id: 'act_9' })], true).proposals
  // Forged "unsubscribe" mails: whatever they claim about themselves, NXT Sales gives us the raw From header and nothing about SPF / DKIM / DMARC.
  const forged = [
    mail(OPT, { from: 'Victim <victim@thirdparty.example>' }), // someone forges a stranger's address as the sender
    toActivity({ id: 'f2', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: day(3), body: 'UNSUBSCRIBE', fromEmail: 'victim@thirdparty.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example', authenticationResults: 'spf=pass dkim=pass dmarc=pass', senderVerified: true, spf: 'pass', dkim: 'pass', verified: true, trusted: true }, true, NOW),
    toActivity({ id: 'f3', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: day(3), body: 'UNSUBSCRIBE\nAuthentication-Results: mx.google.com; spf=pass; dkim=pass; dmarc=pass\nReceived-SPF: pass', fromEmail: 'victim@thirdparty.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example' }, true, NOW),
  ]
  it('there is NO notion of a verified sender or an automatic writer any more: no such field, no such function', async () => {
    const mod = (await import('../../src/warmleads/optOut.js')) as Record<string, unknown>
    expect(mod.senderAuthenticated).toBeUndefined()
    expect(mod.recordOptOuts).toBeUndefined()
    expect(mod.applyOptOutResults).toBeUndefined()
    for (const a of forged) for (const p of proposeOptOuts(assess([a]), true).proposals) expect(Object.keys(p), a.id).not.toContain('senderVerified')
  })
  it('the mapper never carries any authentication claim into the activity', () => {
    for (const a of forged) {
      expect(Object.keys(a).sort()).toEqual(['body', 'companyId', 'createdAt', 'direction', 'fromAddresses', 'id', 'matchedAddress', 'ownAddresses', 'subject', 'type'])
    }
  })
  it('a proposal object that someone tampered with ("verified", "approved", "authenticated") still cannot be written without an administrator: the only writer needs the switch AND an approver', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = false
    const p = { ...rec()[0]!, senderVerified: true, approved: true, authenticated: true } as never
    expect((await writeApprovedOptOut('t1', p, 'user-7', AUDIT)).status).toBe('awaiting_approval') // switch off
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    expect((await writeApprovedOptOut('t1', p, '', AUDIT)).status).toBe('awaiting_approval') // switch on, nobody approved
    expect(db.creates).toEqual([])
    expect(db.audits).toEqual([])
    expect(db.finds).toEqual([])
    expect(db.others).toEqual([])
  })
  it('the stored line says it is NOT added, and why: a person must approve it', () => {
    const p = rec()
    const sig = optOutSignals({ assessed: assess([mail(OPT, { id: 'act_9' })]), decision: { proposals: p, refused: [] }, persisted: [], record: true })
    const line = signalsToReasons(sig).find((r) => r.signal === 'opt_out_proposal')!
    expect(line.summary).toMatch(/is NOT added yet: the sender of an email cannot be verified, so a person must approve it first/)
    expect(line.evidence).toMatch(/^status: awaiting_approval · NXT activity act_9 · received \d{4}-\d{2}-\d{2} · fp [0-9a-f]{16} · key [0-9a-f]{8} · phrase: UNSUBSCRIBE/)
  })
  it('a spoofed address that is OUR OWN, a colleague, a robot or ambiguous is refused even before approval is possible', () => {
    expect(propose([mail(OPT, { from: 'Sales <sales@ours.example>' })], true).proposals).toEqual([])
    expect(propose([mail(OPT, { from: 'Bob <bob@ours.example>' })], true).proposals).toEqual([])
  })
})

const AUDIT = { resourceId: 'c1|act_9', summary: (s: 'recorded' | 'already_listed') => `approved: ${s}`, metadata: { independentlyVerifiedConfirmed: true } }

describe('the ONLY writer: an administrator\'s approval (writeApprovedOptOut) - the row and its audit entry in ONE transaction', () => {
  const rec = () => propose([mail(OPT, { id: 'act_9' })], true).proposals
  it('with the switch off (the default) nothing is read or written', async () => {
    expect(env.WARM_LEADS_RECORD_OPT_OUTS).toBe(false)
    expect((await writeApprovedOptOut('t1', rec()[0]!, 'user-7', AUDIT)).status).toBe('awaiting_approval')
    expect(db.creates).toEqual([])
    expect(db.audits).toEqual([])
    expect(db.finds).toEqual([])
    expect(db.others).toEqual([])
  })
  it('APPROVED: exactly the row Bulk Email\'s own unsubscribe writes - global, email, source "unsubscribe", no expiry, no domain - naming the approver, plus its audit entry', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    const res = await writeApprovedOptOut('t1', rec()[0]!, 'user-7', AUDIT)
    expect(res).toEqual({ address: 'ravi@acme.example', masked: 'r***@acme.example', activityId: 'act_9', status: 'recorded' })
    expect(db.creates).toHaveLength(1)
    const c = db.creates[0]!
    expect(c).toMatchObject({ tenantId: 't1', scope: 'global', matchType: 'email', matchValue: 'ravi@acme.example', source: 'unsubscribe', createdByCrmUserId: 'user-7' })
    expect(c).not.toHaveProperty('expiresAt')
    expect(c).not.toHaveProperty('campaignId')
    expect(c.reason).toMatch(/^Opt-out request in an email reply on \d{4}-\d{2}-\d{2} \(NXT activity act_9\); approved by a person who verified it through a trusted contact channel \(read by Warm Leads\)$/)
    expect(db.audits).toHaveLength(1)
    expect(db.audits[0]).toMatchObject({ tenantId: 't1', actorType: 'user', actorCrmUserId: 'user-7', action: 'warmleads.opt_out_approved', resourceId: 'c1|act_9', dataClass: 'customer_pii', summary: 'approved: recorded' })
    expect(JSON.stringify(db.audits)).not.toContain('ravi@acme')
    expect(db.others).toEqual([])
  })
  it('ATOMIC: if the audit entry cannot be written, the row is rolled back and the result is "failed" - never "recorded"', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    db.failAudit = true
    const res = await writeApprovedOptOut('t1', rec()[0]!, 'user-7', AUDIT)
    expect(res.status).toBe('failed')
    expect(db.creates).toEqual([]) // the stand-in transaction restores its state exactly as the real one does (proved on a real database in warmLeadsWorkflow.test.ts)
    expect(db.audits).toEqual([])
    expect(db.transactions).toBe(1) // both writes went through the one transaction
  })
  it('"recorded" ONLY when a new row was really inserted: if another writer got there first (insert count 0) and left a PERMANENT row, the answer is "already_listed" - and still audited as an approval', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    db.race = { row: { expiresAt: null } }
    const res = await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)
    expect(res.status).toBe('already_listed')
    expect(db.creates).toEqual([]) // nothing was inserted by us
    expect(db.audits).toHaveLength(1)
    expect(db.audits[0]).toMatchObject({ summary: 'approved: already_listed' })
  })
  it('... if the other writer left a TEMPORARY row, or the row is gone again, it is "needs_person" - never a success, and nothing is audited', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    db.race = { row: { expiresAt: new Date(Date.now() + 86_400_000) } }
    expect((await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)).status).toBe('needs_person')
    db.race = { row: 'gone' }
    expect((await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)).status).toBe('needs_person')
    expect(db.audits).toEqual([])
    expect(db.creates).toEqual([])
  })
  it('an approval needs an approver', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    expect((await writeApprovedOptOut('t1', rec()[0]!, '', AUDIT)).status).toBe('awaiting_approval')
    expect(db.creates).toEqual([])
  })
  it('an address that is not exactly one plain lower-case address is refused AT THE WRITER, whatever the proposal says', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    const base = rec()[0]!
    for (const bad of ['souza@acme.example#', 'Ravi@Acme.example', 'a@b.com, c@d.com', "d'souza@acme.example", '', 'nobody', 'user@münchen.example', '@acme.example']) {
      expect((await writeApprovedOptOut('t1', { ...base, address: bad }, 'user-7', AUDIT)).status, bad).toBe('needs_person')
    }
    expect(db.creates).toEqual([])
    expect(db.audits).toEqual([])
  })
  it('IDEMPOTENT: an address already on the list is not written again (still audited as an approval); an existing TEMPORARY or EXPIRED entry is not revived - and is NOT reported as a success', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    db.existing.set('ravi@acme.example', { expiresAt: null })
    expect((await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)).status).toBe('already_listed')
    expect(db.creates).toEqual([])
    expect(db.audits).toHaveLength(1)
    // a TEMPORARY entry (even one still in force) lapses and the opt-out would be forgotten, so it is never "already listed": a person decides
    db.existing.set('ravi@acme.example', { expiresAt: new Date(Date.now() + 86_400_000) })
    expect((await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)).status).toBe('needs_person')
    db.existing.set('ravi@acme.example', { expiresAt: new Date(Date.now() - 86_400_000) })
    expect((await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)).status).toBe('needs_person')
    expect(db.creates).toEqual([])
    expect(db.audits).toHaveLength(1) // nothing was approved in the last two cases, so nothing was audited
  })
  it('a database error is "failed" - never "recorded" - on a read and on a write, and nothing is left behind', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    db.failFor.add('ravi@acme.example')
    expect((await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)).status).toBe('failed')
    expect(db.creates).toEqual([])
    expect(db.audits).toEqual([])
  })
  it('each approval is its own transaction: one failing never hides another', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    const props = propose([mail(OPT, { from: 'a@acme.example', id: 'act_a' }), mail(OPT, { from: 'b@acme.example', id: 'act_b' }), mail(OPT, { from: 'c@acme.example', id: 'act_c' })], true).proposals
    db.failFor.add('b@acme.example')
    const res = []
    for (const p of props) res.push(await writeApprovedOptOut('t1', p, 'u', AUDIT))
    expect(res.map((r) => [r.address, r.status]).sort()).toEqual([['a@acme.example', 'recorded'], ['b@acme.example', 'failed'], ['c@acme.example', 'recorded']])
    expect(db.creates.map((u) => u.matchValue).sort()).toEqual(['a@acme.example', 'c@acme.example'])
  })
  it('never a second address, a domain or a company', async () => {
    env.WARM_LEADS_RECORD_OPT_OUTS = true
    await writeApprovedOptOut('t1', rec()[0]!, 'u', AUDIT)
    expect(db.creates.map((u) => u.matchType)).toEqual(['email'])
    expect(db.creates.map((u) => u.matchValue)).toEqual(['ravi@acme.example'])
  })
})

describe('persistence beyond the 90-day window, and which existing rows count as an opt-out', () => {
  it('reads the suppression list for the company\'s addresses: global, email, not expired, ignoring case - and nothing for an empty list', async () => {
    expect(await persistedOptOuts('t1', [])).toEqual([])
    expect(db.raw).toEqual([])
    db.rawRows = [{ matchValue: 'Ravi@Acme.example', source: 'unsubscribe', reason: 'x' }]
    expect(await persistedOptOuts('t1', ['Ravi@Acme.example', 'x@acme.example'])).toEqual(['ravi@acme.example'])
    const q = db.raw[0]!
    expect(q.sql).toMatch(/"scope" = 'global'/)
    expect(q.sql).toMatch(/"matchType" = 'email'/)
    expect(q.sql).toMatch(/LOWER\("matchValue"\) = ANY/)
    expect(q.sql).toMatch(/"expiresAt" IS NULL OR "expiresAt" > NOW\(\)/)
    expect(q.values).toContain('t1')
    expect(q.values).toContainEqual(['ravi@acme.example', 'x@acme.example'])
  })
  it('only rows that confirm an individual marketing opt-out hold a company: automatic ones, and manual ones whose own reason says so', async () => {
    const rows = [
      { matchValue: 'a@x.example', source: 'unsubscribe', reason: 'Opt-out request in an email reply on 2026-11-03 (read by Warm Leads)' },
      { matchValue: 'b@x.example', source: 'manual', reason: 'Asked to be unsubscribed by phone' },
      { matchValue: 'c@x.example', source: 'manual', reason: 'Do not email this person' },
      { matchValue: 'd@x.example', source: 'manual', reason: 'Wrong person - left the company' },
      { matchValue: 'e@x.example', source: 'import', reason: 'Unsubscribed (old list)' },
      { matchValue: 'f@x.example', source: 'policy', reason: 'Competitor' },
      { matchValue: 'g@x.example', source: 'manual', reason: 'Bounced address' },
    ]
    db.rawRows = rows
    expect(await persistedOptOuts('t1', rows.map((r) => r.matchValue))).toEqual(['a@x.example', 'b@x.example', 'c@x.example'])
    expect(rows.map(isIndividualOptOutRow)).toEqual([true, true, true, false, false, false, false])
  })
  it('candidate addresses: the company\'s saved addresses (parsed, not raw), and the senders of its inbound mail, never our own', () => {
    const company = { email: 'Info@Acme.example', emails: ['Ravi <Ravi@Acme.example>', 'a@x.com;b@x.com', 'bad'] } as never
    const a = candidateAddresses(company, [mail('hi', { from: 'Ravi <ravi@acme.example>' }), mail('hi', { from: 'Me <sales@ours.example>' }), mail('x', { direction: 'outbound', from: 'z@z.example' })])
    expect(a.sort()).toEqual(['a@x.com', 'b@x.com', 'info@acme.example', 'ravi@acme.example']) // both addresses of a two-address field are candidates; "bad" is ignored
  })

  const site = { status: 'reachable', url: 'https://acme.example/', hasProductSchema: true, commercePlatforms: ['Shopify'] } as const
  const withSignals = (activities: ReturnType<typeof mail>[], persisted: string[] = [], extra: ObservedSignal[] = [], record = false) => {
    const assessed = assess(activities)
    const decision = proposeOptOuts(assessed, record)
    const eng = engagementSignal(activities, NOW, undefined, 30, { requireText: true })
    const permission = optOutSignals({ assessed, decision, persisted, record })
    return { permission, input: { crm: { ok: true, signals: [...(eng ? [eng] : []), ...permission, ...extra] }, website: site, deep: { status: 'done', signals: [] } } as EvaluationInput }
  }

  it('a dry run lists the masked address, the day, the status "dry_run" and the NXT activity - and says nothing was written', () => {
    const { permission } = withSignals([mail(OPT, { id: 'act_5' })])
    const p = permission.find((s) => s.signalType === 'opt_out_proposal')!
    expect(p.summary).toMatch(/^r\*\*\*@acme\.example \(the sender of the opt-out of \d{4}-\d{2}-\d{2}\) is PROPOSED for the suppression list — DRY RUN: nothing was written/)
    expect(p.summary).not.toMatch(/would be added/)
    expect(p.evidence).toMatch(/^status: dry_run · NXT activity act_5 · received \d{4}-\d{2}-\d{2} · fp [0-9a-f]{16} · key [0-9a-f]{8}/)
    expect(JSON.stringify(permission)).not.toContain('ravi@acme.example')
    expect(permission.every((s) => s.polarity === 'neutral')).toBe(true)
  })
  it('a non-strict opt-out is listed "for a person" with its activity, and the company is still held', () => {
    const { permission, input } = withSignals([mail('Please unsubscribe us from your list, and send the catalogue.', { id: 'act_6' })])
    const n = permission.find((s) => s.signalType === 'opt_out_not_recorded')!
    expect(n.evidence).toMatch(/^status: needs_person · NXT activity act_6 · received /)
    expect(permission.some((s) => s.signalType === 'opt_out_proposal')).toBe(false)
    expect(permission.some((s) => s.signalType === 'contact_opt_out')).toBe(true)
    expect(classify(input).classification).not.toBe('warm')
  })
  it('an acknowledgement, quote request, product enquiry or friendly reply NEVER lifts it: the opt-out signal stays, and a would-be Warm company stays in human review', () => {
    for (const later of ['Ok thanks', 'Thanks, noted.', 'Please send the quote for 500 crates.', 'Do you also make pallets? We need 2000 pallets, please quote.', 'Great, lovely to hear from you, we will talk soon about the catalogue.']) {
      const { permission, input } = withSignals([mail(OPT, { daysAgo: 20 }), mail(later, { daysAgo: 2 })])
      expect(permission.some((s) => s.signalType === 'contact_opt_out'), later).toBe(true)
      expect(permission.some((s) => s.signalType === 'reconsent_candidate'), later).toBe(false)
      const r = classify(input)
      if (/quote/.test(later)) expect(r.reasons.find((x) => x.signal === 'inbound_engagement')).toMatchObject({ points: 45 })
      expect(['human_review', 'cold'], later).toContain(r.classification)
      if (r.score >= 25 && r.reasons.some((x) => x.signal === 'inbound_engagement' && x.points > 0)) expect(r.classification, later).toBe('human_review')
    }
  })
  it('an opt-out that is only on the suppression list (older than the window) holds a would-be-Warm company in human review', () => {
    const q = mail('Please send the quote for 500 crates.', { daysAgo: 2 })
    const { permission, input } = withSignals([q], ['ravi@acme.example'])
    expect(permission.find((s) => s.signalType === 'contact_opt_out')!.evidence).toMatch(/1 address\(es\) on the suppression list as an opt-out; r\*\*\*@acme\.example/)
    const r = classify(input)
    expect(r.score).toBe(55)
    expect(r.classification).toBe('human_review')
    expect(r.summary).toMatch(/a contact has opted out of marketing email .* only a person can/)
    expect(classify(withSignals([q]).input).classification).toBe('warm')
  })
  it('company or domain DNC is a hard restriction: it outranks everything, whatever the replies say', () => {
    const dnc: ObservedSignal = { signalType: 'suppressed', signalCategory: 'crm', polarity: 'negative', confidence: 'high', freshness: 'unknown', status: 'active', summary: 'on the list', evidence: '', sourceUrl: null, observedAt: null }
    const { input } = withSignals([mail('Please send the quote for 500 crates.', { daysAgo: 1 })], [], [dnc])
    expect(classify(input).classification).toBe('do_not_contact')
    const { input: input2 } = withSignals([mail(OPT, { daysAgo: 20 }), mail('Yes please subscribe me again', { daysAgo: 1 })], ['ravi@acme.example'], [dnc])
    expect(classify(input2).classification).toBe('do_not_contact')
  })
  it('not interested creates no suppression and no contact opt-out, and is never positive buying intent', () => {
    const { permission, input } = withSignals([mail('Not interested, thanks.')])
    expect(permission).toEqual([])
    const r = classify(input)
    expect(r.reasons.find((x) => x.signal === 'reply_declined')).toMatchObject({ points: 0 })
    expect(r.reasons.some((x) => x.signal === 'inbound_engagement')).toBe(false)
  })
  it('a rejection of one product does not suppress, and does not stop unrelated demand from being Warm', () => {
    const events = [1, 2].map((i): ObservedSignal => ({ signalType: 'expansion' + i, signalCategory: 'business', polarity: 'positive', confidence: 'high', freshness: 'fresh', status: 'active', summary: 'event ' + i + ' at the plant', evidence: 'q', sourceUrl: 'https://n.example/' + i, observedAt: '2026-10-28' }))
    const { permission, input } = withSignals([mail('We are not interested in crates.')])
    expect(permission).toEqual([])
    expect(classify({ ...input, deep: { status: 'done', signals: events } }).classification).toBe('warm')
  })
  it('a clear, affirmative re-consent only creates a review candidate: the opt-out stays and the classification does not change', () => {
    for (const yes of ['Please subscribe me again.', 'You can add us back to your mailing list.', 'We would like to receive your newsletter.', 'Keep me informed about new products.']) {
      expect(affirmsMarketingConsent(yes), yes).toBe(true)
      const { permission, input } = withSignals([mail(OPT, { daysAgo: 20 }), mail(yes, { daysAgo: 1 })])
      const c = permission.find((s) => s.signalType === 'reconsent_candidate')
      expect(c, yes).toBeTruthy()
      expect(c!.summary).toMatch(/r\*\*\*@acme\.example .* a person reviews this and removes the suppression row/)
      expect(permission.some((s) => s.signalType === 'contact_opt_out')).toBe(true)
      expect(classify(input).classification).not.toBe('warm')
    }
  })
  it('only affirmative wording is re-consent: an acknowledgement, quote request or enquiry never is', () => {
    for (const no of ['Ok thanks', 'Please send the quote for 500 crates', 'Do you stock pallets?', 'We might look at this next year', 'Thanks for the information', 'Please do not subscribe me']) expect(affirmsMarketingConsent(no), no).toBe(false)
  })
  it('a re-consent from someone who did not opt out is not a candidate', () => {
    const { permission } = withSignals([mail(OPT, { daysAgo: 20 }), mail('Please subscribe me again.', { daysAgo: 1, from: 'Other <other@acme.example>' })])
    expect(permission.some((s) => s.signalType === 'reconsent_candidate')).toBe(false)
  })
})

describe('the pilot review list: proposals survive a failed re-evaluation and hold no raw address', () => {
  const base = { crmCompanyId: 'c1', companyName: 'Acme', evaluationId: 'e1', evaluatedAt: '2026-11-04T01:00:00.000Z' }
  const sig = (id: string, status: 'dry_run' | 'recorded' = 'dry_run') => {
    const p = propose([mail(OPT, { id })]).proposals
    return signalsToReasons(optOutSignals({ assessed: assess([mail(OPT, { id })]), decision: { proposals: p, refused: [] }, persisted: [], record: false })).map((r) => (status === 'dry_run' ? r : { ...r, evidence: (r.evidence ?? '').replace('dry_run', status) }))
  }
  it('reads masked address, status, day and NXT activity back out of stored reasons', () => {
    const items = itemsFromReasons(sig('act_41'), base)
    const p = items.find((i) => i.kind === 'proposal')!
    expect(p).toMatchObject({ masked: 'r***@acme.example', status: 'dry_run', activityId: 'act_41', crmCompanyId: 'c1', companyName: 'Acme' })
    expect(p.receivedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(JSON.stringify(items)).not.toContain('ravi@acme.example')
    expect(itemsFromReasons(null, base)).toEqual([])
    expect(itemsFromReasons([{ signal: 'opt_out_proposal', summary: 42 }, 'x', null], base)).toEqual([])
  })
  it('the proposal found by a FAILED evaluation is kept, and a later evaluation with nothing does not hide it', () => {
    const failedReasons = signalsToReasons(optOutSignals({ assessed: assess([mail(OPT, { id: 'act_77' })]), decision: propose([mail(OPT, { id: 'act_77' })]), persisted: [], record: false }))
    const earlier = itemsFromReasons([{ signal: 'website_access_failed', summary: 'x' }, ...failedReasons], { ...base, evaluationId: 'e1' })
    const later = itemsFromReasons([{ signal: 'website_access_failed', summary: 'x' }], { ...base, evaluationId: 'e2' }) // the re-check: nothing about opt-outs
    const listed = latestPerSource([...later, ...earlier]) // newest evaluation first
    expect(listed.filter((i) => i.kind === 'proposal')).toHaveLength(1)
    expect(listed.find((i) => i.kind === 'proposal')!.evaluationId).toBe('e1')
  })
  it('the same source activity appears once, in its most recent status', () => {
    const newer = itemsFromReasons(sig('act_5', 'recorded'), { ...base, evaluationId: 'e9' })
    const older = itemsFromReasons(sig('act_5', 'dry_run'), { ...base, evaluationId: 'e1' })
    const listed = latestPerSource([...newer, ...older]).filter((i) => i.kind === 'proposal')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ status: 'recorded', evaluationId: 'e9' })
  })
})

describe('what automation may never do', () => {
  const warmleads = path.resolve('src/warmleads')
  const files = fs.readdirSync(warmleads).filter((f) => f.endsWith('.ts'))
  it('optOut.ts is the ONLY file in src/warmleads that writes to the suppression list, and nothing there ever deletes or edits a row', () => {
    const writers: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(path.join(warmleads, f), 'utf8')
      if (/suppressionEntry\s*\.\s*(?:upsert|create|createMany|update|updateMany|delete|deleteMany)\b/.test(src)) writers.push(f)
      expect(/suppressionEntry\s*\.\s*(?:update|updateMany|delete|deleteMany|upsert)\b/.test(src), f + ' must not edit or delete suppression rows').toBe(false)
      if (f !== 'optOut.ts') expect(/suppressionEntry\s*\.\s*(?:createMany|create)\b/.test(src), f + ' must not write suppression rows').toBe(false)
      expect(/(?:DELETE\s+FROM|UPDATE|INSERT\s+INTO)\s+"?SuppressionEntry/i.test(src), f).toBe(false)
    }
    expect(writers).toEqual(['optOut.ts'])
    const own = fs.readFileSync(path.join(warmleads, 'optOut.ts'), 'utf8')
    // the ONE write is a createMany inside the approval transaction, together with its audit entry; there is no upsert and no other writer
    expect(own.match(/suppressionEntry\s*\.\s*createMany/g)).toHaveLength(1)
    expect(own).not.toMatch(/suppressionEntry\s*\.\s*(?:upsert|create|update|updateMany|delete|deleteMany)\b/)
    expect(own).toMatch(/prisma\.\$transaction\(/)
    expect(own).toMatch(/auditInTransaction\(tx,/)
    expect(own).toMatch(/!env\.WARM_LEADS_RECORD_OPT_OUTS \|\| !approverCrmUserId/)
    // the automatic-write path is COMPLETELY absent
    expect(own).not.toMatch(/senderVerified|senderAuthenticated|recordOptOuts|applyOptOutResults|verified:\s*true/)
    expect(own).not.toMatch(/matchType:\s*'(?:domain|company)'/)
  })
  it('who may call the writers: the human-approved writer only from optOutApproval.ts; approveOptOut only from the admin route; nothing from the worker', () => {
    const srcRoot = path.resolve('src')
    const all: string[] = []
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d)) {
        const f = path.join(d, n)
        if (fs.statSync(f).isDirectory()) walk(f)
        else if (n.endsWith('.ts')) all.push(f)
      }
    }
    walk(srcRoot)
    const rel = (f: string) => path.relative(srcRoot, f).split(path.sep).join('/')
    const using = (re: RegExp) => all.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
    expect(using(/\bwriteApprovedOptOut\(/)).toEqual(['warmleads/optOut.ts', 'warmleads/optOutApproval.ts']) // its definition, and its one caller
    expect(using(/\bapproveOptOut\(/)).toEqual(['api/routes/warmLeads.routes.ts', 'warmleads/optOutApproval.ts']) // its definition, and the admin route
    expect(using(/\brevealOptOutAddress\(/)).toEqual(['api/routes/warmLeads.routes.ts', 'warmleads/optOutApproval.ts']) // the reveal: its definition, and the admin route
    // the automatic-write path no longer exists anywhere in the product code
    expect(using(/\bsenderVerified\b|\bsenderAuthenticated\b|\brecordOptOuts\(|\bapplyOptOutResults\b/)).toEqual([])
    // the worker's import closure never includes the approval module
    const seen = new Set<string>()
    const follow = (f: string) => {
      if (seen.has(f)) return
      seen.add(f)
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        const p = path.resolve(path.dirname(f), (m[1] ?? m[2])!).replace(/\.js$/, '.ts')
        if (fs.existsSync(p)) follow(p)
      }
    }
    follow(path.join(srcRoot, 'warmleadsWorker.ts'))
    expect([...seen].map(rel).filter((x) => /optOutApproval|api\/routes/.test(x))).toEqual([])
  })
  it('the switch is off by default', () => {
    const src = fs.readFileSync(path.resolve('src/config/env.ts'), 'utf8')
    expect(src).toMatch(/WARM_LEADS_RECORD_OPT_OUTS:\s*bool\.default\('false'\)/)
  })
  it('optOut.ts and optOutReview.ts reach nothing under outreach/, api/, orchestrator or approval (worker isolation)', () => {
    const seen = new Set<string>()
    const walk = (f: string) => {
      if (seen.has(f)) return
      seen.add(f)
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
        const p = path.resolve(path.dirname(f), m[1]!).replace(/\.js$/, '.ts')
        if (fs.existsSync(p)) walk(p)
      }
    }
    walk(path.join(warmleads, 'optOut.ts'))
    walk(path.join(warmleads, 'optOutReview.ts'))
    const rel = [...seen].map((f) => path.relative(path.resolve('src'), f).split(path.sep).join('/'))
    expect(rel.filter((x) => /^(outreach|api|orchestrator|approval)\//.test(x))).toEqual([])
  })
})

describe('the NXT Sales run summary and payloads', () => {
  const counts = { processed: 11, warm: 1, earlySignal: 1, cold: 2, insufficient: 1, existingCustomer: 1, activeOpportunity: 1, doNotContact: 1, humanReview: 2, failed: 1 }
  const run = { kind: 'pilot', status: 'completed', requestedBy: 'u', total: 12, approvedAt: null, approvedBy: null, startedAt: null, finishedAt: null }
  it('human_review is not counted as processed there, so NXT Sales\' categories add up; the Marketing count is untouched', () => {
    const p = runSummaryPayload(run, counts)
    expect(p.processed).toBe(9)
    expect(p.warm + p.earlySignal + p.cold + p.insufficient + p.existingCustomer + p.activeOpportunity + p.doNotContact + p.failed).toBe(p.processed)
    expect(counts.humanReview).toBe(2)
    expect(p).not.toHaveProperty('humanReview')
  })
  it('no status NXT Sales does not accept can reach it: human_review is neither listed nor in its list; everything listed is accepted', () => {
    expect(NXT_ACCEPTED_CLASSIFICATIONS).not.toContain('human_review')
    for (const c of LISTED_IN_CRM) expect(NXT_ACCEPTED_CLASSIFICATIONS).toContain(c)
    expect([...DEFINITIVE].filter((c) => !NXT_ACCEPTED_CLASSIFICATIONS.includes(c))).toEqual(['human_review'])
    expect(syncAction({ classification: 'human_review', currentEvaluationId: 'e1', syncedEvaluationId: null })).toBe('none')
  })
  it('the last-line guard: only a classification NXT accepts (or null for a failed evaluation) may be sent', () => {
    for (const ok of [...NXT_ACCEPTED_CLASSIFICATIONS, null]) expect(() => assertNxtSendable(ok)).not.toThrow()
    for (const bad of ['human_review', 'unknown', '', 'WARM']) expect(() => assertNxtSendable(bad), bad).toThrow(/not one NXT Sales accepts/)
  })
})
