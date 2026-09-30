import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// HARDENING — the production configuration guards.
//
// Two development bypasses exist, each disabling a rule that stops an
// unreviewed document reaching a customer:
//
//   WORKBENCH_ALLOW_UNAPPROVED  — a Workbench from an unapproved report
//   REPORT_ALLOW_UNAPPROVED     — a customer PDF from an unapproved report,
//                                 and without the configured legal disclaimer
//
// Both are refused at process start under NODE_ENV=production. That guard was
// written but never tested, which is a poor state for a control whose whole
// job is to fire on a day nobody is watching.
//
// These tests SPAWN A REAL PROCESS. Importing the config module in-process
// would run `process.exit(1)` inside the test runner, and a guard asserted by
// reading the source is not a guard that has been shown to work.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Loads the config in a child process and reports how it ended. */
function loadConfig(env: Record<string, string>): { code: number; output: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./src/config/env.ts'); console.log('CONFIG_LOADED')"],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        env: {
          ...process.env,
          // A complete-enough environment that only the flag under test decides
          // the outcome.
          MARKETING_DATABASE_URL: process.env.MARKETING_DATABASE_URL ?? 'postgresql://u:p@127.0.0.1:5434/x',
          JWT_SECRET: 'test-secret-value-at-least-16-chars',
          // Production-viable defaults for everything NOT under test. The suite
          // itself runs with CRM_DRIVER/LLM_DRIVER=fake and that inherits into
          // the child — so without pinning them here the fake-driver guards
          // would decide every case and no other flag could be observed.
          CRM_DRIVER: 'real',
          LLM_DRIVER: 'real',
          ALLOW_SELF_APPROVAL: 'false',
          NXT_SALES_SERVICE_USER_ID: 'cmt8ljfon00top3t31zkt33wz',
          GEMINI_API_KEY: 'test-key-not-used-config-only',
          NODE_OPTIONS: '--import tsx',
          ...env,
        },
      },
    )
    return { code: 0, output: out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('development bypasses are refused in production', () => {
  it('refuses WORKBENCH_ALLOW_UNAPPROVED in production', () => {
    const r = loadConfig({ NODE_ENV: 'production', WORKBENCH_ALLOW_UNAPPROVED: 'true' })
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/WORKBENCH_ALLOW_UNAPPROVED is a development-only flag/)
    expect(r.output).not.toContain('CONFIG_LOADED')
  })

  it('refuses REPORT_ALLOW_UNAPPROVED in production', () => {
    // The workbench flag is explicitly disabled here: it is currently TRUE in
    // the project's .env, its guard runs first, and it would exit before this
    // one was ever reached — which would make this test pass for the wrong
    // reason.
    const r = loadConfig({
      NODE_ENV: 'production',
      WORKBENCH_ALLOW_UNAPPROVED: 'false',
      REPORT_ALLOW_UNAPPROVED: 'true',
    })
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/REPORT_ALLOW_UNAPPROVED is a development-only flag/)
    expect(r.output).not.toContain('CONFIG_LOADED')
  })

  it('explains what the flag would have allowed', () => {
    const r = loadConfig({ NODE_ENV: 'production', WORKBENCH_ALLOW_UNAPPROVED: 'true' })
    expect(r.output).toMatch(/approved in Task #980/)
  })

  it('starts in production when every development flag is off', () => {
    const r = loadConfig({
      NODE_ENV: 'production',
      WORKBENCH_ALLOW_UNAPPROVED: 'false',
      REPORT_ALLOW_UNAPPROVED: 'false',
    })
    expect(r.output).toContain('CONFIG_LOADED')
    expect(r.code).toBe(0)
  })


  it('keeps the development capability outside production', () => {
    // The point is not to remove the bypass — it is deliberately useful
    // locally. It must simply be impossible to ship.
    const r = loadConfig({ NODE_ENV: 'development', WORKBENCH_ALLOW_UNAPPROVED: 'true', REPORT_ALLOW_UNAPPROVED: 'true' })
    expect(r.output).toContain('CONFIG_LOADED')
    expect(r.code).toBe(0)
  })
})

