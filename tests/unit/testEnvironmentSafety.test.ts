import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// THE TEST SUITE MUST NEVER TALK TO THE LIVE CRM.
//
// This exists because it very nearly did. `vitest.config.ts` imports dotenv and
// resolved the suite's CRM target as:
//
//   NXT_SALES_BASE_URL: process.env.NXT_SALES_BASE_URL ?? 'http://localhost:4000'
//
// which reads as a safe localhost default right up until somebody points the
// PLATFORM at production — a legitimate, expected configuration change. From
// that moment `TEST_USE_REAL=1` sent the whole integration suite at the live
// CRM, and every test still passed, because nothing checked where they were
// pointing. A default is not a guarantee when the thing it defaults from is
// under someone else's control.
//
// These assertions are cheap and they run in the default suite, so the mistake
// cannot come back quietly.

const LIVE_HOSTS = ['nxtsales.altiusnxt.tech']

const configSource = readFileSync(new URL('../../vitest.config.ts', import.meta.url), 'utf8')

describe('the test suite targets local NXT Sales, never live', () => {
  it('is pointed at a local CRM right now', () => {
    const target = process.env.NXT_SALES_BASE_URL ?? ''
    expect(target, 'tests must have a CRM target').toBeTruthy()
    const host = new URL(target).hostname
    expect(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'], `resolved to ${target}`).toContain(host)
  })

  it('is not pointed at any known live host', () => {
    const target = process.env.NXT_SALES_BASE_URL ?? ''
    for (const live of LIVE_HOSTS) {
      expect(target, `the suite must never target ${live}`).not.toContain(live)
    }
  })

  it('does not inherit the platform target from .env', () => {
    // The specific line that caused this. `process.env.NXT_SALES_BASE_URL` must
    // not be what decides where tests point.
    expect(configSource).not.toMatch(/NXT_SALES_BASE_URL:\s*process\.env\.NXT_SALES_BASE_URL/)
    expect(configSource).toContain('TEST_CRM_BASE_URL')
  })

  it('defaults to localhost and requires a dedicated variable to move', () => {
    expect(configSource).toMatch(/TEST_CRM_BASE_URL\s*=\s*process\.env\.TEST_NXT_SALES_BASE_URL\s*\?\?\s*'http:\/\/localhost:4000'/)
  })

  it('names no live host anywhere in the test configuration', () => {
    for (const live of LIVE_HOSTS) expect(configSource).not.toContain(live)
  })
})

describe('no test hardcodes the live CRM', () => {
  // Two files name the live host for reasons that are not "connect to it", and
  // both were read before being listed here:
  //
  //   crmWritePath      — asserts isLocalTarget() classifies it as NON-local,
  //                       which is the guard that refuses a live write under
  //                       the wrong identity. The string is the input to a
  //                       classification, never a request target.
  //   testEnvironment   — this file. LIVE_HOSTS is the list being searched for.
  //
  // Anything else is a new hardcoded production host in a test, which is what
  // this is here to catch.
  const REVIEWED = ['unit/crmWritePath.test.ts', 'unit/testEnvironmentSafety.test.ts']

  it('no other test file names a live host', async () => {
    const { globSync } = await import('node:fs')
    const root = new URL('../', import.meta.url)
    // Windows yields backslash paths; normalise without writing an escape.
    const BACKSLASH = String.fromCharCode(92)
    const files = (globSync('**/*.test.ts', { cwd: root }) as string[]).map((f) => f.split(BACKSLASH).join('/'))
    expect(files.length, 'the glob must actually find tests').toBeGreaterThan(10)

    const offenders = files.filter(
      (f) => !REVIEWED.includes(f) && LIVE_HOSTS.some((live) => readFileSync(new URL(f, root), 'utf8').includes(live)),
    )
    expect(offenders, 'tests must not name the live CRM').toEqual([])
  })

  it('the reviewed exceptions still exist, so the allow-list cannot rot', async () => {
    const { existsSync } = await import('node:fs')
    const root = new URL('../', import.meta.url)
    for (const f of REVIEWED) expect(existsSync(new URL(f, root)), f).toBe(true)
  })
})

describe('the worker cannot be aimed at live by accident either', () => {
  it('reads its CRM target only from the shared config', async () => {
    const worker = readFileSync(new URL('../../src/worker.ts', import.meta.url), 'utf8')
    // No direct env reads and no literal hosts: the worker inherits whatever
    // config/env.ts resolved, which is the single place that decides.
    expect(worker).not.toMatch(/process\.env\.NXT_SALES/)
    for (const live of LIVE_HOSTS) expect(worker).not.toContain(live)
  })

  it('the write flag is off in the checked-in configuration', () => {
    const envFile = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    expect(envFile).toContain('CRM_WRITE_ENABLED=false')
  })
})
