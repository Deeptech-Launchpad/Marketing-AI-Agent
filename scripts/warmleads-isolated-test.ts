// THE ISOLATED 30-COMPANY WARM-LEAD TEST (2026-11-03). Read the CRM, write nothing.
//
// A single sequential process: no web server, no worker, no queue, no scheduler,
// no mail code (a test proves the code it imports reaches none of them). It
// builds the fixed-seed sample from the live CRM — GET requests only, through a
// transport that refuses every other method — evaluates the companies one at a
// time with the same service code the worker uses, and keeps every result in
// its own database. Nothing is sent to NXT Sales.
//
//   --preflight   run every safety check (no CRM, no Gemini), print the redacted
//                 configuration and PASS/FAIL for each check, and stop
//   --run         preflight with the 11 PM – 6 AM IST window enforced, then the test
//   --out <file>  where to write the JSON report (default: ./report-<runId>.json)
//
// Exit codes: 0 done · 1 a safety check failed · 2 error · 3 stopped (memory) · 4 stopped (window)

import fs from 'node:fs'
import os from 'node:os'
import { env } from '../src/config/env.js'
import { assertReadOnlyAllowed, crmRequestStats, CrmReadOnlyViolation } from '../src/crm/nxtSales/httpClient.js'
import { geminiCallStats } from '../src/llm/gemini/callCeiling.js'
import { prisma, pooledDatabaseUrl } from '../src/platform/db.js'
import { assertAllowedPort, BlockedAddressError, createPinnedLookup, isBlockedIP } from '../src/research/ssrfGuard.js'
import { pinnedRequest } from '../src/research/pageFetch.js'
import {
  allPass,
  evaluateSafetyChecks,
  istWindowOpen,
  MIN_RUN_AVAILABLE_MB,
  parseMemAvailableMb,
  redactDatabaseUrl,
  redactSecret,
  SENDING_CREDENTIALS,
  tokenSecondsRemaining,
  type SafetySnapshot,
} from '../src/warmleads/isolatedTestSafety.js'
import { buildSample } from '../src/warmleads/sample.js'
import { evaluateCompany, finishRunIfDone, runCounts, runDetail, startRun } from '../src/warmleads/service.js'

const args = process.argv.slice(2)
const mode = args.includes('--run') ? 'run' : 'preflight'
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined

// ── the machine ─────────────────────────────────────────────────────────────

const availableMb = (): number | null => {
  try {
    return parseMemAvailableMb(fs.readFileSync('/proc/meminfo', 'utf8'))
  } catch {
    return null
  }
}

function readCgroup(): SafetySnapshot['cgroup'] {
  try {
    const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'))
    const dir = `/sys/fs/cgroup${(line ?? '0::').slice(3).trim()}`
    const mem = fs.readFileSync(`${dir}/memory.max`, 'utf8').trim()
    const [quota, period] = fs.readFileSync(`${dir}/cpu.max`, 'utf8').trim().split(' ')
    return { memoryMaxBytes: mem === 'max' ? null : Number(mem), cpuQuotaPct: quota === 'max' ? null : Math.round((Number(quota) / Number(period)) * 100) }
  } catch {
    return { memoryMaxBytes: null, cpuQuotaPct: null }
  }
}

// ── canaries: cheap proofs, with no network, that the protections are the ones that loaded ──

function hardenedReaderLoaded(): boolean {
  try {
    let portRefused = false
    try {
      assertAllowedPort(new URL('https://example.test:8080/'))
    } catch (e) {
      portRefused = e instanceof BlockedAddressError
    }
    return portRefused && isBlockedIP('198.18.0.1') && isBlockedIP('64:ff9b::7f00:1') && isBlockedIP('2002:808:808::1') && !isBlockedIP('64:ff9b::808:808') && typeof createPinnedLookup === 'function' && typeof pinnedRequest === 'function'
  } catch {
    return false
  }
}

