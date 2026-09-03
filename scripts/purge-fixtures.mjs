import 'dotenv/config'
import jwt from 'jsonwebtoken'

// Removes the SYNTHETIC fixture documents from the knowledge base.
//
// Run this before ingesting real business documents. Synthetic and real content
// in the same corpus is worse than either alone: retrieval will happily cite
// "Meridian Catalog Services" and the invented Halloway figures alongside real
// material, and the resulting campaign package looks authoritative while being
// partly fabricated.
//
// Only documents whose metadata carries `fixture: true` are removed — real
// documents ingested via ingest-doc.mjs never carry that flag and are left
// alone. Pass --dry to list without deleting.

const DRY = process.argv.includes('--dry')
const BASE = process.env.AGENT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4100}`

const token = jwt.sign(
  { id: 'crm-user-fixture-purge', email: process.env.BOOTSTRAP_ADMIN_EMAIL, name: 'Fixture Purge', role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '15m' },
)
const auth = { Authorization: `Bearer ${token}` }

const listRes = await fetch(`${BASE}/api/v1/knowledge/documents`, { headers: auth })
if (!listRes.ok) {
  console.error(`could not list documents: HTTP ${listRes.status}`)
  process.exit(1)
}
const { documents } = await listRes.json()

// The list endpoint does not return metadata, so identify fixtures by the
// banner convention every fixture title carries.
const isFixture = (d) =>
  /\(SYNTHETIC\)/i.test(d.title) || /Meridian Catalog Services|Halloway Industrial/i.test(d.title)

const targets = documents.filter(isFixture)
const kept = documents.filter((d) => !isFixture(d))

console.log(`${documents.length} documents in the knowledge base`)
console.log(`  synthetic fixtures : ${targets.length}`)
console.log(`  other (real)       : ${kept.length}`)

if (!targets.length) {
  console.log('\nnothing to purge')
  process.exit(0)
}

console.log('')
for (const d of targets) {
  if (DRY) {
    console.log(`  would delete  ${d.corpusType.padEnd(18)} "${d.title.slice(0, 56)}"`)
    continue
  }
  const res = await fetch(`${BASE}/api/v1/knowledge/documents/${d.id}`, { method: 'DELETE', headers: auth })
  console.log(
    `  ${res.ok ? 'deleted' : 'FAILED '}  ${d.corpusType.padEnd(18)} "${d.title.slice(0, 56)}"` +
      (res.ok ? '' : ` (HTTP ${res.status})`),
  )
}

if (DRY) console.log('\ndry run — nothing was deleted')
else console.log(`\npurged ${targets.length} synthetic documents; ${kept.length} real documents untouched`)
