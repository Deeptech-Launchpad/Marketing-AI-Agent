import 'dotenv/config'
import { defineConfig } from 'vitest/config'

// Tests run against the fake CRM and fake LLM by default: no network, no API
// key, no cost, and deterministic results. The fakes still validate their
// canned payloads against the real zod schemas, so a schema change that the
// fixtures do not follow fails the suite rather than passing hollowly.

const USE_REAL = process.env.TEST_USE_REAL === '1'

/** Adds a Prisma pool bound to a connection string, preserving what is there. */
function withPoolLimit(url: string, limit: number): string {
  const parsed = new URL(url)
  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', String(limit))
  }
  return parsed.toString()
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests hit the REAL NXT Sales API and need the real drivers.
    // They self-skip when the CRM is unreachable, so this is safe by default.
    testTimeout: 120_000,
    // Hooks get the same allowance as tests. `testTimeout` alone leaves
    // beforeAll/afterAll on vitest's 10s default, and the integration hooks do
    // real database work — cloning a run, minting a link, starting a server.
    // As more suites run in parallel that setup slows down, and the suite fails
    // with "Hook timed out" in a file that has nothing wrong with it.
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      // Real services are OPT-IN via TEST_USE_REAL=1, never inherited.
      //
      // Reading CRM_DRIVER straight from process.env looked equivalent, but
      // vitest.config imports dotenv — so .env's CRM_DRIVER=real leaked into
      // EVERY run, and the e2e suite silently started calling paid Gemini and
      // the live CRM. It still passed; it just took 183s instead of 5s and
      // cost money. A default that reaches the network is the wrong default.
      CRM_DRIVER: USE_REAL ? 'real' : 'fake',
      LLM_DRIVER: USE_REAL ? 'real' : 'fake',
      // Falls back to a dummy for unit tests, but uses the REAL secret when
      // .env supplies one — the integration suite mints tokens that NXT Sales
      // must actually verify, and a test-only secret yields a 401 that looks
      // like a broken adapter rather than a misconfigured test.
      JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-value-at-least-16-chars',
      // A customer report cannot be generated without configured legal
      // wording — that is the point of the guard, and it is asserted in the
      // unit suite. The tests that render a report therefore need SOME value,
      // and it is worded so that a copy escaping into a real document would be
      // unmistakable rather than plausible.
      REPORT_LEGAL_DISCLAIMER:
        process.env.REPORT_LEGAL_DISCLAIMER ??
        'TEST DISCLAIMER — NOT APPROVED WORDING. Indicative product-data review, not a certified audit.',
      // Points at the local pgvector dev container (see README "Database").
      // The e2e suite creates and deletes its own `e2e-test` tenant, so it does
      // not disturb anything else in that database. When the container is not
      // running the e2e suite SKIPS with a printed reason instead of failing.
      // `connection_limit` is NOT cosmetic. Vitest runs each test file in its
      // own worker with its own Prisma client, and Prisma sizes a pool at
      // (cores * 2 + 1) — 25 on a 12-core machine. Eleven integration files can
      // therefore ask for 275 connections against a Postgres max_connections of
      // 100, and the suite starts failing in a DIFFERENT file on each run,
      // which reads as flaky application code rather than as pool exhaustion.
      // Five per worker keeps the whole suite comfortably inside the limit.
      MARKETING_DATABASE_URL: withPoolLimit(
        process.env.MARKETING_DATABASE_URL ??
          'postgresql://postgres:marketing_dev_pw@127.0.0.1:5434/marketing_agent_dev?schema=marketing',
        5,
      ),
      NXT_SALES_BASE_URL: process.env.NXT_SALES_BASE_URL ?? 'http://localhost:4000',
      NXT_SALES_SERVICE_USER_ID: process.env.NXT_SALES_SERVICE_USER_ID ?? '',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
      // Same reasoning as JWT_SECRET: unit tests are happy with a dummy, but
      // the integration suite resolves the REAL seeded tenant, and a test-only
      // slug makes findFirstOrThrow throw in a way that looks like a broken
      // query rather than a misconfigured test.
      DEFAULT_TENANT_SLUG: process.env.DEFAULT_TENANT_SLUG ?? 'test',
      DEFAULT_TENANT_NAME: 'Test Tenant',
    },
  },
})
