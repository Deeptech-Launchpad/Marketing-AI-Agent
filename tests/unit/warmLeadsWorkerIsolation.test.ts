import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// THE WARM LEADS WORKER IS ISOLATED FROM EVERYTHING THAT SENDS OR SCHEDULES.
//
// It runs in its own PM2 process. This follows every import of its entry point and fails if any path
// leads to the job queue, the main worker, the web server, the outreach / bulk-email code, an approval or
// orchestration step, a mail library - so a future import cannot quietly give Warm Leads a way to send an
// email or to take another feature's job. It also proves the reverse: the main worker and the API do not
// start Warm Leads' loop.

const root = path.resolve('src')

function closure(entries: string[]): string[] {
  const seen = new Set<string>()
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const p = path.resolve(path.dirname(from), spec).replace(/\.js$/, '.ts')
    if (fs.existsSync(p)) return p
    const idx = p.replace(/\.ts$/, '/index.ts')
    return fs.existsSync(idx) ? idx : null
  }
  const walk = (f: string) => {
    if (seen.has(f)) return
    seen.add(f)
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const r = resolve(f, (m[1] ?? m[2])!)
      if (r) walk(r)
    }
  }
  entries.forEach((e) => walk(path.join(root, e)))
  return [...seen].map((f) => path.relative(root, f).split(path.sep).join('/'))
}

const libsIn = (files: string[]) =>
  files.filter((f) => /from '(nodemailer|pg-boss|express|imapflow|googleapis|@google-cloud\/[^']+)'/.test(fs.readFileSync(path.join(root, f), 'utf8')))

describe('what the Warm Leads worker can reach', () => {
  const rel = closure(['warmleadsWorker.ts'])

  it('is a real, substantial closure (so an empty result cannot pass by accident)', () => {
    expect(rel.length).toBeGreaterThan(40)
    for (const f of ['warmleads/workerLoop.ts', 'warmleads/scheduler.ts', 'warmleads/usageStore.ts', 'warmleads/sync.ts', 'crm/nxtSales/httpClient.ts', 'llm/gemini/geminiGateway.ts', 'research/pageFetch.ts']) {
      expect(rel, f).toContain(f)
    }
  })

  it('never reaches the job queue, the main worker, the web server or any other feature’s scheduler', () => {
    for (const bad of [
      'platform/queue.ts',
      'worker.ts',
      'index.ts',
      'app.ts',
      'intent/intentMonitor.ts',
      'decisionmakers/leadWatch.ts',
      'intentscore/trigger.ts',
      'crmsync/trigger.ts',
      'salesqualification/trigger.ts',
      'outreach/bulk/service.ts',
    ]) {
      expect(rel, bad).not.toContain(bad)
    }
  })

  it('never reaches outreach, bulk email, API routes, orchestration or approvals', () => {
    expect(rel.filter((x) => /^(outreach|api|orchestrator|approval)\//.test(x))).toEqual([])
  })

  it('never imports a mail, queue or server library', () => {
    expect(libsIn(rel)).toEqual([])
  })

  it('declares both guards before it does anything else', () => {
    const src = fs.readFileSync(path.join(root, 'warmleadsWorker.ts'), 'utf8')
    const guards = Math.max(src.indexOf('setCrmProcessReadOnly(true)'), src.indexOf('requireGeminiBudget(true)'))
    expect(src.indexOf('setCrmProcessReadOnly(true)')).toBeGreaterThan(-1)
    expect(src.indexOf('requireGeminiBudget(true)')).toBeGreaterThan(-1)
    expect(guards).toBeLessThan(src.indexOf('async function main'))
  })
})

describe('the other processes do not run Warm Leads', () => {
  it('the main worker has no Warm Leads code and no Warm Leads queue', () => {
    const rel = closure(['worker.ts'])
    expect(rel.filter((x) => x.startsWith('warmleads/') || x === 'warmleadsWorker.ts')).toEqual([])
    expect(fs.readFileSync(path.join(root, 'platform/queue.ts'), 'utf8')).not.toMatch(/warmleads\.evaluate/)
  })

  it('the API serves the screen but never starts the worker loop', () => {
    const rel = closure(['index.ts'])
    expect(rel).not.toContain('warmleads/workerLoop.ts')
    expect(rel).not.toContain('warmleadsWorker.ts')
    expect(rel).not.toContain('warmleads/scheduler.ts')
  })
})

describe('the process definition', () => {
  const eco = fs.readFileSync(path.resolve('ecosystem.config.cjs'), 'utf8')
  it('is a separate PM2 app with its own, lower memory ceiling', () => {
    expect(eco).toMatch(/name: 'nxt-marketing-warmleads', script: 'dist\/warmleadsWorker\.js'/)
    expect(eco).toMatch(/max_memory_restart: '1200M'/)
    expect(eco).toMatch(/name: 'nxt-marketing-api'/)
    expect(eco).toMatch(/name: 'nxt-marketing-worker'/)
  })
  it('the watchdog still touches only the API and the main worker', () => {
    const wd = fs.readFileSync(path.resolve('ops/marketing-watchdog.sh'), 'utf8')
    expect(wd).not.toMatch(/warmleads/)
  })
})

describe('only one place can write to NXT Sales for Warm Leads', () => {
  it('the sync module is the only caller of the Warm Leads sender (besides the legacy test runner’s service)', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
    const users = walk(root)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /crmWarmLeads(Put|Delete)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .sort()
    expect(users).toEqual(['crm/nxtSales/httpClient.ts', 'warmleads/service.ts', 'warmleads/sync.ts'])
    // service.ts is the legacy 30-company run path: nothing in the permanent module calls it for syncing.
    const loop = fs.readFileSync(path.join(root, 'warmleads/workerLoop.ts'), 'utf8')
    expect(loop).not.toMatch(/resyncPending|startRun|evaluateCompany\(/)
  })
})
