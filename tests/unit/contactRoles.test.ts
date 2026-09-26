import { describe, expect, it } from 'vitest'
import { assignContactRoles, statedOrNotFound, type ContactRoleInput } from '../../src/decisionmakers/contactRoles.js'

// WHO TO CALL, AND WHO TO CALL WHEN THAT FAILS.
//
// The shortlist was already ranked. What it never said was which name a
// salesperson should act on, which left that judgement to be made again by
// every person who opened the screen.
//
// The alternative is the part worth testing. "The next row down" is the
// obvious implementation and the wrong one: a second person with the same job
// in the same team is unreachable for the same reasons as the first, so it is
// not a fallback at all.

const person = (over: Partial<ContactRoleInput> & { identityKey: string; fullName: string }): ContactRoleInput => ({
  roleGroup: 'ecommerce',
  companyMatch: 'verified',
  email: null,
  phone: null,
  profileUrl: null,
  rank: 1,
  rankScore: 50,
  outcome: 'shortlisted',
  ...over,
})

describe('naming a primary and an alternative contact', () => {
  it('takes the top of the existing rank order as primary, without re-ranking', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Ada', rank: 1, rankScore: 10 }),
      // A higher score further down: the engine's rank order wins, because two
      // orderings in one system will eventually disagree.
      person({ identityKey: 'b', fullName: 'Ben', rank: 2, rankScore: 90 }),
    ])
    expect(r.primaryKey).toBe('a')
  })

  it('prefers a different function for the alternative', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Ada', roleGroup: 'ecommerce' }),
      person({ identityKey: 'b', fullName: 'Ben', roleGroup: 'ecommerce', email: 'ben@acme.test' }),
      person({ identityKey: 'c', fullName: 'Cleo', roleGroup: 'operations' }),
    ])
    // Ben has an email and Cleo does not; Cleo still wins, because a different
    // function is a different route in and an email is not.
    expect(r.alternativeKey).toBe('c')
    expect(r.note).toContain('different function')
  })

  it('falls back to a reachable person when every role group is the same', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Ada', roleGroup: 'ecommerce' }),
      person({ identityKey: 'b', fullName: 'Ben', roleGroup: 'ecommerce' }),
      person({ identityKey: 'c', fullName: 'Cleo', roleGroup: 'ecommerce', email: 'cleo@acme.test' }),
    ])
    expect(r.alternativeKey).toBe('c')
  })

  it('still names an alternative when nobody has a contact detail', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Ada', roleGroup: 'ecommerce' }),
      person({ identityKey: 'b', fullName: 'Ben', roleGroup: 'ecommerce' }),
    ])
    expect(r.alternativeKey).toBe('b')
    expect(r.note).toContain('No contact detail was stated')
  })

  // "There is no alternative" and "we did not look" are different facts, and
  // the person planning the approach needs the difference.
  it('says why there is no alternative when only one person was verified', () => {
    const r = assignContactRoles([person({ identityKey: 'a', fullName: 'Ada' })])
    expect(r.primaryKey).toBe('a')
    expect(r.alternativeKey).toBeNull()
    expect(r.note).toContain('Only one person could be verified')
  })

  it('names nobody when nothing was shortlisted', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Ada', outcome: 'excluded' }),
    ])
    expect(r.primaryKey).toBeNull()
    expect(r.alternativeKey).toBeNull()
  })

  it('never designates an excluded candidate', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Ada' }),
      person({ identityKey: 'x', fullName: 'Excluded', roleGroup: 'finance', outcome: 'excluded' }),
      person({ identityKey: 'b', fullName: 'Ben', roleGroup: 'operations' }),
    ])
    expect(r.alternativeKey).toBe('b')
  })

  it('does not designate the same person twice', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Ada' }),
      person({ identityKey: 'a', fullName: 'Ada (duplicate row)' }),
    ])
    expect(r.alternativeKey).toBeNull()
  })
})

describe('an unstated contact detail', () => {
  it('reads as "Not found" rather than as a blank', () => {
    expect(statedOrNotFound(null)).toBe('Not found')
    expect(statedOrNotFound('')).toBe('Not found')
    expect(statedOrNotFound('   ')).toBe('Not found')
  })

  it('passes a stated value through untouched', () => {
    expect(statedOrNotFound('ada@acme.test')).toBe('ada@acme.test')
  })
})
