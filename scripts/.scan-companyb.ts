import 'dotenv/config'
import { prisma } from '../src/platform/db.js'
import { getCrm } from '../src/crm/index.js'
import { chooseWebsite } from '../src/enrichment/companyEnrichment.js'

// Find ONE never-processed CRM company with a real catalogue, for the
// "Company B" validation. Reuses the last discovery snapshot so no new
// discovery row is written, and excludes every company that already owns an
// audit run — the same rule the pipeline used.
async function catalogueSignal(url: string): Promise<{ ok: boolean; why: string }> {
  let html: string
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9_000), redirect: 'follow' })
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
    if (!/text\/html/i.test(res.headers.get('content-type') ?? '')) return { ok: false, why: 'not HTML' }
    html = await res.text()
  } catch (err) {
    return { ok: false, why: `unreachable (${(err as Error).message.slice(0, 30)})` }
  }
  if (html.length < 2000) return { ok: false, why: `only ${html.length} bytes` }
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.toLowerCase())
  const cat = new Set(hrefs.filter((h) => /\/(product|products|shop|store|category|categories|collections?|catalogue|catalog)(\/|\?|$)/.test(h)))
  return cat.size >= 3 ? { ok: true, why: `${cat.size} catalogue links` } : { ok: false, why: `${cat.size} catalogue links` }
}

const used = new Set((await prisma.websiteAuditRun.findMany({ select: { crmCompanyId: true }, distinct: ['crmCompanyId'] })).map((r) => r.crmCompanyId))
const search = await prisma.prospectSearch.findFirst({ where: { status: 'completed', snapshotId: { not: null } }, orderBy: { createdAt: 'desc' } })
if (!search?.snapshotId) throw new Error('no completed discovery snapshot to scan')
const members = await prisma.audienceMember.findMany({ where: { snapshotId: search.snapshotId }, orderBy: [{ score: 'desc' }, { companyName: 'asc' }] })
const fresh = members.filter((m) => !used.has(m.crmCompanyId))
console.error(`snapshot ${search.snapshotId}: ${members.length} members, ${fresh.length} never processed, ${used.size} excluded`)

const crm = getCrm()
let examined = 0
const found: string[] = []
for (const m of fresh) {
  if (found.length >= 2 || examined >= 45) break
  examined++
  const company = await crm.getCompany(m.crmCompanyId).catch(() => null)
  if (!company) continue
  const site = chooseWebsite(company)
  if (!site) continue
  const probe = await catalogueSignal(site.url)
  console.error(`  ${probe.ok ? 'OK  ' : 'skip'} ${(m.companyName ?? company.name).padEnd(32)} ${site.url.padEnd(40)} ${probe.why}`)
  if (probe.ok) found.push(`${m.companyName ?? company.name} | ${m.crmCompanyId} | ${site.url}`)
}
console.error(`examined ${examined}`)
for (const f of found) console.error(`CANDIDATE ${f}`)
await prisma.$disconnect()
