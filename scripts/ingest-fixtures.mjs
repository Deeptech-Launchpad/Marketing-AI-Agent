import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import jwt from 'jsonwebtoken'

// DEV UTILITY — ingests fixtures/knowledge/*.md through the real HTTP API.
//
// It deliberately goes over HTTP rather than calling createDocument() directly,
// so what it exercises is the same path a real upload takes: auth, RBAC, zod
// validation, checksum de-duplication, the queue, and the worker.
//
// The fixtures are SYNTHETIC test data describing a fictional company. They
// exist to validate the pipeline, not to describe any real business.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '..', 'fixtures', 'knowledge')
const BASE = process.env.AGENT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4100}`

// Filename -> corpusType. Kept explicit so a new fixture must be classified
// deliberately rather than defaulting to something plausible.
const CORPUS_BY_FILE = {
  'sample-company-profile.md': 'company_info',
  'sample-product-service.md': 'product_service',
  'sample-brand-guidelines.md': 'brand_guidelines',
  'sample-customer-persona.md': 'persona',
  'sample-case-study.md': 'case_study',
  'sample-marketing-content.md': 'marketing_content',
}

function token() {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set')
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL
  if (!email) throw new Error('BOOTSTRAP_ADMIN_EMAIL is not set')
  return jwt.sign(
    { id: 'crm-user-fixture-loader', email, name: 'Fixture Loader', role: 'admin' },
    secret,
    { expiresIn: '15m' },
  )
}

/** First markdown H1 becomes the title, so it stays in step with the file. */
function titleOf(text, fallback) {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim().slice(0, 300) : fallback
}

const auth = token()
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.md')).sort()
let ok = 0
let dup = 0
let failed = 0

for (const file of files) {
  const corpusType = CORPUS_BY_FILE[file]
  if (!corpusType) {
    console.log(`  SKIP  ${file} — no corpusType mapping`)
    continue
  }

  const content = readFileSync(join(FIXTURES, file), 'utf8')
  const res = await fetch(`${BASE}/api/v1/knowledge/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      corpusType,
      title: titleOf(content, file),
      content,
      metadata: { fixture: true, sourceFile: file, synthetic: true },
    }),
  })

  const body = await res.json().catch(() => ({}))
  if (res.status === 202) {
    ok++
    console.log(`  OK    ${corpusType.padEnd(18)} ${file}  -> ${body.id}`)
  } else if (res.status === 409) {
    // Checksum de-duplication. Re-running the loader is a no-op, by design.
    dup++
    console.log(`  DUP   ${corpusType.padEnd(18)} ${file}  -> already ingested`)
  } else {
    failed++
    console.log(`  FAIL  ${corpusType.padEnd(18)} ${file}  -> HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
}

console.log(`\nqueued ${ok}, duplicate ${dup}, failed ${failed}`)
process.exit(failed ? 1 : 0)
