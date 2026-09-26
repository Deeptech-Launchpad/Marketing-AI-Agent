import { describe, expect, it } from 'vitest'
import { env } from '../../src/config/env.js'
import { nameFromEmail, preparedBySignatory } from '../../src/websiteaudit/customerReport.js'

// WHO THE REPORT SAYS PREPARED IT.
//
// A report is handed over by a person, so the person who asked for the copy
// signs it. Two rules keep that honest:
//
//   · the configured signatory keeps their role and direct number, matched on
//     their own email address — and still signs a copy produced with no user
//     behind it;
//   · anybody else gets their OWN name and address only. A colleague's job
//     title and mobile number are not theirs to carry, and no role is invented.

describe('the "Prepared by" block', () => {
  it('falls back to the configured signatory when no user asked (a scheduled render)', () => {
    expect(preparedBySignatory(undefined).name).toBe(env.REPORT_PREPARED_BY_NAME)
    expect(preparedBySignatory(null).role).toBe(env.REPORT_PREPARED_BY_ROLE)
  })

  it('names the signed-in person who asked for the copy', () => {
    const s = preparedBySignatory({ name: 'Manikandan S', email: 'manikandan@altiusnxt.com' })
    expect(s.name).toBe('Manikandan S')
    expect(s.email).toBe('manikandan@altiusnxt.com')
  })

  it('keeps the configured role and phone for the person they describe', () => {
    const s = preparedBySignatory({ name: 'Someone Else', email: env.REPORT_PREPARED_BY_EMAIL.toUpperCase() })
    expect(s.name).toBe(env.REPORT_PREPARED_BY_NAME)
    expect(s.role).toBe(env.REPORT_PREPARED_BY_ROLE)
    expect(s.phone).toBe(env.REPORT_PREPARED_BY_PHONE || null)
  })

  it('never puts another person\u2019s title or direct number against a different signer', () => {
    const s = preparedBySignatory({ name: 'Jey Kumar', email: 'jey@deeptechskills.com' })
    expect(s.role).toBe('')
    expect(s.phone).toBeNull()
    // The company and website are the business's own, so they stay.
    expect(s.company).toBe(env.REPORT_PREPARED_BY_COMPANY)
    expect(s.web).toBe(env.REPORT_PREPARED_BY_WEB || null)
  })

  it('reads a name out of the address when the account has none', () => {
    expect(preparedBySignatory({ name: '', email: 'manikandan.s@altiusnxt.com' }).name).toBe('Manikandan S')
    expect(nameFromEmail('anna-maria.rossi@example.test')).toBe('Anna Maria Rossi')
    expect(nameFromEmail('sales_team2@example.test')).toBe('Sales Team')
  })
})
