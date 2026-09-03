import { beforeEach, describe, expect, it, vi } from 'vitest'

// VALIDATION — the exact body that would reach NXT Sales, and the human gate
// in front of it.
//
// The live Company record carries:
//   Intent Score          Number     key intentScore
//   Qualification Status  Dropdown   key qualificationStatus
//
// A dropdown match is exact, so most of what follows is about the difference
// between a value that looks right and a value that IS right.

const CONFIRMED_MAP =
  'not_qualified=Not Qualified;qualified=Qualified;qualified_unassigned=Qualified - Unassigned;de_qualified=De-qualified'

const envMock: Record<string, unknown> = {
  CRM_WRITE_ENABLED: false,
  CRM_WRITE_FIELD_INTENT_SCORE: 'intentScore',
  CRM_WRITE_FIELD_QUALIFICATION_STATUS: 'qualificationStatus',
  CRM_WRITE_QUALIFICATION_VALUE_MAP: CONFIRMED_MAP,
}
vi.mock('../../src/config/env.js', async (orig) => {
  const actual = (await orig()) as { env: Record<string, unknown> }
  return { env: new Proxy(envMock, { get: (t, k: string) => (k in t ? t[k] : actual.env[k]) }) }
})

const { planCompanyWrite } = await import('../../src/crmsync/companyWrite.js')

const COMPANY = 'cms7fiyww06pnqj76gap3d9r4' // 1st Ayd

beforeEach(() => {
  envMock.CRM_WRITE_ENABLED = false
  envMock.CRM_WRITE_FIELD_INTENT_SCORE = 'intentScore'
  envMock.CRM_WRITE_FIELD_QUALIFICATION_STATUS = 'qualificationStatus'
  envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = CONFIRMED_MAP
})

const enabled = () => {
  envMock.CRM_WRITE_ENABLED = true
}

// ── 1. NOTHING IS PLANNED WHILE WRITES ARE OFF ─────────────────────────────

describe('the write gate still governs the payload', () => {
  it('plans nothing while CRM_WRITE_ENABLED is false', () => {
    const p = planCompanyWrite(COMPANY, { intentScore: 100, qualificationStatus: 'qualified_unassigned' })
    expect(p.ready).toBe(false)
    expect(p.body).toBeNull()
    expect(p.request).toBeNull()
    expect(p.reason).toMatch(/CRM_WRITE_ENABLED is off/)
  })
})

// ── 2. THE EXACT BODY ──────────────────────────────────────────────────────

describe('the request body', () => {
  beforeEach(enabled)

  it('is a PUT against the company, carrying only customFields', () => {
    const p = planCompanyWrite(COMPANY, { intentScore: 100, qualificationStatus: 'qualified_unassigned' })
    expect(p.ready).toBe(true)
    expect(p.request).toEqual({ method: 'PUT', path: `/api/companies/${COMPANY}` })
    expect(Object.keys(p.body!)).toEqual(['customFields'])
  })

  it('carries exactly the two confirmed fields, under their exact keys', () => {
    const p = planCompanyWrite(COMPANY, { intentScore: 100, qualificationStatus: 'qualified_unassigned' })
    expect(p.body!.customFields).toEqual({
      intentScore: 100,
      qualificationStatus: 'Qualified - Unassigned',
    })
  })

  it('sends the score as a Number, because the field is a Number', () => {
    const p = planCompanyWrite(COMPANY, { intentScore: 87, qualificationStatus: 'qualified' })
    expect(typeof p.body!.customFields.intentScore).toBe('number')
    expect(p.body!.customFields.intentScore).toBe(87)
  })

  it('translates every internal status to its live option', () => {
    for (const [internal, option] of [
      ['not_qualified', 'Not Qualified'],
      ['qualified', 'Qualified'],
      ['qualified_unassigned', 'Qualified - Unassigned'],
      ['de_qualified', 'De-qualified'],
    ] as const) {
      const p = planCompanyWrite(COMPANY, { intentScore: 50, qualificationStatus: internal })
      expect(p.body!.customFields.qualificationStatus, internal).toBe(option)
    }
  })

  it('never sends the internal status through untranslated', () => {
    // Sending "qualified_unassigned" at a dropdown that offers
    // "Qualified - Unassigned" is a 400, and an easy mistake to make.
    const p = planCompanyWrite(COMPANY, { intentScore: 100, qualificationStatus: 'qualified_unassigned' })
    expect(JSON.stringify(p.body)).not.toContain('qualified_unassigned')
    expect(JSON.stringify(p.body)).not.toMatch(/"de_qualified"|"not_qualified"/)
  })

  it('touches no field a salesperson maintains', () => {
    const p = planCompanyWrite(COMPANY, { intentScore: 100, qualificationStatus: 'qualified' })
    const json = JSON.stringify(p.body)
    for (const field of ['ownerId', 'leadStatus', 'name', 'industry', 'domain', 'remarks', 'stage', 'value']) {
      expect(json, field).not.toContain(field)
    }
  })

  it('is a partial update, so unnamed columns keep their values', () => {
    // NXT Sales applies each field only when it is !== undefined, so a body
    // with one key cannot blank anything else.
    const p = planCompanyWrite(COMPANY, { intentScore: 1, qualificationStatus: 'qualified' })
    expect(Object.keys(p.body!)).toHaveLength(1)
  })
})

