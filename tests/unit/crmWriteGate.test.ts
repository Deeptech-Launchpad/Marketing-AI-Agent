import { beforeEach, describe, expect, it, vi } from 'vitest'

// PRODUCTION CLOSURE — the CRM write gate.
//
// Team Answer Section 30 approves a controlled write adapter. These tests hold
// the line between "approved in principle" and "running": the default is OFF,
// and three things stay refused at every setting because the decision to allow
// them is not an operator's.

const envMock: Record<string, unknown> = {
  CRM_WRITE_ENABLED: false,
  CRM_WRITE_FIELD_INTENT_SCORE: '',
  CRM_WRITE_FIELD_QUALIFICATION_STATUS: '',
  CRM_WRITE_QUALIFICATION_VALUE_MAP: '',
}
vi.mock('../../src/config/env.js', async (orig) => {
  const actual = (await orig()) as { env: Record<string, unknown> }
  return { env: new Proxy(envMock, { get: (t, k: string) => (k in t ? t[k] : actual.env[k]) }) }
})

const { writeCapability, assertWritable, parseStatusMap, ForbiddenCrmWriteError, FORBIDDEN_FIELDS } = await import(
  '../../src/crmsync/writeGate.js'
)
const { QUALIFICATION_STATUSES } = await import('../../src/salesqualification/types.js')

/**
 * The display values confirmed for the live Qualification Status dropdown.
 *
 * Held here as a literal so a change to either side — our internal statuses or
 * the CRM's option labels — fails a test rather than a live write.
 */
const CONFIRMED_MAP =
  'not_qualified=Not Qualified;qualified=Qualified;qualified_unassigned=Qualified - Unassigned;de_qualified=De-qualified'

beforeEach(() => {
  envMock.CRM_WRITE_ENABLED = false
  envMock.CRM_WRITE_FIELD_INTENT_SCORE = ''
  envMock.CRM_WRITE_FIELD_QUALIFICATION_STATUS = ''
  envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = ''
})

describe('the default is off', () => {
  it('writes nothing until deliberately enabled', () => {
    const c = writeCapability()
    expect(c.enabled).toBe(false)
    expect(c.resources.companyFields.ready).toBe(false)
    expect(c.resources.activity.ready).toBe(false)
    expect(c.summary).toMatch(/reads NXT Sales and writes nothing/)
  })

  it('says the scope exists but is switched off, which is a different problem', () => {
    expect(writeCapability().summary).toMatch(/has not been switched on/)
  })
})

describe('enabling is not sufficient', () => {
  it('still blocks Company fields when no destination is configured', () => {
    envMock.CRM_WRITE_ENABLED = true
    const c = writeCapability()
    expect(c.enabled).toBe(true)
    expect(c.resources.companyFields.ready).toBe(false)
    expect(c.resources.companyFields.reason).toMatch(/not configured/)
    expect(c.resources.companyFields.reason).toMatch(/intentScore.*Number/)
  })

  it('names exactly which settings are missing', () => {
    envMock.CRM_WRITE_ENABLED = true
    envMock.CRM_WRITE_FIELD_INTENT_SCORE = 'intentScore'
    const c = writeCapability()
    expect(c.resources.companyFields.reason).toMatch(/CRM_WRITE_FIELD_QUALIFICATION_STATUS is not configured/)
    expect(c.resources.companyFields.reason).not.toMatch(/CRM_WRITE_FIELD_INTENT_SCORE is not/)
  })

  it('permits activities without a custom field, because they need none', () => {
    envMock.CRM_WRITE_ENABLED = true
    expect(writeCapability().resources.activity.ready).toBe(true)
  })

  it('reports ready once both destinations are named', () => {
    envMock.CRM_WRITE_ENABLED = true
    envMock.CRM_WRITE_FIELD_INTENT_SCORE = 'intentScore'
    envMock.CRM_WRITE_FIELD_QUALIFICATION_STATUS = 'qualificationStatus'
    envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = CONFIRMED_MAP
    const c = writeCapability()
    expect(c.resources.companyFields.ready).toBe(true)
    expect(c.summary).toMatch(/Writes enabled for the approved scope/)
  })
})

describe('the live dropdown constrains what may be written', () => {
  beforeEach(() => {
    envMock.CRM_WRITE_ENABLED = true
    envMock.CRM_WRITE_FIELD_INTENT_SCORE = 'intentScore'
    envMock.CRM_WRITE_FIELD_QUALIFICATION_STATUS = 'qualificationStatus'
  })

  it('blocks the write when no status is mapped to a dropdown option', () => {
    const c = writeCapability()
    expect(c.resources.companyFields.ready).toBe(false)
    expect(c.resources.companyFields.reason).toMatch(/is a dropdown on the live Company record/)
    expect(c.resources.companyFields.reason).toMatch(/Manage values/)
  })

  it('names exactly which statuses are unmapped', () => {
    envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = 'qualified=Qualified'
    const reason = writeCapability().resources.companyFields.reason
    expect(reason).toMatch(/qualified_unassigned/)
    expect(reason).toMatch(/not_qualified/)
    expect(reason).toMatch(/de_qualified/)
  })

  it('does not collapse two distinct statuses into one option by default', () => {
    // "qualified" and "qualified but nobody owns it" are deliberately separate
    // states. Defaulting them to the same option would erase that.
    envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = 'qualified=Qualified'
    expect(writeCapability().statusMap.get('qualified_unassigned')).toBeUndefined()
  })

  it('parses the mapping verbatim, because a dropdown matches exactly', () => {
    envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = 'qualified=Qualified (Hot Lead)'
    expect(writeCapability().statusMap.get('qualified')).toBe('Qualified (Hot Lead)')
  })
})

