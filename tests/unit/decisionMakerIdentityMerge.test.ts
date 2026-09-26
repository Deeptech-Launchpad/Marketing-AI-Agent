import { describe, expect, it } from 'vitest'
import {
  assembleCandidates,
  firstNamesCompatible,
  groupDrafts,
  mergeDrafts,
} from '../../src/decisionmakers/candidates.js'
import type { CandidateDraft, CandidateEvidence } from '../../src/decisionmakers/types.js'
import type { CrmCompany } from '../../src/crm/types.js'

// ONE HUMAN, ONE CANDIDATE — HOWEVER EACH SOURCE HAPPENED TO KEY THEM.
//
// Sightings were grouped by a single key: provider ID, else profile URL, else
// name. A CRM contact carrying a LinkedIn URL was keyed by the URL, the same
// name read off a web page was keyed by the name, and the two never met — so
// one person appeared two or three times on the shortlist. Grouping now joins
// identical names (and unambiguous short forms) unless identifiers conflict.

const company: CrmCompany = {
  id: 'co_1',
  name: 'Acme Industrial Supply Ltd',
  email: null,
  emails: [],
  phone: null,
  domain: 'acme-industrial.example',
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
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}

const ev = (over: Partial<CandidateEvidence> = {}): CandidateEvidence => ({
  provider: 'crm_contacts',
  sourceType: 'crm_record',
  sourceUrl: null,
  snippet: 'NXT Sales contactPersons entry for this person, with a title.',
  observedAt: null,
  supports: ['name', 'title', 'company'],
  ...over,
})

const draft = (over: Partial<CandidateDraft> = {}): CandidateDraft => ({
  fullName: 'Pat Example',
  rawTitle: 'Ecommerce Manager',
  statedCompany: 'Acme Industrial Supply Ltd',
  profileUrl: null,
  providerPersonId: null,
  email: null,
  phone: null,
  location: null,
  evidence: [ev()],
  ...over,
})

describe('identical names join across ID, URL and name keys', () => {
  it('joins a URL-keyed CRM contact with a name-keyed web sighting of the same name', () => {
    const groups = groupDrafts(
      [
        draft({ fullName: 'Pat Example', profileUrl: 'https://www.linkedin.com/in/pat-example' }),
        draft({
          fullName: 'PAT EXAMPLE',
          evidence: [ev({ provider: 'public_web_research', sourceType: 'third_party' })],
        }),
      ],
      company.id,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.drafts).toHaveLength(2)
  })

  it('joins a Hunter sighting keyed by an email-shaped ID with the CRM person', () => {
    const scored = assembleCandidates(
      [
        draft({ fullName: 'Pat Example', profileUrl: 'https://www.linkedin.com/in/pat-example' }),
        draft({
          fullName: 'Pat Example',
          providerPersonId: 'pat.example@acme-industrial.example',
          rawTitle: null,
          evidence: [ev({ provider: 'hunter', sourceType: 'data_provider', supports: ['name', 'contact'] })],
        }),
      ],
      company,
      'acme-industrial.example',
    )
    expect(scored).toHaveLength(1)
    // Every sighting's evidence survives the merge.
    expect(scored[0]!.evidence.map((e) => e.provider).sort()).toEqual(['crm_contacts', 'hunter'])
  })

  it('keeps two people apart when they carry different profile URLs', () => {
    const groups = groupDrafts(
      [
        draft({ profileUrl: 'https://www.linkedin.com/in/pat-example-1' }),
        draft({ profileUrl: 'https://www.linkedin.com/in/pat-example-2' }),
      ],
      company.id,
    )
    expect(groups).toHaveLength(2)
  })

  it('keeps two people apart when one provider gave them different IDs', () => {
    const groups = groupDrafts(
      [
        draft({ providerPersonId: 'apollo:1', evidence: [ev({ provider: 'apollo', sourceType: 'data_provider' })] }),
        draft({ providerPersonId: 'apollo:2', evidence: [ev({ provider: 'apollo', sourceType: 'data_provider' })] }),
      ],
      company.id,
    )
    expect(groups).toHaveLength(2)
  })

  it('does not attach a name-only sighting to either of two conflicting people', () => {
    const groups = groupDrafts(
      [
        draft({ profileUrl: 'https://www.linkedin.com/in/pat-example-1' }),
        draft({ profileUrl: 'https://www.linkedin.com/in/pat-example-2' }),
        draft({ evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })] }),
      ],
      company.id,
    )
    expect(groups).toHaveLength(3)
  })

  it('does not join different IDs from different providers into a conflict', () => {
    const groups = groupDrafts(
      [
        draft({ providerPersonId: 'apollo:1', evidence: [ev({ provider: 'apollo', sourceType: 'data_provider' })] }),
        draft({ providerPersonId: 'zoominfo:9', evidence: [ev({ provider: 'zoominfo', sourceType: 'data_provider' })] }),
      ],
      company.id,
    )
    expect(groups).toHaveLength(1)
  })
})