function readOnlyGuardWorks(): boolean {
  if (!env.CRM_READ_ONLY) return false
  const base = env.NXT_SALES_BASE_URL
  const refused = (method: string, p: string) => {
    try {
      assertReadOnlyAllowed(method, `${base}${p}`)
      return false
    } catch (e) {
      return e instanceof CrmReadOnlyViolation
    }
  }
  const allowed = () => {
    try {
      assertReadOnlyAllowed('GET', `${base}/api/deals/export`)
      return true
    } catch {
      return false
    }
  }
  return ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].every((m) => refused(m, '/api/companies')) && refused('GET', '/api/users') && refused('GET', '/api/companies/export') && refused('GET', '/api/marketing-bulk/send') && allowed()
}

// ── the snapshot, the redacted configuration, the checks ────────────────────

async function snapshot(): Promise<SafetySnapshot> {
  const token = env.NXT_SALES_STATIC_TOKEN
  let connectedDatabase: string | null = null
  try {
    const r = await prisma.$queryRaw<Array<{ d: string }>>`select current_database() as d`
    connectedDatabase = r[0]?.d ?? null
  } catch {
    connectedDatabase = null
  }
  const pool = Number(new URL(pooledDatabaseUrl()).searchParams.get('connection_limit'))
  const stats = geminiCallStats()
  return {
    env: {
      CRM_READ_ONLY: env.CRM_READ_ONLY,
      CRM_WRITE_ENABLED: env.CRM_WRITE_ENABLED,
      CRM_WRITE_ALLOW_LIVE: env.CRM_WRITE_ALLOW_LIVE,
      WARM_LEADS_SYNC_ENABLED: env.WARM_LEADS_SYNC_ENABLED,
      WARM_LEADS_ALLOW_LIVE: env.WARM_LEADS_ALLOW_LIVE,
      BULK_EMAIL_ENABLED: env.BULK_EMAIL_ENABLED,
      DM_AUTO_DISCOVER_ENABLED: env.DM_AUTO_DISCOVER_ENABLED,
      INTENT_MONITOR_ENABLED: env.INTENT_MONITOR_ENABLED,
      OUTREACH_EMAIL_MODE: env.OUTREACH_EMAIL_MODE,
      BULK_SEND_VIA: env.BULK_SEND_VIA,
      GEMINI_CALL_CEILING: env.GEMINI_CALL_CEILING,
      WARM_LEADS_DEEP_MAX_PER_RUN: env.WARM_LEADS_DEEP_MAX_PER_RUN,
      WARM_LEADS_REPLY_PROBE_CAP: env.WARM_LEADS_REPLY_PROBE_CAP,
      WARM_LEADS_SAMPLE_SEED: env.WARM_LEADS_SAMPLE_SEED,
      NXT_SALES_MAX_CONCURRENCY: env.NXT_SALES_MAX_CONCURRENCY,
      GEMINI_MAX_CONCURRENCY: env.GEMINI_MAX_CONCURRENCY,
      PUBLIC_RESEARCH_ENABLED: env.PUBLIC_RESEARCH_ENABLED,
    },
    databaseUrl: env.MARKETING_DATABASE_URL,
    dbPoolSize: Number.isFinite(pool) ? pool : null,
    sendingCredentialsPresent: SENDING_CREDENTIALS.filter((n) => (process.env[n] ?? '') !== ''),
    staticTokenSet: token !== '',
    tokenSecondsRemaining: token ? tokenSecondsRemaining(token) : null,
    availableMb: availableMb(),
    cgroup: readCgroup(),
    connectedDatabase,
    windowOpen: istWindowOpen(new Date()),
    windowEnforced: mode === 'run',
    canaries: { hardenedReader: hardenedReaderLoaded(), readOnlyGuard: readOnlyGuardWorks(), ceilingActive: stats.ceiling === 60 && stats.attempted === 0 },
  }
}

