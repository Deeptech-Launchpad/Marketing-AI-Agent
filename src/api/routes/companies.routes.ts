import { Router } from 'express'
import { z } from 'zod'
import { getCrm } from '../../crm/index.js'
import { exactMatch, readCrmCompany, searchCrmCompanies } from '../../crm/companySearch.js'
import { NotFoundError } from '../../platform/errors.js'
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
