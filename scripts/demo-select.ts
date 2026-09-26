import 'dotenv/config'
import { getCrm } from '../src/crm/index.js'
import { writeFileSync } from 'node:fs'

// PHASE 1 — select 20 real companies from the LOCAL CRM.
//
// Read through the CRM port, which is the same boundary every engine uses. No
// company is invented and none is edited; this only chooses which real records
// the pipeline will be run against.

async function main() {
  const crm = getCrm()
  const page = await crm.searchCompanies({ limit: 400 } as never)
  const all = page.items ?? []
  console.log(`  read ${all.length} companies from the local CRM`)

  const hasSite = (c: Record<string, unknown>) => {
    const d = (c.domain ?? c.website ?? '') as string
    return typeof d === 'string' && d.trim().length > 3
  }

  const withSite = all.filter((c) => hasSite(c as never))
  const without = all.filter((c) => !hasSite(c as never))
  console.log(`  with a website: ${withSite.length} · without: ${without.length}`)

  // Prefer companies the engines can actually work on, but keep a couple
  // without a website so the set exposes the real "nothing to audit" path.
  const chosen = [...withSite.slice(0, 18), ...without.slice(0, 2)].slice(0, 20)

  const rows = chosen.map((c) => {
    const r = c as unknown as Record<string, unknown>
    return {
      crmCompanyId: String(r.crmCompanyId ?? r.id ?? ''),
      name: String(r.name ?? ''),
      domain: String(r.domain ?? r.website ?? '') || null,
      country: (r.country as string) ?? null,
      industry: (r.industry as string) ?? null,
      source: 'local NXT Sales CRM',
      batch: 'pending' as const,
    }
  })

  writeFileSync('scripts/.demo-cohort.json', JSON.stringify(rows, null, 2))
  console.log(`\n  selected ${rows.length} companies -> scripts/.demo-cohort.json\n`)
  rows.forEach((r, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${r.name.slice(0, 34).padEnd(34)} ${r.domain ?? '(no website)'}`),
  )
}

main().catch((e) => {
  console.error('selection failed:', e)
  process.exit(1)
})