function printConfig(): void {
  const rows: Array<[string, string]> = [
    ['MARKETING_DATABASE_URL', redactDatabaseUrl(env.MARKETING_DATABASE_URL)],
    ['  effective pool (connection_limit)', String(new URL(pooledDatabaseUrl()).searchParams.get('connection_limit'))],
    ['NXT_SALES_BASE_URL', env.NXT_SALES_BASE_URL],
    ['NXT_SALES_SERVICE_USER_ID', env.NXT_SALES_SERVICE_USER_ID],
    ['NXT_SALES_SERVICE_USER_EMAIL', env.NXT_SALES_SERVICE_USER_EMAIL],
    ['NXT_SALES_STATIC_TOKEN', `${redactSecret(env.NXT_SALES_STATIC_TOKEN)}${env.NXT_SALES_STATIC_TOKEN ? `, ${Math.round((tokenSecondsRemaining(env.NXT_SALES_STATIC_TOKEN) ?? 0) / 60)} min left` : ''}`],
    ['JWT_SECRET', `${redactSecret(env.JWT_SECRET)} (a throw-away value for this test; the production secret is not copied)`],
    ['GEMINI_API_KEY', redactSecret(env.GEMINI_API_KEY)],
    ['CRM_READ_ONLY', String(env.CRM_READ_ONLY)],
    ['CRM_WRITE_ENABLED', String(env.CRM_WRITE_ENABLED)],
    ['CRM_WRITE_ALLOW_LIVE', String(env.CRM_WRITE_ALLOW_LIVE)],
    ['WARM_LEADS_SYNC_ENABLED', String(env.WARM_LEADS_SYNC_ENABLED)],
    ['WARM_LEADS_ALLOW_LIVE', String(env.WARM_LEADS_ALLOW_LIVE)],
    ['BULK_EMAIL_ENABLED', String(env.BULK_EMAIL_ENABLED)],
    ['BULK_SEND_VIA', env.BULK_SEND_VIA],
    ['OUTREACH_EMAIL_MODE', env.OUTREACH_EMAIL_MODE],
    ['DM_AUTO_DISCOVER_ENABLED', String(env.DM_AUTO_DISCOVER_ENABLED)],
    ['INTENT_MONITOR_ENABLED', String(env.INTENT_MONITOR_ENABLED)],
    ['PUBLIC_RESEARCH_ENABLED', String(env.PUBLIC_RESEARCH_ENABLED)],
    ['GEMINI_CALL_CEILING', String(env.GEMINI_CALL_CEILING)],
    ['WARM_LEADS_DEEP_MAX_PER_RUN', String(env.WARM_LEADS_DEEP_MAX_PER_RUN)],
    ['WARM_LEADS_REPLY_PROBE_CAP', String(env.WARM_LEADS_REPLY_PROBE_CAP)],
    ['WARM_LEADS_SAMPLE_SEED', String(env.WARM_LEADS_SAMPLE_SEED)],
    ['NXT_SALES_MAX_CONCURRENCY', String(env.NXT_SALES_MAX_CONCURRENCY)],
    ['GEMINI_MAX_CONCURRENCY', String(env.GEMINI_MAX_CONCURRENCY)],
    ['RESEARCH_FETCH_TIMEOUT_MS / MAX_BYTES / MAX_REDIRECTS', `${env.RESEARCH_FETCH_TIMEOUT_MS} / ${env.RESEARCH_MAX_BYTES} / ${env.RESEARCH_MAX_REDIRECTS}`],
    ['sending / third-party credentials present', SENDING_CREDENTIALS.filter((n) => (process.env[n] ?? '') !== '').join(', ') || `none (${SENDING_CREDENTIALS.length} names checked)`],
    ['host', `${os.hostname()} · node ${process.version} · pid ${process.pid}`],
    ['code SHA-256', codeSha()],
  ]
  const w = Math.max(...rows.map((r) => r[0].length))
  console.log('EFFECTIVE CONFIGURATION (secret values redacted)')
  for (const [k, v] of rows) console.log(`  ${k.padEnd(w)}  ${v}`)
}

