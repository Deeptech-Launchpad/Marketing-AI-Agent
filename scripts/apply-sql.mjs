import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import 'dotenv/config'
import pg from 'pg'

// Applies a .sql file using the `pg` driver already in the dependency tree.
//
// This replaces `psql "$MARKETING_ADMIN_URL" -f ...`, which was broken twice
// over on Windows: npm runs scripts through cmd.exe, which does not expand
// `$VAR`, and psql is not on PATH by default even when PostgreSQL is installed.
// Going through the driver also means the documented setup works identically
// against a local server and the dev container.

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/apply-sql.mjs <path-to-sql>')
  process.exit(1)
}

// The ADMIN url is used because these statements need CREATE EXTENSION rights,
// which the application role should not have. It carries no ?schema= param, so
// the file itself is responsible for any search_path it needs.
const url = process.env.MARKETING_ADMIN_URL
if (!url) {
  console.error('MARKETING_ADMIN_URL is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const sql = readFileSync(resolve(file), 'utf8')
const client = new pg.Client({ connectionString: url })

try {
  await client.connect()
  // node-postgres sends this as a simple query, so the whole file runs as one
  // batch and a `SET search_path` at the top applies to the statements after it.
  await client.query(sql)
  console.log(`applied ${file}`)
} catch (err) {
  console.error(`failed to apply ${file}:`)
  console.error(`  ${err.message}`)
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}
