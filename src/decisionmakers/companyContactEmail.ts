import { promises as dns } from 'node:dns'
import { registrableDomain } from '../enrichment/siteIdentity.js'
import { isPersonalAddress, inspectSyntax } from '../emailverification/providers/provider.js'
import { prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { addressPageLink } from '../prospects/companyLocation.js'
import { resolvePipelineCompany } from '../prospects/discoveredCompanyAdapter.js'
import { fetchPageRaw, type RawPageResult } from '../research/pageFetch.js'
import { htmlToText } from '../research/htmlToText.js'
import type { CrmCompany } from '../crm/types.js'

// A COMPANY EMAIL, WHEN THE DECISION MAKER HAS NONE (2026-09-28).
//
//   Company → Decision Maker → their direct email if one was found →
//   otherwise one verified company mailbox → Outreach can reach the company.
//
// A decision maker is often named with no address of their own. The company
// usually publishes one it wants to be contacted on — sales@, info@,
// enquiries@. This finds that address and nothing else:
//
//   · NEVER invented or pattern-guessed. It must be written on a reliable
//     public source: the company's own website (read here), a page Hunter
//     observed it on (from the domain search the run already made — no extra
//     request), or the company's NXT Sales record.
//   · Only a SHARED ROLE MAILBOX. A named person's address is that person's,
//     not the decision maker's, and is never borrowed. Mailboxes that are not
//     for sales conversations (careers@, privacy@, noreply@, billing@…) are
//     refused.
//   · On the company's own domain, and that domain must receive mail (its MX
//     records are looked up; a domain with none is refused).
//
// It never replaces or edits a decision maker's own email; it is used only
// when there is none, and it is always labelled as a company mailbox.

export const COMPANY_CONTACT_PROVIDER = 'company_contact_email'

/** Shared mailboxes meant for enquiries, best first. */
const ROLE_RANK = [
  'sales', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'info', 'contact', 'contactus', 'hello',
  'office', 'general', 'mail', 'customerservice', 'customer.service', 'customer-service', 'service',
  'orders', 'order', 'export', 'marketing', 'ecommerce', 'shop', 'webshop', 'store', 'support', 'admin',
]
const ROLE_SET = new Set(ROLE_RANK)

export interface CompanyContactEmail {
  email: string
  /** The shared mailbox it is: "sales", "info"… */
  mailbox: string
  source: 'company_website' | 'hunter_public_page' | 'crm_record'
  sourceLabel: string
  /** The page it is written on, when it came from a page. */
  sourceUrl: string | null
  /** Why it counts: where it was seen, and the mail-server check. */
  evidence: string
  checkedAt: string
}

export interface CompanyContactResult {
  found: CompanyContactEmail | null
  reason: string
  pagesRead: string[]
}

type Fetcher = (url: string) => Promise<RawPageResult>
type MxLookup = (domain: string) => Promise<boolean | null>

/** Whether a domain has mail servers. True / false, or null when DNS could not answer. */
export async function hasMailServer(domain: string): Promise<boolean | null> {
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 5000)),
    ])
    return mx.length > 0
  } catch (err) {
    const code = (err as { code?: string }).code
    return code === 'ENOTFOUND' || code === 'ENODATA' ? false : null
  }
}

/** The shared-mailbox rank of an address's local part, or null when it is not one we may use. */
export function mailboxRank(email: string): number | null {
  const local = email.split('@')[0]!.toLowerCase()
  const i = ROLE_RANK.indexOf(local)
  return i >= 0 ? i : null
}

function sameCompanyDomain(email: string, companyDomain: string | null): boolean {
  if (!companyDomain) return false
  const d = email.split('@')[1]?.toLowerCase() ?? ''
  return registrableDomain(d.replace(/^www\./, '')) === registrableDomain(companyDomain.replace(/^www\./, '').toLowerCase())
}

/** Every address a page states — its mailto links and its visible text. Pure. */
export function emailsOnPage(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?#\s]+)/gi)) {
    let v = m[1]!
    try {
      v = decodeURIComponent(v)
    } catch {
      /* keep as written */
    }
    out.add(v.replace(/&#0*64;|&commat;/gi, '@').trim().toLowerCase())
  }
  for (const m of htmlToText(html).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi)) out.add(m[0].toLowerCase())
  return [...out].filter((e) => inspectSyntax(e).valid)
}

