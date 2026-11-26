import { describe, expect, it } from 'vitest'
import { toActivity } from '../../src/crm/nxtSales/mappers.js'
import { ACTIVITY_BODY_MAX, ACTIVITY_UNREAD_MARKER } from '../../src/crm/types.js'
import { assessReply, engagementSignal, summariseInbound } from '../../src/warmleads/replies.js'

// A message that was NOT READ IN FULL (the raw text is cut at 60,000 characters before any pattern runs) may hold a refusal in the part that was
// cut off. Nothing positive may be inferred from it: a truncated refusal must NEVER become buying intent. The mapper's internal marker is removed
// before the text is judged; a body that is only the marker is "unverified".

const NOW = new Date('2026-11-10T00:00:00Z')
const REFUSAL = '<p>Please remove us from your mailing list</p>'
const mk = (body: string, id = 'a1') =>
  toActivity({ id, type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: '2026-11-09T10:00:00Z', body, fromEmail: 'p@cust.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example' }, true, NOW)
const style = (chars: number) => '<head><style>' + 'a{b:c}'.repeat(Math.ceil(chars / 6)) + '</style></head>'
const positive = (activities: ReturnType<typeof mk>[]) => {
  const sig = engagementSignal(activities, NOW, undefined, 30, { requireText: true })
  return sig !== null && sig.polarity === 'positive'
}

