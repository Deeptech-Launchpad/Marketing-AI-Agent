import { describe, expect, it, vi } from 'vitest'

// A COMPANY EMAIL WHEN THE DECISION MAKER HAS NONE — only a shared company
// mailbox that a reliable public source states, on the company's own domain,
// whose domain receives mail. Never guessed, never another person's inbox.

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../../src/platform/logger.js', () => ({ logger: { ...quiet, child: () => quiet } }))
vi.mock('../../src/platform/db.js', () => ({ prisma: {} }))

const { emailsOnPage, pickMailbox, findCompanyContactEmail, storedCompanyContactEmail, companyContactRow } = await import(
  '../../src/decisionmakers/companyContactEmail.js'
)

const page = (html: string, url: string) => ({ ok: true, status: 200, finalUrl: url, html, contentType: 'text/html', reason: null, durationMs: 1, bytes: html.length })
const missing = (url: string) => ({ ok: false, status: 404, finalUrl: url, html: '', contentType: null, reason: 'not found', durationMs: 1, bytes: 0 })
const siteFrom = (pages: Record<string, string>) => async (url: string) => (pages[url] ? page(pages[url]!, url) : missing(url)) as never
const mxYes = async () => true

describe('reading and choosing a company mailbox', () => {
  it('reads mailto links and addresses written on the page', () => {
    const html = '<a href="mailto:Sales%40acmemed.com.mt?subject=Hi">Email us</a><p>Or write to info@acmemed.com.mt today.</p>'
    expect(emailsOnPage(html).sort()).toEqual(['info@acmemed.com.mt', 'sales@acmemed.com.mt'])
  })

  it('prefers sales@, uses only shared mailboxes on the company domain, and refuses the rest', () => {
    const d = 'acmemed.com.mt'
    expect(pickMailbox(['info@acmemed.com.mt', 'sales@acmemed.com.mt'], d)).toBe('sales@acmemed.com.mt')
    // A named person's address is theirs, not the decision maker's.
    expect(pickMailbox(['maria.borg@acmemed.com.mt'], d)).toBeNull()
    // Not for a sales conversation.
    expect(pickMailbox(['careers@acmemed.com.mt', 'noreply@acmemed.com.mt', 'privacy@acmemed.com.mt', 'billing@acmemed.com.mt'], d)).toBeNull()
    // Another company's domain, or free mail.
    expect(pickMailbox(['info@otherco.com', 'info@gmail.com'], d)).toBeNull()
  })
})

describe('finding a verified company mailbox', () => {
  it('uses the company’s own website first — the contact page it links to when the homepage has none', async () => {
    const r = await findCompanyContactEmail({
      company: null,
      companyDomain: 'acmemed.com.mt',
      fetch: siteFrom({
        'https://acmemed.com.mt/': '<a href="/contact-us">Contact us</a>',
        'https://acmemed.com.mt/contact-us': '<p>Enquiries: enquiries@acmemed.com.mt</p>',
      }),
      mx: mxYes,
    })
    expect(r.found).toMatchObject({ email: 'enquiries@acmemed.com.mt', source: 'company_website', sourceUrl: 'https://acmemed.com.mt/contact-us' })
    expect(r.found!.evidence).toMatch(/receives mail/)
  })

  it('falls back to a shared mailbox Hunter observed on a public page, then to the NXT Sales record', async () => {
    const noSite = siteFrom({ 'https://acmemed.com.mt/': '<p>Welcome</p>' })
    const hunter = await findCompanyContactEmail({
      company: null,
      companyDomain: 'acmemed.com.mt',
      hunterMailboxes: [{ email: 'info@acmemed.com.mt', sources: ['https://directory.test/acme'] }],
      fetch: noSite,
      mx: mxYes,
    })
    expect(hunter.found).toMatchObject({ email: 'info@acmemed.com.mt', source: 'hunter_public_page', sourceUrl: 'https://directory.test/acme' })

    const crm = await findCompanyContactEmail({ company: { email: 'sales@acmemed.com.mt', emails: [] }, companyDomain: 'acmemed.com.mt', fetch: noSite, mx: mxYes })
    expect(crm.found).toMatchObject({ email: 'sales@acmemed.com.mt', source: 'crm_record', sourceUrl: null })
  })

  it('refuses an address whose domain receives no mail', async () => {
    const r = await findCompanyContactEmail({
      company: null,
      companyDomain: 'acmemed.com.mt',
      fetch: siteFrom({ 'https://acmemed.com.mt/': '<p>info@acmemed.com.mt</p>' }),
      mx: async () => false,
    })
    expect(r.found).toBeNull()
  })

  it('finds nothing — and guesses nothing — when no source states a company mailbox', async () => {
    const r = await findCompanyContactEmail({
      company: { email: null, emails: [] },
      companyDomain: 'acmemed.com.mt',
      fetch: siteFrom({ 'https://acmemed.com.mt/': '<p>Call us on 2123 4567. Maria Borg, Director: maria.borg@acmemed.com.mt</p>' }),
      mx: mxYes,
    })
    expect(r.found).toBeNull()
    expect(r.reason).toMatch(/none was guessed/)
  })

  it('stores what it found on the run, and reads it back', async () => {
    const r = await findCompanyContactEmail({ company: null, companyDomain: 'acmemed.com.mt', fetch: siteFrom({ 'https://acmemed.com.mt/': '<p>sales@acmemed.com.mt</p>' }), mx: mxYes })
    const row = companyContactRow(r, 10)
    expect(row.provider).toBe('company_contact_email')
    expect(storedCompanyContactEmail([{ provider: 'hunter' }, row])).toMatchObject({ email: 'sales@acmemed.com.mt' })
    expect(storedCompanyContactEmail([{ provider: 'hunter' }])).toBeNull()
  })
})
