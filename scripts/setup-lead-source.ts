// One-time setup of the "Lead Source" field in NXT Sales (2026-09-29).
//
// NXT Sales has no Source/Tag column, so companies added by the Marketing AI
// Agent are marked through a Company custom dropdown field:
//
//   Lead Source (key: leadSource) = "Marketing AI Agent"
//
// This creates the field and that one option if they are missing, and does
// nothing if they already exist. It writes through the same gate as every
// other CRM write: CRM_WRITE_ENABLED must be on, and a non-local (live) NXT
// Sales additionally needs CRM_WRITE_ALLOW_LIVE and the confirmed service
// identity. Then set CRM_LEAD_SOURCE_FIELD=leadSource in .env.
//
//   npm run crm:setup-lead-source
import { env } from '../src/config/env.js'
import { crmGet, crmPost } from '../src/crm/nxtSales/httpClient.js'
import type { UpstreamError } from '../src/platform/errors.js'

const KEY = process.env.LEAD_SOURCE_KEY?.trim() || 'leadSource'
const LABEL = 'Lead Source'
const VALUE = env.CRM_LEAD_SOURCE_VALUE.trim() || 'Marketing AI Agent'
const status = (err: unknown) => ((err as UpstreamError)?.details as { status?: number } | undefined)?.status

async function main() {
  console.log(`NXT Sales: ${new URL(env.NXT_SALES_BASE_URL).host}`)

  const defs = await crmGet<Array<{ key: string; type: string }>>('/api/custom-fields/Company')
  const existing = (Array.isArray(defs) ? defs : []).find((d) => d.key === KEY)
  if (existing) {
    console.log(`Field "${KEY}" already exists (${existing.type}).`)
    if (existing.type !== 'dropdown') throw new Error(`Field "${KEY}" exists but is "${existing.type}", not a dropdown. Choose another key with LEAD_SOURCE_KEY.`)
  } else {
    await crmPost('/api/custom-fields', { entity: 'Company', key: KEY, label: LABEL, type: 'dropdown', helpText: 'Where this company came from.' })
    console.log(`Created Company field "${LABEL}" (key ${KEY}).`)
  }

  try {
    await crmPost('/api/dropdowns', { fieldKey: `company.custom.${KEY}`, value: VALUE, label: VALUE })
    console.log(`Added option "${VALUE}".`)
  } catch (err) {
    if (status(err) === 409) console.log(`Option "${VALUE}" already exists.`)
    else throw err
  }

  console.log(`\nDone. Set in .env:\n  CRM_LEAD_SOURCE_FIELD=${KEY}\n  CRM_LEAD_SOURCE_VALUE=${VALUE}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Not set up: ${(err as Error).message}`)
    process.exit(1)
  })
