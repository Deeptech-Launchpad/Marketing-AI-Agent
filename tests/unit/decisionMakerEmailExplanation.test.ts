import { describe, expect, it } from 'vitest'
import { crmEmailOutcomeFor, explainEmail } from '../../src/decisionmakers/emailExplanation.js'

// THE EMAIL LINE SAYS ONLY WHAT IS TRUE OF THAT ADDRESS.
//
// Two defects: every stored address was said to be linked "because the address
// itself names them", which is only how the CRM and published-page matchers
// work; and the CRM's per-contact outcome was looked up by the MERGED full
// name, which after merging is often a fuller form than the CRM entry used.

const crmResults = (emailOutcomes: Record<string, string>, genericMailboxesRejected: string[] = []) => [
  { provider: 'crm_contacts', status: 'available', metadata: { emailOutcomes, genericMailboxesRejected } },
]

describe('where an address came from', () => {
  it('says a CRM address names the person', () => {
    const r = explainEmail(
      {
        fullName: 'Pat Example',
        email: 'pat.example@acme.test',
        evidence: [{ provider: 'crm_contacts', supports: ['name', 'contact'], snippet: 'entry' }],
      },
      [],
    )
    expect(r.note).toMatch(/because the address itself names them/)
  })

  it('does not claim a data provider’s address names the person', () => {
    const r = explainEmail(
      {
        fullName: 'Pat Example',
        email: 'pe@acme.test',
        evidence: [{ provider: 'apollo', supports: ['name', 'contact'], snippet: 'Apollo record pe@acme.test' }],
      },
      [],
    )
    expect(r.source).toBe('apollo')
    expect(r.note).not.toMatch(/names them/)
    expect(r.note).toMatch(/recorded by that source/)
  })

  it('credits the source whose evidence carries the exact address', () => {
    const r = explainEmail(
      {
        fullName: 'Pat Example',
        email: 'pat.example@acme.test',
        evidence: [
          { provider: 'crm_contacts', supports: ['name', 'contact'], snippet: 'entry with other@acme.test' },
          { provider: 'hunter', supports: ['name', 'contact'], snippet: 'Hunter recorded pat.example@acme.test' },
        ],
      },
      [],
    )
    expect(r.source).toBe('hunter')
  })

  it('explains an address withheld by the storage policy as a policy decision', () => {
    const r = explainEmail(
      { fullName: 'Pat Example', email: null, evidence: [], contactability: 'withheld_by_policy' },
      [],
    )
    expect(r.found).toBe(false)
    expect(r.note).toMatch(/DM_STORE_CONTACT_DATA is off/)
  })
})

describe('finding the CRM outcome for a merged person', () => {
  it('matches a fuller merged name to the CRM entry’s shorter form', () => {
    expect(
      crmEmailOutcomeFor(
        { fullName: 'Pat A. Example', evidence: [] },
        { 'Pat Example': 'generic_mailbox_only', 'Lee Other': 'ambiguous' },
      ),
    ).toBe('generic_mailbox_only')
  })

  it('uses the name named in the candidate’s own CRM evidence when the merged name differs', () => {
    expect(
      crmEmailOutcomeFor(
        {
          fullName: 'Patrick Example',
          evidence: [{ provider: 'crm_contacts', snippet: 'contactPersons entry: "Pat Example - Director"' }],
        },
        { 'Pat Example': 'no_address_names_this_person', 'Lee Other': 'ambiguous' },
      ),
    ).toBe('no_address_names_this_person')
  })

  it('returns nothing rather than another person’s outcome when it is ambiguous', () => {
    expect(
      crmEmailOutcomeFor({ fullName: 'Pat Example', evidence: [] }, { 'Pat J Example': 'ambiguous', 'Pat K Example': 'generic_mailbox_only' }),
    ).toBeUndefined()
  })

  it('drives the explanation end to end', () => {
    const r = explainEmail(
      { fullName: 'Pat A. Example', email: null, evidence: [] },
      crmResults({ 'Pat Example': 'generic_mailbox_only' }, ['info@acme.test']),
    )
    expect(r.note).toMatch(/shared mailbox\(es\) — info@acme.test/)
  })
})