describe('short forms join only when unambiguous', () => {
  it('recognises prefix and common short forms, never initials', () => {
    expect(firstNamesCompatible('chris', 'christopher')).toBe(true)
    expect(firstNamesCompatible('bob', 'robert')).toBe(true)
    expect(firstNamesCompatible('j', 'jane')).toBe(false)
    expect(firstNamesCompatible('jane', 'john')).toBe(false)
  })

  it('joins a short form and a full form with the same surname', () => {
    const groups = groupDrafts(
      [
        draft({ fullName: 'Chris Example', profileUrl: 'https://www.linkedin.com/in/chris-example' }),
        draft({
          fullName: 'Christopher Example',
          evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })],
        }),
      ],
      company.id,
    )
    expect(groups).toHaveLength(1)
  })

  it('leaves a short form alone when two full forms could claim it', () => {
    const groups = groupDrafts(
      [
        draft({ fullName: 'Chris Example' }),
        draft({ fullName: 'Christopher Example', evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })] }),
        draft({ fullName: 'Christine Example', evidence: [ev({ provider: 'apollo', sourceType: 'data_provider' })] }),
      ],
      company.id,
    )
    expect(groups).toHaveLength(3)
  })

  it('never joins different surnames', () => {
    const groups = groupDrafts([draft({ fullName: 'Chris Example' }), draft({ fullName: 'Christopher Other' })], company.id)
    expect(groups).toHaveLength(2)
  })

  it('merges three spellings of one person into one scored candidate', () => {
    const scored = assembleCandidates(
      [
        draft({ fullName: 'Chris Example', rawTitle: 'Director', profileUrl: 'https://www.linkedin.com/in/chris-example' }),
        draft({
          fullName: 'CHRIS EXAMPLE',
          rawTitle: null,
          evidence: [ev({ provider: 'public_web_research', sourceType: 'third_party', supports: ['name'] })],
        }),
        draft({
          fullName: 'Christopher Example',
          rawTitle: 'Managing Director',
          evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })],
        }),
      ],
      company,
      'acme-industrial.example',
    )
    expect(scored).toHaveLength(1)
    expect(scored[0]!.evidence).toHaveLength(3)
    // The equally-authoritative CRM "Director" does not beat the site's title.
    expect(scored[0]!.rawTitle).toBe('Managing Director')
  })
})

describe('title tie-break between equally authoritative sources', () => {
  it('prefers a title that names a relevant role over a bare one, whatever the input order', () => {
    const crm = draft({ rawTitle: 'Director' })
    const site = draft({
      rawTitle: 'Head of Ecommerce',
      evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })],
    })
    expect(mergeDrafts([crm, site]).rawTitle).toBe('Head of Ecommerce')
    expect(mergeDrafts([site, crm]).rawTitle).toBe('Head of Ecommerce')
  })

  it('prefers the more specific title when both or neither match a role group', () => {
    const a = draft({ rawTitle: 'Ecommerce Manager' })
    const b = draft({
      rawTitle: 'Senior Ecommerce Manager',
      evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })],
    })
    expect(mergeDrafts([a, b]).rawTitle).toBe('Senior Ecommerce Manager')
  })

  it('still lets a more authoritative source win over a better-sounding title', () => {
    const broker = draft({
      rawTitle: 'Head of Ecommerce',
      evidence: [ev({ provider: 'apollo', sourceType: 'data_provider' })],
    })
    const site = draft({
      rawTitle: 'Buyer',
      evidence: [ev({ provider: 'company_website', sourceType: 'company_website' })],
    })
    expect(mergeDrafts([broker, site]).rawTitle).toBe('Buyer')
  })
})

// A TITLE THAT NAMES A FUNCTION, AGAINST ONE THAT NAMES NONE.
//
// COH Sales: the CRM held "Director" for Liam Bonner, and a trade listing this
// service fetched calls him "Managing Director". Source rank put the CRM
// first, so the engine carried the title it could do nothing with and reported
// the company's managing director as having no relevant role. The two are not
// a disagreement - the second is the first, said precisely.
describe('a vague title never beats a precise one', () => {
  const crmSaid = (title: string) =>
    draft({ rawTitle: title, evidence: [ev({ provider: 'crm_contacts', sourceType: 'crm_record' })] })
  const pageSaid = (title: string) =>
    draft({
      rawTitle: title,
      evidence: [
        ev({
          provider: 'public_web_research',
          sourceType: 'third_party',
          sourceUrl: 'https://www.irishtrade.ie/c-9380-COH-Sales-Ltd',
          snippet: 'Liam Bonner, Managing Director',
        }),
      ],
    })

  it('carries the classifying title even from the lower-ranked source', () => {
    expect(mergeDrafts([crmSaid('Director'), pageSaid('Managing Director')]).rawTitle).toBe('Managing Director')
    expect(mergeDrafts([pageSaid('Managing Director'), crmSaid('Director')]).rawTitle).toBe('Managing Director')
  })

  it('keeps both sources on the record, so the weaker one is not erased', () => {
    const merged = mergeDrafts([crmSaid('Director'), pageSaid('Managing Director')])
    expect(merged.evidence).toHaveLength(2)
    expect(merged.evidence.map((e) => e.sourceType).sort()).toEqual(['crm_record', 'third_party'])
  })

  it('still prefers the authoritative source when both titles classify', () => {
    const merged = mergeDrafts([crmSaid('Ecommerce Manager'), pageSaid('Head of Procurement')])
    expect(merged.rawTitle).toBe('Ecommerce Manager')
  })

  it('invents no title when no source states a classifying one', () => {
    expect(mergeDrafts([crmSaid('Director'), pageSaid('Company Secretary')]).rawTitle).toBe('Director')
  })

  it('leaves a person nobody gave a title at all without one', () => {
    const merged = mergeDrafts([
      draft({ rawTitle: null, evidence: [ev({ supports: ['name'] })] }),
      draft({ rawTitle: null, evidence: [ev({ provider: 'public_web_research', sourceType: 'third_party', supports: ['name'] })] }),
    ])
    expect(merged.rawTitle).toBeNull()
  })
})
