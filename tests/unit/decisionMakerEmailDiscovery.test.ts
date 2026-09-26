import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CrmContactProvider,
  assignStoredEmails,
  matchStoredEmail,
} from '../../src/decisionmakers/providers/crmContactProvider.js'
import { HunterProvider } from '../../src/decisionmakers/providers/hunterProvider.js'
import { mergeDrafts } from '../../src/decisionmakers/candidates.js'
import { assignContactRoles } from '../../src/decisionmakers/contactRoles.js'
import type { CrmCompany } from '../../src/crm/types.js'
import type { DmProviderContext } from '../../src/decisionmakers/providers/provider.js'

// THE PERSON WHO HAD AN EMAIL ALL ALONG.
//
// "1stop Welding Shop" is a real NXT Sales record. It holds:
//
//   contactPersons  ["Lloyd Robertson - Managing Director"]
//   linkedProfiles  ["https://www.linkedin.com/in/lloyd-robertson-01759296/"]
//   email           "lloyd@aes-sales.com"
//   emails          ["lloyd@aes-sales.com"]
//
// Decision Maker Discovery found Lloyd, matched his LinkedIn profile, and then
// reported "No email address recorded". The address was sitting on the same
// row it had just read. TWO independent defects had to be fixed to get it out,
// and each one is pinned separately below, because either alone is enough to
// lose the address again:
//
//   1. THE SURNAME WAS MANDATORY. The matcher required the local part to
//      contain the surname, so "lloyd@" — a first-name mailbox, which is how
//      small businesses actually write addresses — matched nobody.
//
//   2. THE SAME ADDRESS COUNTED TWICE. NXT Sales stores the address in BOTH
//      `Company.email` and `Company.emails[]`, so the provider passed the
//      matcher ["lloyd@…", "lloyd@…"]. The rule "exactly one address may claim
//      a person" then saw two matches and refused. This is the worse of the
//      two: it disabled CRM email matching for 7,521 of the 7,914 company
//      records that hold both a contact person and an email, INCLUDING records
//      with a textbook "first.last@" address.
//
// What has NOT changed, and is re-pinned here: no address is ever constructed.
// Every address these tests accept existed in the source, character for
// character, before the matcher ran.

const company = (over: Partial<CrmCompany> = {}): CrmCompany =>
  ({
    id: 'cmp-1',
    name: 'Acme Supplies',
    email: null,
    emails: [],
    phone: '+61 2 8711 3520',
    domain: 'acme.test',
    industry: null,
    country: null,
    cms: null,
    leadStatus: null,
    status: null,
    remarks: null,
    notes: null,
    endPdpUrl: null,
    contactPersons: [],
    linkedProfiles: [],
    ownerId: null,
    ownerName: null,
    dealCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as CrmCompany

const ctx = (c: CrmCompany): DmProviderContext =>
  ({ company: c, companyDomain: c.domain, maxResults: 10 }) as DmProviderContext

const run = (c: CrmCompany) => new CrmContactProvider().search(ctx(c))

afterEach(() => vi.unstubAllGlobals())

// ── 1. The record that caused this ────────────────────────────────────────

describe('1stop Welding Shop — the real record, verbatim', () => {
  const oneStop = company({
    id: 'cms7flzgr0rhtqj76vgtvw5lz',
    name: '1stop Welding Shop',
    domain: '1stopweldingshop.com',
    contactPersons: ['Lloyd Robertson - Managing Director'],
    linkedProfiles: ['https://www.linkedin.com/in/lloyd-robertson-01759296/'],
    email: 'lloyd@aes-sales.com',
    emails: ['lloyd@aes-sales.com'],
  })

  it('gives Lloyd Robertson the address the CRM already held', async () => {
    const r = await run(oneStop)
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]!.fullName).toBe('Lloyd Robertson')
    expect(r.candidates[0]!.email).toBe('lloyd@aes-sales.com')
  })

  it('keeps his title and his profile alongside it', async () => {
    const r = await run(oneStop)
    expect(r.candidates[0]!.rawTitle).toBe('Managing Director')
    expect(r.candidates[0]!.profileUrl).toBe('https://www.linkedin.com/in/lloyd-robertson-01759296')
  })

  it('records the address as evidence, so it can be checked', async () => {
    const r = await run(oneStop)
    const ev = r.candidates[0]!.evidence[0]!
    expect(ev.supports).toContain('contact')
    expect(ev.snippet).toContain('lloyd@aes-sales.com')
    expect(ev.snippet).toContain('1stop Welding Shop')
  })

  // Defect 1, alone.
  it('accepts a first-name-only mailbox', () => {
    expect(matchStoredEmail('Lloyd Robertson', ['lloyd@aes-sales.com'])).toBe('lloyd@aes-sales.com')
  })

  // Defect 2, alone — and with a PERFECT address, to show the duplicate was
  // enough to lose it on its own.
  it('is not defeated by the same address stored twice', () => {
    expect(matchStoredEmail('Lloyd Robertson', ['lloyd@aes-sales.com', 'lloyd@aes-sales.com'])).toBe(
      'lloyd@aes-sales.com',
    )
    expect(
      matchStoredEmail('Lloyd Robertson', ['lloyd.robertson@aes-sales.com', 'lloyd.robertson@aes-sales.com']),
    ).toBe('lloyd.robertson@aes-sales.com')
  })

  it('de-duplicates case variants of one address', () => {
    expect(matchStoredEmail('Sam Carikci', ['sam@ac.test', 'Sam@AC.Test'])).toBe('sam@ac.test')
  })

  it('does not require the address to be on the company domain', () => {
    // aes-sales.com is not 1stopweldingshop.com. The address is still the one
    // the CRM stores for this company, and it is not our place to overrule the
    // record on the strength of a domain.
    expect(matchStoredEmail('Lloyd Robertson', ['lloyd@aes-sales.com'])).toContain('@aes-sales.com')
  })
})

