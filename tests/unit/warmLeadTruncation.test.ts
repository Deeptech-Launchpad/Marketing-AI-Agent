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

  it('a message that was read in full carries no marker and behaves as before', () => {
    const a = mk('Thanks, please send a quote for 500 crates by Friday.')
    expect(a.body).not.toContain(ACTIVITY_UNREAD_MARKER)
    expect(assessReply(a, true).verdict).toBe('interested')
    expect(summariseInbound([a], NOW, undefined, true).assessed).toHaveLength(1)
  })
})