function codeSha(): string {
  if (process.env.CODE_SHA256) return process.env.CODE_SHA256
  try {
    return fs.readFileSync('.code-sha256', 'utf8').trim().split(/\s+/)[0] || 'unrecorded'
  } catch {
    return 'unrecorded'
  }
}

// ── memory watchdog and graceful stops ──────────────────────────────────────

let runId: string | null = null
let peakRssMb = 0
let minAvailableMb: number | null = null
let report: (extra?: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({})

async function haltRun(reason: string, code: number): Promise<never> {
  console.error(`\nSTOPPED: ${reason}`)
  try {
    if (runId) {
      await prisma.warmLeadEvaluation.updateMany({ where: { runId, status: 'running' }, data: { status: 'failed', error: `Stopped: ${reason}`, evaluatedAt: new Date() } })
      await prisma.warmLeadRun.update({ where: { id: runId }, data: { status: 'failed', failureReason: `Stopped: ${reason}`, finishedAt: new Date() } })
    }
    const r = await report({ stoppedBecause: reason })
    fs.writeFileSync(outFile ?? `./report-${runId ?? 'stopped'}.json`, JSON.stringify(r, null, 2))
  } catch (err) {
    console.error('could not save the stop state:', (err as Error).message)
  }
  process.exit(code)
}

function startWatchdog(): void {
  const t = setInterval(() => {
    const avail = availableMb()
    peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / 1048576))
    if (avail !== null) minAvailableMb = minAvailableMb === null ? avail : Math.min(minAvailableMb, avail)
    if (avail === null || avail < MIN_RUN_AVAILABLE_MB) void haltRun(`server memory available fell to ${avail ?? '?'} MB (the limit is ${MIN_RUN_AVAILABLE_MB} MB)`, 3)
  }, 3000)
  t.unref()
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`warm-lead isolated test · mode=${mode} · ${new Date().toISOString()} · IST window open: ${istWindowOpen(new Date())}\n`)
  printConfig()

  const checks = evaluateSafetyChecks(await snapshot())
  console.log('\nSAFETY CHECKS')
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  — ${c.detail}`)
  const passed = allPass(checks)
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks pass${mode === 'preflight' ? ' (the 11 PM – 6 AM IST window is enforced only with --run)' : ''}`)
  if (!passed) {
    console.error('\nA safety check failed. Nothing was read and nothing was run.')
    process.exit(1)
  }
  if (mode === 'preflight') return

  // A fresh database only, and only the approved test: nothing else may exist to be processed.
  if ((await prisma.warmLeadRun.count()) > 0) throw new Error('The test database already holds a warm-lead run. This test runs once, on an empty database.')
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: env.DEFAULT_TENANT_SLUG } })
  const baseline = crmRequestStats()
  const started = Date.now()
  startWatchdog()

  // 1. The sample: one read of the live CRM (GET only), shown before anything is evaluated.
  console.log('\nBUILDING THE FIXED-SEED SAMPLE from the live CRM (read-only)…')
  const built = await buildSample({ seed: env.WARM_LEADS_SAMPLE_SEED })
  const s = built.sample
  if (s.picks.length > 30) throw new Error(`The sample has ${s.picks.length} companies; the approved limit is 30.`)
  console.log(`seed ${s.seed} · ${s.picks.length} companies · ${s.countries} countries · ${s.industries} industries`)
  console.log('pool:', JSON.stringify(s.pool))
  console.log('coverage:', s.coverage.map((c) => `${c.stratum} ${c.filled}/${c.wanted}`).join(' · '))
  for (const n of s.notes) console.log('  note:', n)
  s.picks.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.name} | ${p.country ?? '—'} | ${p.industry ?? '—'} | ${p.website} | ${p.strata.filter((x) => x !== 'general').join(',') || 'ordinary'}`))

  // 2. The run record, with the same sample (no second read), and the jobs held here instead of in a queue.
  const jobs: string[] = []
  const started1 = await startRun({ tenantId: tenant.id, kind: 'test', requestedBy: 'isolated-test', enqueueJob: async (id) => void jobs.push(id), prebuilt: built })
  runId = started1.runId
  if (started1.total > 30) throw new Error(`The run has ${started1.total} companies; the approved limit is 30.`)
  const samplePickIds = s.picks.map((p) => p.id).sort().join(',')

  report = async (extra = {}) => {
    const d = await runDetail(tenant.id, runId!)
    const llm = await prisma.llmCall.findMany({ where: { tenantId: tenant.id }, select: { feature: true, model: true, priced: true, promptTokens: true, outputTokens: true, costUsd: true } })
    const byFeature: Record<string, number> = {}
    for (const c of llm) byFeature[c.feature] = (byFeature[c.feature] ?? 0) + 1
    const crmNow = crmRequestStats()
    return {
      runId,
      finishedAt: new Date().toISOString(),
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      codeSha256: codeSha(),
      host: os.hostname(),
      node: process.version,
      database: (await snapshot()).connectedDatabase,
      sample: { seed: s.seed, size: s.size, picks: s.picks, coverage: s.coverage, notes: s.notes, pool: s.pool, identicalToRun: d.run.sample ? (d.run.sample as { picks: Array<{ id: string }> }).picks.map((p) => p.id).sort().join(',') === samplePickIds : false },
      counts: await runCounts(runId!),
      gemini: { ...geminiCallStats(), ledgerRows: llm.length, ledgerByFeature: byFeature, ledgerUnpriced: llm.filter((c) => !c.priced).length, ledgerTokens: llm.reduce((n, c) => n + c.promptTokens + c.outputTokens, 0) },
      crm: { getRequestsAllowed: crmNow.allowed - baseline.allowed, requestsRefused: crmNow.blocked - baseline.blocked, writeAttempts: crmNow.blocked - baseline.blocked },
      resources: { peakRssMb, minAvailableMbSeen: minAvailableMb, cgroup: readCgroup() },
      evaluations: d.evaluations.map((e) => ({ company: e.companyName, crmCompanyId: e.crmCompanyId, status: e.status, classification: e.classification, score: e.score, confidence: e.confidence, deepCheck: e.deepCheck, summary: e.summary, error: e.error, reasons: e.reasons, costUsd: e.costUsd })),
      ...extra,
    }
  }

  // 3. One company at a time.
  console.log(`\nEVALUATING ${jobs.length} companies, one at a time…`)
  for (const [i, id] of jobs.entries()) {
    if (!istWindowOpen(new Date())) await haltRun('the execution window (11 PM – 6 AM IST) closed', 4)
    const t0 = Date.now()
    await evaluateCompany(id)
    const e = await prisma.warmLeadEvaluation.findUniqueOrThrow({ where: { id } })
    const g = geminiCallStats()
    console.log(`  ${String(i + 1).padStart(2)}/${jobs.length}  ${(e.companyName ?? '').slice(0, 30).padEnd(30)} ${e.status === 'done' ? (e.classification ?? '') : 'FAILED-RETRY'}  (${Math.round((Date.now() - t0) / 1000)} s · Gemini ${g.attempted}/${g.ceiling} · rss ${Math.round(process.memoryUsage().rss / 1048576)} MB)`)
  }
  await finishRunIfDone(runId)

  const final = await report()
  const file = outFile ?? `./report-${runId}.json`
  fs.writeFileSync(file, JSON.stringify(final, null, 2))
  console.log(`\nDONE. Report: ${file}`)
  console.log('counts:', JSON.stringify(final.counts))
  console.log('gemini:', JSON.stringify({ ...(final.gemini as object), byKind: undefined, ledgerByFeature: undefined }))
  console.log('crm   :', JSON.stringify(final.crm))
}

main()
  .then(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('\nERROR:', (err as Error).message)
    try {
      await prisma.$disconnect()
    } catch {
      /* nothing to do */
    }
    process.exit(2)
  })