/** The best usable shared mailbox among addresses, or null. Pure. */
export function pickMailbox(addresses: string[], companyDomain: string | null, requireDomain = true): string | null {
  const usable = addresses
    .map((e) => e.trim().toLowerCase())
    .filter((e) => inspectSyntax(e).valid && !isPersonalAddress(e))
    .filter((e) => mailboxRank(e) !== null)
    .filter((e) => !requireDomain || sameCompanyDomain(e, companyDomain))
  usable.sort((a, b) => mailboxRank(a)! - mailboxRank(b)!)
  return usable[0] ?? null
}

/**
 * Finds one verified company mailbox. Never throws.
 *
 * Order: the company's own website (homepage, then the contact / about page it
 * links to), the pages Hunter observed shared mailboxes on, the NXT Sales
 * record. The first source that yields a usable address whose domain receives
 * mail wins.
 */
export async function findCompanyContactEmail(input: {
  company: Pick<CrmCompany, 'email' | 'emails'> | null
  companyDomain: string | null
  hunterMailboxes?: Array<{ email: string; sources: string[] }>
  fetch?: Fetcher
  mx?: MxLookup
}): Promise<CompanyContactResult> {
  const fetchPage: Fetcher = input.fetch ?? ((u) => fetchPageRaw(u))
  const mx: MxLookup = input.mx ?? hasMailServer
  const domain = input.companyDomain?.replace(/^www\./, '').toLowerCase() ?? null
  const pagesRead: string[] = []
  // Why the website gave nothing, when it could not be read at all.
  let siteUnreadable: string | null = null
  const now = () => new Date().toISOString()
  const mailOk = async (email: string) => (await mx(email.split('@')[1]!)) === true

  // 1. The company's own website.
  if (domain) {
    const visit = async (url: string): Promise<{ html: string; url: string } | null> => {
      try {
        const res = await fetchPage(url)
        pagesRead.push(res.finalUrl ?? url)
        return res.ok && res.html ? { html: res.html, url: res.finalUrl ?? url } : null
      } catch {
        return null
      }
    }
    const home = await visit(`https://${domain}/`)
    if (!home) siteUnreadable = `the company’s website (${domain}) could not be opened`
    const pages = home ? [home] : []
    const contact = home ? addressPageLink(home.html, home.url) : null
    if (contact) {
      const page = await visit(contact)
      if (page) pages.push(page)
    }
    for (const page of pages) {
      const email = pickMailbox(emailsOnPage(page.html), domain)
      if (email && (await mailOk(email))) {
        return {
          found: {
            email,
            mailbox: email.split('@')[0]!,
            source: 'company_website',
            sourceLabel: 'the company’s own website',
            sourceUrl: page.url,
            evidence: `Written on the company’s own website (${page.url}); the domain ${email.split('@')[1]} receives mail (MX records found).`,
            checkedAt: now(),
          },
          reason: 'Company mailbox found on the company’s own website.',
          pagesRead,
        }
      }
    }
  }

  // 2. The shared mailboxes Hunter observed on public pages (already fetched by the run).
  for (const h of input.hunterMailboxes ?? []) {
    const email = pickMailbox([h.email], domain)
    if (email && h.sources.length && (await mailOk(email))) {
      return {
        found: {
          email,
          mailbox: email.split('@')[0]!,
          source: 'hunter_public_page',
          sourceLabel: 'a public page Hunter observed it on',
          sourceUrl: h.sources[0]!,
          evidence: `Hunter observed it on ${h.sources[0]}; the domain ${email.split('@')[1]} receives mail (MX records found).`,
          checkedAt: now(),
        },
        reason: 'Company mailbox observed by Hunter on a public page.',
        pagesRead,
      }
    }
  }

  // 3. The company's NXT Sales record.
  const crmAddresses = [input.company?.email, ...(input.company?.emails ?? [])].filter((e): e is string => Boolean(e))
  const crmEmail = pickMailbox(crmAddresses, domain, Boolean(domain))
  if (crmEmail && (await mailOk(crmEmail))) {
    return {
      found: {
        email: crmEmail,
        mailbox: crmEmail.split('@')[0]!,
        source: 'crm_record',
        sourceLabel: 'the company’s NXT Sales record',
        sourceUrl: null,
        evidence: `Stated on the company’s NXT Sales record; the domain ${crmEmail.split('@')[1]} receives mail (MX records found).`,
        checkedAt: now(),
      },
      reason: 'Company mailbox from the NXT Sales record.',
      pagesRead,
    }
  }

  return {
    found: null,
    reason: !domain
      ? 'The company has no known website domain, so no company mailbox could be read — and none was guessed.'
      : siteUnreadable
        ? `No company mailbox found: ${siteUnreadable}, Hunter observed no shared mailbox for it, and its record holds none — nothing was guessed.`
        : 'No shared company mailbox (sales@, info@, enquiries@…) is published on the company’s website, observed by Hunter, or held on its record — and none was guessed.',
    pagesRead,
  }
}

