import { describe, expect, it, vi, afterEach } from 'vitest'
import { CrmContactProvider, matchStoredEmail } from '../../src/decisionmakers/providers/crmContactProvider.js'
import { assignContactRoles } from '../../src/decisionmakers/contactRoles.js'
import type { CrmCompany } from '../../src/crm/types.js'
import type { DmProviderContext } from '../../src/decisionmakers/providers/provider.js'

// WHERE A DECISION MAKER'S CONTACT DETAILS COME FROM.
//
// Four sources feed this stage, in order of how directly they witness the
// person: the CRM's own record, the company's own website, what Intent Signals
// already found, then the paid providers. The rule that governs all four is
// the same one, and it is the only rule that matters here:
//
//   AN ADDRESS IS EITHER SOMETHING A SOURCE STATED, OR IT IS NOTHING.
//
// There is no third case where a plausible address gets written down because
// it would be useful. No pattern, no concatenation, no first.last@domain.
//
// The gap these tests were written for: the CRM provider used to null every
// email and phone outright, on the correct grounds that info@company.com is
// not a person's address — and in doing so it threw away the real, per-person
// addresses NXT Sales already held, and sent the engine to a paid provider for
// something it already owned.

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
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...over,
  }) as CrmCompany

const ctx = (c: CrmCompany): DmProviderContext => ({
  tenantId: 't1',
  company: c,
  companyDomain: c.domain,
  maxResults: 10,
})

const run = (c: CrmCompany) => new CrmContactProvider().search(ctx(c))

afterEach(() => vi.unstubAllGlobals())

// ── 1. CRM contact email + LinkedIn reuse ─────────────────────────────────

describe('contact data already in NXT Sales is carried through', () => {
  const acme = company({
    contactPersons: ['Dana Reed, Head of Ecommerce'],
    emails: ['dana.reed@acme.test'],
    linkedProfiles: ['https://www.linkedin.com/in/dana-reed-4821/'],
  })

  it('attaches the stored address to the person it names', async () => {
    const r = await run(acme)
    expect(r.candidates[0]!.email).toBe('dana.reed@acme.test')
  })

  it('attaches the stored LinkedIn profile to the same person', async () => {
    const r = await run(acme)
    expect(r.candidates[0]!.profileUrl).toBe('https://www.linkedin.com/in/dana-reed-4821')
  })

  it('records both stored values as the evidence for the contact', async () => {
    const r = await run(acme)
    const snippet = r.candidates[0]!.evidence[0]!.snippet
    expect(snippet).toContain('dana.reed@acme.test')
    expect(snippet).toContain('linkedin.com/in/dana-reed')
    expect(r.candidates[0]!.evidence[0]!.supports).toContain('contact')
  })

  it('reports how much of the CRM’s own data was actually used', async () => {
    const r = await run(acme)
    expect(r.metadata?.withStoredEmail).toBe(1)
    expect(r.metadata?.withStoredProfile).toBe(1)
  })
})

// ── 2. No guessed email, ever ─────────────────────────────────────────────

describe('an address is stated or it is nothing', () => {
  it('leaves the address null when the CRM holds none', async () => {
    const r = await run(company({ contactPersons: ['Dana Reed, Head of Ecommerce'] }))
    expect(r.candidates[0]!.email).toBeNull()
  })

  // The exact failure mode: the domain is known, the name is known, and the
  // pattern of the one stored address is obvious. None of that is permission.
  it('does not build an address from a name and a domain', async () => {
    const r = await run(
      company({
        contactPersons: ['Dana Reed, Head of Ecommerce', 'Sam Okonjo, Operations Director'],
        emails: ['dana.reed@acme.test'],
      }),
    )
    const sam = r.candidates.find((c) => c.fullName === 'Sam Okonjo')!
    expect(sam.email).toBeNull()
  })

  it('never attributes a shared mailbox to a person', async () => {
    for (const shared of ['info@acme.test', 'sales@acme.test', 'accounts@acme.test', 'enquiries@acme.test']) {
      const r = await run(company({ contactPersons: ['Dana Reed'], emails: [shared] }))
      expect(r.candidates[0]!.email, shared).toBeNull()
    }
  })

  it('refuses a stored address that names somebody else', async () => {
    const r = await run(company({ contactPersons: ['Dana Reed'], emails: ['tom.crowhurst@acme.test'] }))
    expect(r.candidates[0]!.email).toBeNull()
  })

  it('refuses when two stored addresses could both be the person', async () => {
    const r = await run(
      company({ contactPersons: ['Dana Reed'], emails: ['d.reed@acme.test', 'dana.reed@acme.test'] }),
    )
    expect(r.candidates[0]!.email).toBeNull()
  })

  // The company switchboard is not this person's line.
  it('never attributes the company phone number to a person', async () => {
    const r = await run(company({ contactPersons: ['Dana Reed'], phone: '+61 2 8711 3520' }))
    expect(r.candidates[0]!.phone).toBeNull()
  })
})