// ── 3. IT REFUSES RATHER THAN SENDING SOMETHING THAT WILL FAIL ─────────────

describe('refusals', () => {
  beforeEach(enabled)

  it('refuses a status with no configured option', () => {
    const p = planCompanyWrite(COMPANY, { intentScore: 100, qualificationStatus: 'some_new_status' })
    expect(p.ready).toBe(false)
    expect(p.body).toBeNull()
    expect(p.reason).toMatch(/no configured option/)
  })

  it('refuses a score outside the range the field holds', () => {
    for (const score of [-1, 101, Number.NaN]) {
      const p = planCompanyWrite(COMPANY, { intentScore: score, qualificationStatus: 'qualified' })
      expect(p.ready, String(score)).toBe(false)
    }
  })

  it('refuses when the dropdown mapping is incomplete', () => {
    envMock.CRM_WRITE_QUALIFICATION_VALUE_MAP = 'qualified=Qualified'
    const p = planCompanyWrite(COMPANY, { intentScore: 100, qualificationStatus: 'qualified' })
    expect(p.ready).toBe(false)
    expect(p.reason).toMatch(/dropdown/)
  })

  it('rounds a fractional score rather than sending a decimal', () => {
    const p = planCompanyWrite(COMPANY, { intentScore: 87.6, qualificationStatus: 'qualified' })
    expect(p.body!.customFields.intentScore).toBe(88)
  })
})

// ── 4. THE HUMAN GATE, END TO END ──────────────────────────────────────────

describe('the human approval flow', () => {
  const src = () =>
    import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/crmsync/service.ts', import.meta.url), 'utf8'),
    )

  it('stops a deliverable package at awaiting_user_approval', async () => {
    const s = await src()
    expect(s).toMatch(/state = 'awaiting_user_approval'/)
    expect(s).toMatch(/CRM updates require a person to review and approve/)
  })

  it('reaches delivery only through an explicit approval', async () => {
    const s = await src()
    const gate = s.indexOf("} else if (!options.userApproval) {")
    const deliver = s.indexOf('await attemptDelivery(')
    expect(gate).toBeGreaterThan(-1)
    expect(deliver).toBeGreaterThan(gate)
  })

  it('has exactly one place that supplies an approval', async () => {
    const s = await src()
    expect([...s.matchAll(/userApproval:\s*\{/g)]).toHaveLength(1)
  })

  it('records who approved and who declined', async () => {
    const s = await src()
    expect(s).toMatch(/crm_sync\.approved_by_user/)
    expect(s).toMatch(/crm_sync\.rejected_by_user/)
  })

  it('refuses to approve anything not awaiting a decision', async () => {
    const s = await src()
    expect(s).toMatch(/not awaiting a decision/)
  })
})