// ── 2. A second real record: two people, two addresses ────────────────────

describe('Jamesco Trading Ltd — two contacts, each with their own address', () => {
  const jamesco = company({
    name: 'Jamesco Trading Ltd',
    domain: 'jamescotrading.com',
    contactPersons: ['Tyrone Pirotta - Executive Administrator', 'Mariella Mizzi - General Manager'],
    email: 'mariella.mizzi@jamescotrading.com',
    emails: ['mariella.mizzi@jamescotrading.com', 'tyrone.pirotta@jamescotrading.com'],
  })

  it('gives each person their own address, not the first one on the record', async () => {
    const r = await run(jamesco)
    const byName = Object.fromEntries(r.candidates.map((c) => [c.fullName, c.email]))
    expect(byName['Tyrone Pirotta']).toBe('tyrone.pirotta@jamescotrading.com')
    expect(byName['Mariella Mizzi']).toBe('mariella.mizzi@jamescotrading.com')
  })
})

// ── 3. What must still be refused ─────────────────────────────────────────

describe('a shared mailbox is nobody’s', () => {
  it('rejects every generic form', () => {
    for (const generic of [
      'info@acme.test',
      'sales@acme.test',
      'admin@acme.test',
      'hello@acme.test',
      'enquiries@acme.test',
      'support@acme.test',
      'accounts@acme.test',
      'office@acme.test',
      'orders@acme.test',
      'noreply@acme.test',
    ]) {
      expect(matchStoredEmail('Dana Reed', [generic]), generic).toBeNull()
    }
  })

  it('rejects a generic mailbox even when it happens to contain the name', () => {
    // "sales" is not a person called Sal, whatever the substring says.
    expect(matchStoredEmail('Sal Esposito', ['sales@acme.test'])).toBeNull()
  })

  // 1source Supply, verbatim: the only address on the record is a shared one.
  it('leaves both 1source Supply contacts without an address, and says why', async () => {
    const r = await run(
      company({
        name: '1source Supply',
        domain: '1sourcesupply.com',
        contactPersons: ['Brad Carpenter - Principal', 'Scott Cohen - CEO'],
        email: 'info@1sourcesupply.net',
        emails: ['info@1sourcesupply.net'],
      }),
    )
    expect(r.candidates.map((c) => c.email)).toEqual([null, null])
    expect(r.candidates[0]!.evidence[0]!.snippet).toContain('only shared mailbox(es)')
    expect(r.candidates[0]!.evidence[0]!.snippet).toContain('info@1sourcesupply.net')
    expect((r.metadata as Record<string, unknown>).genericMailboxesRejected).toEqual(['info@1sourcesupply.net'])
  })

  // Ac Cleaning, verbatim: a real personal address that belongs to neither of
  // the two named contacts.
  it('does not hand Ac Cleaning’s koulla@ address to Sam or Helen', async () => {
    const r = await run(
      company({
        name: 'Ac Cleaning',
        domain: 'accleaning.com.au',
        contactPersons: ['Sam Carikci - General Manager', 'Helen Kyriacou'],
        email: 'support@accleaning.com.au',
        emails: ['Support@Accleaning.Com.Au', 'koulla@accleaning.com.au', 'admin@accleaning.com.au'],
      }),
    )
    expect(r.candidates.every((c) => c.email === null)).toBe(true)
    expect(r.candidates[0]!.evidence[0]!.snippet).toContain('none of their local parts names this person')
  })
})