/** The company mailbox a run stored, or null. */
export function storedCompanyContactEmail(providerResults: unknown): CompanyContactEmail | null {
  const rows = Array.isArray(providerResults) ? (providerResults as Array<{ provider?: string; metadata?: { companyContactEmail?: CompanyContactEmail | null } }>) : []
  return rows.find((r) => r.provider === COMPANY_CONTACT_PROVIDER)?.metadata?.companyContactEmail ?? null
}

/** Hunter's observed shared mailboxes, from a run's provider results. */
export function hunterMailboxesOf(providerResults: unknown): Array<{ email: string; sources: string[] }> {
  const rows = Array.isArray(providerResults) ? (providerResults as Array<{ provider?: string; metadata?: { genericMailboxAddresses?: unknown } }>) : []
  const list = rows.find((r) => r.provider === 'hunter')?.metadata?.genericMailboxAddresses
  return Array.isArray(list) ? (list as Array<{ email: string; sources: string[] }>).filter((x) => x && typeof x.email === 'string') : []
}

/** The provider-results row a run stores for this step. */
export function companyContactRow(result: CompanyContactResult, durationMs: number) {
  return {
    provider: COMPANY_CONTACT_PROVIDER,
    status: result.found ? 'available' : 'no_results',
    queried: result.pagesRead.length > 0,
    local: false,
    candidates: 0,
    reason: result.found
      ? `The decision maker has no direct email. Company mailbox ${result.found.email} — ${result.found.evidence}`
      : `The decision maker has no direct email. ${result.reason}`,
    durationMs,
    costUsd: null,
    metadata: { companyContactEmail: result.found, pagesRead: result.pagesRead },
  }
}

/**
 * For a company whose latest run named a decision maker without an email and
 * holds no company mailbox yet (runs made before this existed): finds one and
 * stores it on that run. Returns what the run now holds. Never throws.
 */
export async function ensureCompanyContactEmail(tenantId: string, crmCompanyId: string): Promise<CompanyContactEmail | null> {
  try {
    const run = await prisma.decisionMakerRun.findFirst({
      where: { tenantId, crmCompanyId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, companyDomain: true, providerResults: true },
    })
    if (!run) return null
    const rows = Array.isArray(run.providerResults) ? (run.providerResults as unknown[]) : []
    if (rows.some((r) => (r as { provider?: string })?.provider === COMPANY_CONTACT_PROVIDER)) return storedCompanyContactEmail(rows)
    const top = await prisma.decisionMakerCandidate.findFirst({
      where: { tenantId, dmRunId: run.id, outcome: 'shortlisted' },
      orderBy: { rank: 'asc' },
      select: { email: true },
    })
    if (!top || top.email) return null
    const resolved = await resolvePipelineCompany(tenantId, crmCompanyId)
    const started = Date.now()
    const result = await findCompanyContactEmail({
      company: resolved?.company ?? null,
      companyDomain: run.companyDomain,
      hunterMailboxes: hunterMailboxesOf(rows),
    })
    await prisma.decisionMakerRun.update({
      where: { id: run.id },
      data: { providerResults: [...rows, companyContactRow(result, Date.now() - started)] as never },
    })
    return result.found
  } catch (err) {
    logger.info({ err: (err as Error).message, crmCompanyId }, 'company contact email lookup failed; nothing stored')
    return null
  }
}