describe('matching a stored address to a name', () => {
  const at = (name: string, stored: string[]) => matchStoredEmail(name, stored)

  it('accepts first.last, first_last and firstlast', () => {
    expect(at('Dana Reed', ['dana.reed@acme.test'])).toBe('dana.reed@acme.test')
    expect(at('Dana Reed', ['dana_reed@acme.test'])).toBe('dana_reed@acme.test')
    expect(at('Dana Reed', ['danareed@acme.test'])).toBe('danareed@acme.test')
  })

  it('accepts an initial with the surname', () => {
    expect(at('Dana Reed', ['dreed@acme.test'])).toBe('dreed@acme.test')
  })

  it('rejects a surname-only lookalike', () => {
    expect(at('Dana Reed', ['reeds@acme.test'])).toBeNull()
  })

  it('returns nothing for a name it cannot tokenise', () => {
    expect(at('', ['dana.reed@acme.test'])).toBeNull()
  })

  it('ignores anything that is not an address', () => {
    expect(at('Dana Reed', ['not an email', 'https://acme.test'])).toBeNull()
  })
})

// ── 3. The alternative decision maker ─────────────────────────────────────

describe('a second route into the same company', () => {
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

  it('prefers a different role group for the alternative', () => {
    const r = assignContactRoles([
      person({ identityKey: 'a', fullName: 'Dana Reed', roleGroup: 'ecommerce' }),
      person({ identityKey: 'b', fullName: 'Ben Ali', roleGroup: 'ecommerce', email: 'ben@acme.test' }),
      person({ identityKey: 'c', fullName: 'Cleo Nkemi', roleGroup: 'operations' }),
    ])
    expect(r.primaryKey).toBe('a')
    expect(r.alternativeKey).toBe('c')
    expect(r.note).toContain('different function')
  })

  it('says why there is no alternative when only one person was verified', () => {
    const r = assignContactRoles([person({ identityKey: 'a', fullName: 'Dana Reed' })])
    expect(r.alternativeKey).toBeNull()
    expect(r.note).toContain('Only one person could be verified')
  })
})

// ── 4. Cross-company isolation ────────────────────────────────────────────

describe('one company’s contacts never reach another', () => {
  it('reads only the company it was given', async () => {
    const acme = await run(
      company({ id: 'cmp-acme', name: 'Acme', contactPersons: ['Dana Reed'], emails: ['dana.reed@acme.test'] }),
    )
    const other = await run(
      company({ id: 'cmp-other', name: 'Other Ltd', contactPersons: ['Sam Okonjo'], emails: ['sam.okonjo@other.test'] }),
    )

    expect(acme.candidates.map((c) => c.fullName)).toEqual(['Dana Reed'])
    expect(other.candidates.map((c) => c.fullName)).toEqual(['Sam Okonjo'])
    expect(JSON.stringify(acme)).not.toContain('other.test')
    expect(JSON.stringify(other)).not.toContain('acme.test')
  })

  it('names the company each candidate was read from', async () => {
    const r = await run(company({ id: 'cmp-acme', name: 'Acme', contactPersons: ['Dana Reed'] }))
    expect(r.candidates[0]!.statedCompany).toBe('Acme')
    expect(r.candidates[0]!.evidence[0]!.snippet).toContain('cmp-acme')
  })
})

// ── 5. Website person discovery, and a provider-sourced address ──────────
//
// Two sources that already worked, pinned here because this file is now the
// place that says where a decision maker's details are allowed to come from.

describe('a person the company published on its own website', () => {
  it('reads a name and role from a team page and keeps the line as evidence', async () => {
    const { extractPeople } = await import('../../src/decisionmakers/peopleExtraction.js')
    const people = extractPeople(
      ['Our Team', 'Dana Reed, Head of Ecommerce', 'Sam Okonjo — Operations Director', 'Unit 4, Somewhere Road'].join(
        '\n',
      ),
    )
    expect(people.map((p) => p.name)).toEqual(['Dana Reed', 'Sam Okonjo'])
    expect(people[0]!.title).toBe('Head of Ecommerce')
    expect(people[0]!.snippet).toContain('Dana Reed, Head of Ecommerce')
  })

  it('does not turn an address line into a person', async () => {
    const { extractPeople } = await import('../../src/decisionmakers/peopleExtraction.js')
    expect(extractPeople('Unit 4, Somewhere Road\nSydney, NSW 2000')).toEqual([])
  })
})

describe('an address a provider actually stated', () => {
  it('is carried through with the pages the provider saw it on', async () => {
    const { HunterProvider } = await import('../../src/decisionmakers/providers/hunterProvider.js')
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          data: {
            organization: 'Acme Supplies Ltd',
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
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const r = await new HunterProvider().search(ctx(company()))
    expect(r.candidates[0]!.email).toBe('dana.reed@acme.test')
    expect(r.candidates[0]!.evidence[0]!.sourceUrl).toBe('https://acme.test/about/team')
    expect(r.candidates[0]!.evidence[0]!.supports).toContain('contact')
  })
})