describe('nothing is ever constructed', () => {
  it('invents no address when the record holds none', async () => {
    const r = await run(company({ contactPersons: ['Dana Reed - Head of Ecommerce'], domain: 'acme.test' }))
    expect(r.candidates[0]!.email).toBeNull()
  })

  it('returns only addresses that were in the input, character for character', () => {
    const stored = ['dana.reed@acme.test']
    const got = matchStoredEmail('Dana Reed', stored)
    expect(stored).toContain(got)
  })

  it('refuses when two stored addresses name the same person equally well', () => {
    expect(matchStoredEmail('Dana Reed', ['d.reed@acme.test', 'dana.reed@acme.test'])).toBeNull()
  })

  it('refuses when one address could name either of two people', () => {
    // Two Lloyds on one record: "lloyd@" identifies neither.
    const out = assignStoredEmails(['Lloyd Robertson', 'Lloyd Smith'], ['lloyd@acme.test'])
    expect(out.get('Lloyd Robertson')!.email).toBeNull()
    expect(out.get('Lloyd Smith')!.email).toBeNull()
    expect(out.get('Lloyd Robertson')!.reason).toBe('ambiguous')
  })

  it('still rejects a surname lookalike', () => {
    expect(matchStoredEmail('Dana Reed', ['reeds@acme.test'])).toBeNull()
  })

  it('never attributes the company switchboard to a person', async () => {
    const r = await run(company({ contactPersons: ['Dana Reed - Buyer'], phone: '+61 2 8711 3520' }))
    expect(r.candidates[0]!.phone).toBeNull()
  })
})

// ── 4. Why there is no email, told apart ──────────────────────────────────

describe('the four reasons a person has no address are distinguishable', () => {
  const reasonFor = (names: string[], stored: string[]) =>
    [...assignStoredEmails(names, stored).values()].map((m) => m.reason)

  it('tells an empty record from a shared-mailbox-only one', () => {
    expect(reasonFor(['Dana Reed'], [])).toEqual(['no_address_on_record'])
    expect(reasonFor(['Dana Reed'], ['info@acme.test'])).toEqual(['generic_mailbox_only'])
  })

  it('tells "names somebody else" from "ambiguous"', () => {
    expect(reasonFor(['Dana Reed'], ['koulla@acme.test'])).toEqual(['no_address_names_this_person'])
    expect(reasonFor(['Dana Reed'], ['d.reed@acme.test', 'dana.reed@acme.test'])).toEqual(['ambiguous'])
  })

  it('reports a match as a match', () => {
    expect(reasonFor(['Dana Reed'], ['dana.reed@acme.test'])).toEqual(['matched'])
  })
})

// ── 5. Hunter ─────────────────────────────────────────────────────────────

