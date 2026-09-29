import { Router } from 'express'
import { z } from 'zod'
import { getCrm } from '../../crm/index.js'
import { exactMatch, readCrmCompany, searchCrmCompanies } from '../../crm/companySearch.js'
import { NotFoundError } from '../../platform/errors.js'
import { prisma } from '../../platform/db.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'

// LOOKING A COMPANY UP IN THE CRM.
//
// One endpoint, one verb, one purpose: answer "which companies in NXT Sales
// match what I typed" so the company picker can offer them. It reads the CRM
// and writes nothing — here or anywhere it reaches.
//
// It deliberately does NOT list the CRM. There is no "give me every company"
// path: a query is required, and the number returned is capped, so this cannot
// become a way to pull the customer's company base through the browser.

/** What the search did, in the words a reader needs to act on it. */
function describe(result: {
  companies: unknown[]
  industries: string[]
  countries: string[]
}): string {
  const filters = [
    result.industries.length
      ? `${result.industries.length === 1 ? 'industry' : 'industries'} ${result.industries.map((i) => `"${i}"`).join(', ')}`
      : null,
    result.countries.length ? `in ${result.countries.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  if (result.companies.length) {
    return filters ? `Matched by name, and by CRM ${filters}.` : 'Matched by company name.'
  }
  return filters
    ? `No company in the CRM matched, although the words name ${filters}.`
    : 'No company in the CRM matched this, and it names no industry the CRM holds.'
}

export const companyRoutes = Router()

const SearchQuery = z.object({
  q: z.string().min(1).max(120),
  limit: z.coerce.number().int().positive().max(50).default(20),
})

companyRoutes.get(
  '/search',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const parsed = SearchQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({
        error: 'A search term is required.',
        detail: 'Pass ?q= with at least one character; ?limit= is optional and capped at 50.',
      })
      return
    }

    const { q, limit } = parsed.data
    const result = await searchCrmCompanies(getCrm(), q, limit)
    res.json({
      query: q,
      ...result,
      // The company the words NAME, when they name exactly one. A caller
      // asking "is ACO Medical Supply in the CRM" gets that answered here
      // rather than having to scan the list for it.
      exact: exactMatch(q, result.companies),
      // Said in words, because "no results" and "that word names no industry"
      // send a reader to different places.
      note: describe(result),
    })
  }),
)

/**
 * WHERE A SELECTED COMPANY ACTUALLY COMES FROM (2026-09-28).
 *
 * The screen was calling every selected company an "NXT Sales company" and
 * showing its id as a "CRM record" — including companies Prospects found on
 * the open web, whose id is this platform's own. This answers the question
 * from the sources themselves, at the moment it is asked:
 *
 *   crm          the id is a record the connected NXT Sales holds right now
 *   discovered   the id is a company Prospects found (a CRM link it once
 *                carried is honoured only if NXT Sales still holds that record)
 *   not_in_crm   neither: an id NXT Sales no longer holds, e.g. a stale choice
 *   unverified   NXT Sales could not be reached, so nothing is claimed
 *
 * Read-only: it reads the CRM and the platform's own discovery rows.
 */
companyRoutes.get(
  '/:id/identity',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? '').trim()
    if (!id) {
      res.status(400).json({ error: 'A company id is required.' })
      return
    }
    const tenantId = req.principal!.tenantId
    const checkedAt = new Date().toISOString()
    type Checked = { ok: true; company: Awaited<ReturnType<typeof readCrmCompany>> } | { ok: false; reason: string }
    const inCrm = async (crmId: string): Promise<Checked> => {
      try {
        return { ok: true, company: await readCrmCompany(getCrm(), crmId) }
      } catch (err) {
        return { ok: false, reason: (err as Error).message || 'NXT Sales could not be reached.' }
      }
    }

    const discovered = await prisma.discoveredCompany.findFirst({
      where: { id, tenantId },
      select: { id: true, companyName: true, websiteUrl: true, domain: true, crmCompanyId: true, search: { select: { objective: true } } },
    })
    if (discovered) {
      const base = {
        id,
        discoveredCompanyId: discovered.id,
        name: discovered.companyName,
        website: discovered.websiteUrl ?? (discovered.domain ? `https://${discovered.domain}/` : null),
        searchObjective: discovered.search?.objective ?? null,
        checkedAt,
      }
      // A link to a CRM record counts only if NXT Sales holds that record now.
      if (discovered.crmCompanyId) {
        const check = await inCrm(discovered.crmCompanyId)
        if (check.ok && check.company) {
          res.json({ ...base, kind: 'crm', crmCompanyId: discovered.crmCompanyId, reason: 'Found by Prospects and matched to a record NXT Sales holds.' })
          return
        }
      }
      res.json({ ...base, kind: 'discovered', crmCompanyId: null, reason: 'Found by a Prospects search on the public web. It is not an NXT Sales record.' })
      return
    }

    const check = await inCrm(id)
    if (!check.ok) {
      res.json({ id, kind: 'unverified', crmCompanyId: null, discoveredCompanyId: null, name: null, website: null, searchObjective: null, checkedAt, reason: `NXT Sales could not be checked: ${check.reason}` })
      return
    }
    if (check.company) {
      const c = check.company
      res.json({ id, kind: 'crm', crmCompanyId: id, discoveredCompanyId: null, name: c.companyName ?? null, website: c.website ?? null, searchObjective: null, checkedAt, reason: 'A record NXT Sales holds.' })
      return
    }
    res.json({ id, kind: 'not_in_crm', crmCompanyId: null, discoveredCompanyId: null, name: null, website: null, searchObjective: null, checkedAt, reason: 'NXT Sales holds no record with this id, and no Prospects search found it.' })
  }),
)

/** 2. One company, read from the CRM. Used to open a lead on the record. */
companyRoutes.get(
  '/:crmCompanyId',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const id = String(req.params.crmCompanyId ?? '').trim()
    if (!id) {
      res.status(400).json({ error: 'A company id is required.' })
      return
    }
    const company = await readCrmCompany(getCrm(), id)
    if (!company) {
      throw new NotFoundError(`No company with id "${id}" exists in the CRM.`)
    }
    res.json({ company })
  }),
)