describe('what stays refused at every setting', () => {
  beforeEach(() => {
    // Fully enabled and configured — the strongest case for a leak.
    envMock.CRM_WRITE_ENABLED = true
    envMock.CRM_WRITE_FIELD_INTENT_SCORE = 'intentScore'
    envMock.CRM_WRITE_FIELD_QUALIFICATION_STATUS = 'qualificationStatus'
    envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = CONFIRMED_MAP
  })

  it('refuses an owner reassignment', () => {
    // NXT Sales' PUT /companies/:id DOES accept ownerId and applies it, so
    // this is checked rather than merely omitted.
    expect(() => assertWritable({ ownerId: 'cmrela8ow0001mgntynarnkw8' })).toThrow(ForbiddenCrmWriteError)
    expect(() => assertWritable({ ownerId: null })).toThrow(/Owner reassignment/)
  })

  it('refuses a deal stage or value', () => {
    expect(() => assertWritable({ stage: 'Negotiation' })).toThrow(ForbiddenCrmWriteError)
    expect(() => assertWritable({ dealValue: 50000 })).toThrow(ForbiddenCrmWriteError)
    expect(() => assertWritable({ amount: 1 })).toThrow(ForbiddenCrmWriteError)
  })

  it('refuses a forbidden field smuggled inside customFields', () => {
    expect(() => assertWritable({ customFields: { ownerId: 'x' } })).toThrow(/customFields.ownerId/)
  })

  it('permits the approved additive payload', () => {
    expect(() =>
      assertWritable({ customFields: { aiIntentScore: 100, aiQualificationStatus: 'qualified' } }),
    ).not.toThrow()
  })

  it('covers every field on the forbidden list', () => {
    for (const f of FORBIDDEN_FIELDS) {
      expect(() => assertWritable({ [f]: 'anything' }), f).toThrow(ForbiddenCrmWriteError)
    }
  })

  it('has no configuration that could turn the refusals off', async () => {
    // The refusal list is a constant, not an environment variable. If this
    // ever became configurable, the rule would be an operator's to disable.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/crmsync/writeGate.ts', import.meta.url), 'utf8'),
    )
    const forbiddenDecl = src.slice(src.indexOf('export const FORBIDDEN_FIELDS'), src.indexOf('export interface'))
    expect(forbiddenDecl).not.toMatch(/env\./)
  })
})


// ── THE CONFIRMED DROPDOWN MAPPING ─────────────────────────────────────────

describe('the confirmed Qualification Status mapping', () => {
  const map = () => parseStatusMap(CONFIRMED_MAP)

  it('maps every internal status to its confirmed display value', () => {
    expect(Object.fromEntries(map())).toEqual({
      not_qualified: 'Not Qualified',
      qualified: 'Qualified',
      qualified_unassigned: 'Qualified - Unassigned',
      de_qualified: 'De-qualified',
    })
  })

  it('covers the full status vocabulary, with nothing left over', () => {
    const m = map()
    for (const s of QUALIFICATION_STATUSES) expect(m.has(s), s).toBe(true)
    expect(m.size).toBe(QUALIFICATION_STATUSES.length)
  })

  it('keeps the four display values distinct', () => {
    // Two statuses sharing an option would make the CRM unable to show the
    // difference between them, which is the reason they are separate states.
    const values = [...map().values()]
    expect(new Set(values).size).toBe(values.length)
  })

  it('preserves the exact punctuation the dropdown contains', () => {
    const m = map()
    // A dropdown match is exact: "Qualified - Unassigned" is not
    // "Qualified-Unassigned", and "De-qualified" is not "De-Qualified".
    expect(m.get('qualified_unassigned')).toBe('Qualified - Unassigned')
    expect(m.get('de_qualified')).toBe('De-qualified')
    expect(m.get('de_qualified')).not.toBe('De-Qualified')
  })

  it('uses an ASCII hyphen, verified against the value copied from the live CRM', () => {
    // The live UI renders this dash wide enough to look like an en dash. It is
    // not: the value copied out of NXT Sales is U+002D. Asserted by codepoint
    // because the two are indistinguishable by eye and a dropdown match is
    // byte-exact — an en dash here would be a 400 on every write.
    const value = map().get('qualified_unassigned')!
    const dash = [...value].find((c) => /[-‐-―−]/.test(c))!
    expect(dash.codePointAt(0)).toBe(0x2d)
    expect(value).not.toContain('–')
    expect(value).not.toContain('—')

    // The full sequence, as copied from the live dropdown.
    expect([...value].map((c) => c.codePointAt(0))).toEqual([
      0x51, 0x75, 0x61, 0x6c, 0x69, 0x66, 0x69, 0x65, 0x64, 0x20, 0x2d, 0x20,
      0x55, 0x6e, 0x61, 0x73, 0x73, 0x69, 0x67, 0x6e, 0x65, 0x64,
    ])
  })

  it('keeps every option label plain ASCII', () => {
    // Any smart quote, non-breaking space or typographic dash sneaking into a
    // label would fail the same way, silently.
    for (const [status, label] of map()) {
      expect([...label].every((c) => c.codePointAt(0)! < 128), `${status} -> ${label}`).toBe(true)
    }
  })

  it('unblocks the Company field write once enabled', () => {
    envMock.CRM_WRITE_ENABLED = true
    envMock.CRM_WRITE_FIELD_INTENT_SCORE = 'intentScore'
    envMock.CRM_WRITE_FIELD_QUALIFICATION_STATUS = 'qualificationStatus'
    envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = CONFIRMED_MAP
    const c = writeCapability()
    expect(c.resources.companyFields.ready).toBe(true)
    expect(c.summary).toMatch(/Writes enabled for the approved scope/)
  })

  it('does not change the Company field key', () => {
    expect(CONFIRMED_MAP).not.toMatch(/qualificationStatus=/)
  })
})