function hunterReplies(body: unknown) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: unknown) => {
    calls.push(String(url))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

describe('Hunter contributes observed addresses only', () => {
  it('keeps a named person’s address, with the page it was seen on', async () => {
    const calls = hunterReplies({
      data: {
        organization: 'Acme Supplies Ltd',
        pattern: '{first}.{last}',
        emails: [
          {
            value: 'dana.reed@acme.test',
            type: 'personal',
            first_name: 'Dana',
            last_name: 'Reed',
            position: 'Head of Ecommerce',
            sources: [{ uri: 'https://acme.test/about/team', extracted_on: '2026-08-01', still_on_page: true }],
          },
        ],
      },
    })

    const r = await new HunterProvider().search(ctx(company()))
    expect(r.candidates[0]!.email).toBe('dana.reed@acme.test')
    expect(r.candidates[0]!.evidence[0]!.sourceUrl).toBe('https://acme.test/about/team')
    expect(calls).toHaveLength(1)
  })

  it('emits no candidate for a shared mailbox, and names it in the reason', async () => {
    hunterReplies({
      data: {
        organization: 'Acme Supplies Ltd',
        emails: [{ value: 'info@acme.test', type: 'generic', first_name: null, last_name: null, sources: [] }],
      },
    })

    const r = await new HunterProvider().search(ctx(company()))
    expect(r.candidates).toEqual([])
    expect(r.reason).toContain('info@acme.test')
    expect(r.reason).toContain('shared mailbox')
  })

  it('never calls email-finder, and never uses the pattern it is told', async () => {
    const calls = hunterReplies({
      data: {
        organization: 'Acme Supplies Ltd',
        // Hunter volunteering how to SYNTHESISE an address. It must be
        // recorded and never acted on.
        pattern: '{first}.{last}',
        emails: [],
      },
    })

    const r = await new HunterProvider().search(ctx(company()))
    expect(calls.every((u) => u.includes('/v2/domain-search'))).toBe(true)
    expect(calls.some((u) => /email-finder|email-verifier/.test(u))).toBe(false)
    expect(calls).toHaveLength(1)
    expect(r.candidates).toEqual([])
    expect((r.metadata as Record<string, unknown>).emailPatternHunterInferred).toBe('{first}.{last}')
    // The pattern is held as metadata and reaches no candidate.
    expect(JSON.stringify(r.candidates)).not.toContain('dana.reed@acme.test')
  })

  it('makes exactly one request per company and does not retry a failure', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ errors: [{ details: 'Too many requests.' }] }), { status: 429 })
    })
    const r = await new HunterProvider().search(ctx(company()))
    expect(calls).toHaveLength(1)
    expect(r.status).toBe('rate_limited')
    expect(r.candidates).toEqual([])
  })
})

// ── 6. A provider failure must not erase what the CRM already knew ────────

describe('a failing provider cannot take a known address with it', () => {
  const crmSighting = {
    fullName: 'Lloyd Robertson',
    rawTitle: 'Managing Director',
    statedCompany: '1stop Welding Shop',
    profileUrl: 'https://www.linkedin.com/in/lloyd-robertson-01759296',
    providerPersonId: null,
    email: 'lloyd@aes-sales.com',
    phone: null,
    location: null,
    evidence: [
      {
        provider: 'crm_contacts',
        sourceType: 'crm_record' as const,
        sourceUrl: null,
        snippet: 'NXT Sales record',
        observedAt: new Date('2026-08-06T07:32:31.807Z'),
        supports: ['name', 'company', 'title', 'profile_url', 'contact'] as Array<
          'name' | 'title' | 'company' | 'profile_url' | 'contact'
        >,
      },
    ],
  }

  const emptySighting = {
    ...crmSighting,
    profileUrl: null,
    email: null,
    evidence: [
      {
        provider: 'hunter',
        sourceType: 'data_provider' as const,
        sourceUrl: null,
        snippet: 'Hunter holds no email address for this domain.',
        observedAt: null,
        supports: ['name'] as Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'>,
      },
    ],
  }

  it('keeps the CRM address when a later provider returns nothing', () => {
    const merged = mergeDrafts([crmSighting, emptySighting])
    expect(merged.email).toBe('lloyd@aes-sales.com')
    expect(merged.profileUrl).toBe('https://www.linkedin.com/in/lloyd-robertson-01759296')
  })

  it('keeps it whichever order the providers answered in', () => {
    const merged = mergeDrafts([emptySighting, crmSighting])
    expect(merged.email).toBe('lloyd@aes-sales.com')
  })
})

// ── 7. Primary and alternative are unchanged by any of this ───────────────

describe('an alternative with an address never displaces the primary', () => {
  const person = (over: Record<string, unknown>) => ({
    identityKey: 'k',
    fullName: 'X',
    roleGroup: 'ecommerce',
    companyMatch: 'verified',
    email: null,
    phone: null,
    profileUrl: null,
    rank: 1,
    rankScore: 10,
    outcome: 'shortlisted',
    ...over,
  })

  it('keeps the top-ranked person as primary even when a lower one has an email', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Scott Cohen', rank: 1, email: null }),
      person({ identityKey: 'b', fullName: 'Brad Carpenter', rank: 2, email: 'brad@one.test', roleGroup: 'operations' }),
    ])
    expect(r.primaryKey).toBe('a')
    expect(r.alternativeKey).toBe('b')
  })

  it('says plainly when there is no second route', () => {
    const r = assignContactRoles([person({ identityKey: 'a', fullName: 'Lloyd Robertson', email: 'lloyd@aes.test' })])
    expect(r.primaryKey).toBe('a')
    expect(r.alternativeKey).toBeNull()
    expect(r.note).toContain('Only one person could be verified')
  })
})
