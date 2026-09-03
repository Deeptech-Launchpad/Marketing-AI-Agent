import 'dotenv/config'
import jwt from 'jsonwebtoken'
import pg from 'pg'

// DEV UTILITY — runs a set of queries through the real retrieval endpoint and,
// alongside it, the raw cosine similarity straight from pgvector.
//
// Both numbers are shown on purpose. The API returns a reciprocal-rank-fusion
// score, which orders results but says nothing about whether the best result is
// actually any good: an unrelated query still gets a top-N list with plausible
// looking RRF scores. Cosine similarity is the number that tells you whether a
// match is real, so relevance claims are made against that.

const BASE = process.env.AGENT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4100}`
const GEMINI = process.env.GEMINI_API_BASE ?? 'https://generativelanguage.googleapis.com/v1beta'

const RELEVANT = [
  'What products does the company offer?',
  'Who is the target customer?',
  'What tone should marketing content use?',
  'What customer problem does the product solve?',
]

const IRRELEVANT = [
  'veterinary appointment scheduling software',
  'how do I bake sourdough bread',
  'quarterly dividend policy for shareholders',
]

function token() {
  return jwt.sign(
    { id: 'crm-user-retrieval-report', email: process.env.BOOTSTRAP_ADMIN_EMAIL, name: 'Retrieval Report', role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' },
  )
}

async function embed(text) {
  const model = process.env.GEMINI_MODEL_EMBEDDING
  const res = await fetch(`${GEMINI}/models/${model}:embedContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      outputDimensionality: Number(process.env.GEMINI_EMBEDDING_DIMENSIONS ?? 768),
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error?.message ?? `embed failed (${res.status})`)
  const v = json.embedding.values
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

const adminUrl = process.env.MARKETING_ADMIN_URL
const client = new pg.Client({ connectionString: adminUrl })
await client.connect()
// Set once on the connection: pgvector lives in the marketing schema, and a
// parameterised query cannot carry a SET alongside it.
await client.query('SET search_path TO marketing, public')

const tenant = await client.query(
  `SELECT id FROM marketing."Tenant" WHERE slug = $1`,
  [process.env.DEFAULT_TENANT_SLUG],
)
const tenantId = tenant.rows[0]?.id
if (!tenantId) throw new Error('tenant not found; run npm run db:seed')

const auth = token()

async function report(query, label) {
  const vec = await embed(query)
  const lit = `[${vec.join(',')}]`

  // Absolute similarity, straight from pgvector. 1 = identical direction.
  const cos = await client.query(
    `SELECT d."corpusType" AS corpus,
            coalesce(c."sectionPath", '(none)') AS section,
            round((1 - (c.embedding <=> $1::vector))::numeric, 4) AS cosine
     FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d.id = c."documentId"
     WHERE c."tenantId" = $2
     ORDER BY c.embedding <=> $1::vector
     LIMIT 3`,
    [lit, tenantId],
  )
  const rows = cos.rows

  const res = await fetch(`${BASE}/api/v1/knowledge/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topN: 3 }),
  })
  const api = await res.json()

  console.log(`\n[${label}] "${query}"`)
  console.log('  top cosine similarity (absolute relevance):')
  rows.forEach((r) => console.log(`    ${String(r.cosine).padEnd(8)} ${r.corpus.padEnd(18)} ${r.section.slice(0, 44)}`))
  console.log('  API result (hybrid RRF, with citations):')
  ;(api.chunks ?? []).forEach((c, i) =>
    console.log(
      `    #${i + 1} rrf=${c.score.toFixed(5)} ${c.corpusType.padEnd(18)} "${c.documentTitle.slice(0, 40)}"` +
        `\n        section: ${c.sectionPath ?? '(none)'}` +
        `\n        chunkId: ${c.chunkId}` +
        `\n        text   : ${c.content.replace(/\s+/g, ' ').slice(0, 130)}…`,
    ),
  )
  return Number(rows[0]?.cosine ?? 0)
}

console.log('='.repeat(78))
console.log('RELEVANT QUERIES')
console.log('='.repeat(78))
const relScores = []
for (const q of RELEVANT) relScores.push(await report(q, 'relevant'))

console.log('\n' + '='.repeat(78))
console.log('IRRELEVANT QUERIES')
console.log('='.repeat(78))
const irrScores = []
for (const q of IRRELEVANT) irrScores.push(await report(q, 'irrelevant'))

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length
console.log('\n' + '='.repeat(78))
console.log(`relevant   top-cosine: min ${Math.min(...relScores).toFixed(4)}  avg ${avg(relScores).toFixed(4)}`)
console.log(`irrelevant top-cosine: max ${Math.max(...irrScores).toFixed(4)}  avg ${avg(irrScores).toFixed(4)}`)
console.log(`separation (min relevant - max irrelevant): ${(Math.min(...relScores) - Math.max(...irrScores)).toFixed(4)}`)

await client.end()