describe('the signing secret is required, with no fallback', () => {
  // NXT Sales resolves its own secret as `process.env.JWT_SECRET || 'dev-secret'`
  // in five places, so a deploy that loses the variable keeps serving — signing
  // with a string published in its repository. This service must not have an
  // equivalent, because a token it accepts is a token that reaches the CRM.

  it('refuses to start without a JWT_SECRET', () => {
    const r = loadConfig({ NODE_ENV: 'production', JWT_SECRET: '' })
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/JWT_SECRET/)
  })

  it('refuses a JWT_SECRET too short to be meaningful', () => {
    const r = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' })
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/JWT_SECRET/)
  })

  it('has no default anywhere in this codebase', async () => {
    const fs = await import('node:fs')
    const NL = String.fromCharCode(10)
    const env = fs.readFileSync(new URL('../../src/config/env.ts', import.meta.url), 'utf8')
    // The schema line, not a comment that happens to mention the name.
    const jwtLine = env.split(NL).find((l) => l.includes('JWT_SECRET:') && l.includes('z.string')) ?? ''
    expect(jwtLine, 'JWT_SECRET must be declared').toBeTruthy()
    expect(jwtLine).toContain('.min(16')
    expect(jwtLine, 'no default may rescue a missing secret').not.toContain('.default(')
    expect(jwtLine, 'the secret is not optional').not.toContain('optional')

    const auth = fs.readFileSync(new URL('../../src/api/middleware/auth.ts', import.meta.url), 'utf8')
    expect(auth, 'no published fallback string').not.toContain('dev-secret')
    const verifyLine = auth.split(NL).find((l) => l.includes('jwt.verify')) ?? ''
    expect(verifyLine, 'verification must use the configured secret alone').not.toContain('||')
    expect(verifyLine).not.toContain('??')
  })
})

describe('production refuses a self-approval and fabricated data', () => {
  // These three joined the guards above only after a production audit found
  // them missing. Each defaults to the safe value already — but the two flags
  // guarded above defaulted safely too, and were still worth refusing outright.

  it('refuses ALLOW_SELF_APPROVAL in production', () => {
    const r = loadConfig({ NODE_ENV: 'production', ALLOW_SELF_APPROVAL: 'true' })
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/ALLOW_SELF_APPROVAL is a development-only flag/)
    // The message must say what the flag actually costs, not just name it.
    expect(r.output).toMatch(/a review that never happened/)
  })

  it('refuses CRM_DRIVER=fake in production', () => {
    const r = loadConfig({ NODE_ENV: 'production', CRM_DRIVER: 'fake' })
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/CRM_DRIVER=fake cannot be used in production/)
    expect(r.output).toMatch(/fabricated business data presented as real/)
  })

  it('refuses LLM_DRIVER=fake in production', () => {
    const r = loadConfig({ NODE_ENV: 'production', LLM_DRIVER: 'fake' })
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/LLM_DRIVER=fake cannot be used in production/)
  })

  it('still allows the fake drivers outside production', () => {
    // The whole test suite depends on this staying true.
    const r = loadConfig({ NODE_ENV: 'test', CRM_DRIVER: 'fake', LLM_DRIVER: 'fake', ALLOW_SELF_APPROVAL: 'true' })
    expect(r.code).toBe(0)
    expect(r.output).toContain('CONFIG_LOADED')
  })
})

describe('the configuration does not depend on accidental shell overrides', () => {
  it('reads its database from configuration, not from an inherited variable', () => {
    // A stray DATABASE_URL in the shell belongs to NXT Sales. The marketing
    // agent must not silently adopt it.
    const r = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://someone:else@127.0.0.1:9999/not_ours',
    })
    expect(r.output).toContain('CONFIG_LOADED')
  })

  it('fails loudly when its own required variable is absent', () => {
    const r = loadConfig({ NODE_ENV: 'development', MARKETING_DATABASE_URL: '' })
    expect(r.code).toBe(1)
    expect(r.output).not.toContain('CONFIG_LOADED')
  })
})