describe('a truncated message never becomes buying intent', () => {
  it('CONTROL: the same refusal after 48k of style markup is read, and is a refusal', () => {
    const a = mk(style(48_000) + REFUSAL)
    expect(a.body).toBe('Please remove us from your mailing list')
    expect(assessReply(a, true)).toMatchObject({ verdict: 'declined', kind: 'opt_out', basis: 'text' })
  })

  it('60k+ of leading style / markup before an explicit refusal: unverified - not interest, and no positive signal', () => {
    for (const lead of [style(84_000), '<style' + ' x'.repeat(30_000), '<!--' + 'x'.repeat(70_000), '<script>' + 'x'.repeat(70_000)]) {
      const a = mk(lead + REFUSAL)
      expect(a.body, lead.slice(0, 12)).toContain(ACTIVITY_UNREAD_MARKER) // the message says it was not read in full
      const r = assessReply(a, true)
      expect(r.verdict, lead.slice(0, 12)).toBe('unverified')
      expect(r.strictOptOut).toBe(false)
      expect(positive([a])).toBe(false)
    }
  })

  it('a 70k base64 image before an explicit refusal: unverified, never interest', () => {
    const a = mk('<img src="data:image/png;base64,' + 'A'.repeat(70_000) + '">' + REFUSAL)
    const r = assessReply(a, true)
    expect(r.verdict).toBe('unverified')
    expect(positive([a])).toBe(false)
  })

  it('a smaller base64 image is not text: it is removed, and the refusal after it is read', () => {
    const a = mk('<img src="data:image/png;base64,' + 'A'.repeat(20_000) + '">' + REFUSAL)
    expect(a.body).toBe('Please remove us from your mailing list')
    expect(assessReply(a, true)).toMatchObject({ verdict: 'declined', kind: 'opt_out' })
  })

  it('marker-only content is unverified (and the marker is never the person\'s words)', () => {
    const only = toActivity({ id: 'm', type: 'email', companyId: 'c1', subject: 'Re: hi', direction: 'inbound', createdAt: '2026-11-09T10:00:00Z', body: ACTIVITY_UNREAD_MARKER, fromEmail: 'p@cust.example', mailboxEmail: 'sales@ours.example', toEmail: 'sales@ours.example' }, true, NOW)
    expect(only.body).toBe(ACTIVITY_UNREAD_MARKER)
    expect(assessReply(only, true)).toMatchObject({ verdict: 'unverified', kind: null })
    expect(positive([only])).toBe(false)
    // garbage plus the marker is the same
    const garbage = mk('x'.repeat(70_000))
    expect(assessReply(garbage, true).verdict).not.toBe('interested')
  })

  it('a truncated message that LOOKS like interest in the part that was read is still not interest', () => {
    const a = mk('Yes, please send the quote for 500 crates.' + ' '.repeat(70_000) + 'but remove us from your list')
    expect(a.body).toContain(ACTIVITY_UNREAD_MARKER)
    expect(assessReply(a, true).verdict).toBe('unverified')
    expect(positive([a])).toBe(false)
    // while the SAME message without the unread tail is interest, as before
    expect(assessReply(mk('Yes, please send the quote for 500 crates.'), true).verdict).toBe('interested')
  })

  it('a refusal in the part that WAS read still counts (it can only make the company more careful) - but is never a standalone opt-out', () => {
    const a = mk('Please remove us from your mailing list.' + ' '.repeat(70_000) + 'and send the catalogue')
    const r = assessReply(a, true)
    expect(r).toMatchObject({ verdict: 'declined', kind: 'opt_out', strictOptOut: false, strictPhrase: null })
  })

  it('the marker survives the length limit: a long truncated message always ends with it, within the limit', () => {
    const a = mk('Thanks for the offer. '.repeat(2_000) + ' '.repeat(70_000) + 'tail')
    expect(a.body!.length).toBeLessThanOrEqual(ACTIVITY_BODY_MAX)
    expect(a.body!.endsWith(ACTIVITY_UNREAD_MARKER)).toBe(true)
    expect(assessReply(a, true).verdict).toBe('unverified')
  })

  describe('the 6,000-character limit on the cleaned text (well below the 60,000 raw cut)', () => {
    const signal = (a: ReturnType<typeof mk>) => engagementSignal([a], NOW, undefined, 30, { requireText: true })
    const LEAD = 'Thanks, please send a quote for 500 crates. '
    const FILLER = 'We make steel drums for the food trade. '
    const LATE_REFUSAL = 'Please remove us from your mailing list.'

    it('BOUNDARY: exactly 6,000 characters is read in full (no marker); 6,001 is not, and says so', () => {
      const exact = mk(LEAD + 'a'.repeat(ACTIVITY_BODY_MAX - LEAD.length))
      expect(exact.body).toHaveLength(ACTIVITY_BODY_MAX)
      expect(exact.body).not.toContain(ACTIVITY_UNREAD_MARKER)
      expect(assessReply(exact, true).verdict).toBe('interested') // read in full: as before
      const over = mk(LEAD + 'a'.repeat(ACTIVITY_BODY_MAX - LEAD.length + 1))
      expect(over.body).toHaveLength(ACTIVITY_BODY_MAX) // the limit itself did not move
      expect(over.body!.endsWith(ACTIVITY_UNREAD_MARKER)).toBe(true)
      expect(assessReply(over, true)).toMatchObject({ verdict: 'unverified', kind: null })
      expect(positive([over])).toBe(false)
    })

    it('an 8,000-character reply that is friendly at first and refuses at the end is NOT interest: unverified, signal reply_unverified', () => {
      const a = mk('Yes, interested, please send the quote for 500 crates. ' + FILLER.repeat(200) + LATE_REFUSAL)
      expect(a.body).toContain(ACTIVITY_UNREAD_MARKER)
      expect(a.body).not.toContain('remove us') // the refusal was not read...
      expect(assessReply(a, true)).toMatchObject({ verdict: 'unverified', kind: null, strictOptOut: false })
      expect(positive([a])).toBe(false) // ...and that is why nothing positive is inferred
      expect(signal(a)).toMatchObject({ signalType: 'reply_unverified', polarity: 'neutral' })
      expect(summariseInbound([a], NOW, undefined, true).replies).toEqual([]) // not listed as a reply that shows interest
    })

    it('a clear refusal inside the part that WAS read is kept (declined), even though the rest was cut - never a standalone opt-out', () => {
      const a = mk(LATE_REFUSAL + ' ' + FILLER.repeat(200))
      expect(a.body).toContain(ACTIVITY_UNREAD_MARKER)
      expect(assessReply(a, true)).toMatchObject({ verdict: 'declined', kind: 'opt_out', strictOptOut: false, strictPhrase: null })
      expect(signal(a)).toMatchObject({ signalType: 'reply_opt_out' })
    })

    it('&zwnj;&nbsp; padding carries no text: 24k of it does not hide the refusal that follows it (it is read, and it is a refusal)', () => {
      const a = mk('<p>Yes, please send a quote for 500 crates.</p>' + '&zwnj;&nbsp;'.repeat(2_000) + '<p>' + LATE_REFUSAL + '</p>')
      expect(a.body).not.toContain(ACTIVITY_UNREAD_MARKER)
      expect(a.body).toContain('remove us')
      expect(assessReply(a, true)).toMatchObject({ verdict: 'declined', kind: 'opt_out' })
      expect(positive([a])).toBe(false)
      // the same with the hidden word-splitters a sender may use inside the phrase
      expect(assessReply(mk('un&shy;sub&zwj;scribe'), true)).toMatchObject({ verdict: 'declined', kind: 'opt_out' })
    })

    it('padding that IS kept as characters (numeric invisible characters) and pushes the refusal past 6,000: unread, so unverified - never interest', () => {
      const a = mk('Yes, please send a quote for 500 crates. ' + '&#8204;'.repeat(7_000) + ' ' + LATE_REFUSAL)
      expect(a.body).toContain(ACTIVITY_UNREAD_MARKER)
      expect(assessReply(a, true).verdict).toBe('unverified')
      expect(positive([a])).toBe(false)
      expect(signal(a)).toMatchObject({ signalType: 'reply_unverified' })
    })

    it('&zwnj;&nbsp; padding beyond the 60,000 raw cut is unread as before: unverified', () => {
      const a = mk('Yes, please send a quote for 500 crates.' + '&zwnj;&nbsp;'.repeat(6_000) + LATE_REFUSAL)
      expect(a.body).toContain(ACTIVITY_UNREAD_MARKER)
      expect(assessReply(a, true).verdict).toBe('unverified')
      expect(positive([a])).toBe(false)
    })
  })

  it('a message that was read in full carries no marker and behaves as before', () => {
    const a = mk('Thanks, please send a quote for 500 crates by Friday.')
    expect(a.body).not.toContain(ACTIVITY_UNREAD_MARKER)
    expect(assessReply(a, true).verdict).toBe('interested')
    expect(summariseInbound([a], NOW, undefined, true).assessed).toHaveLength(1)
  })
})
