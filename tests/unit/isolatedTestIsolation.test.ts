import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// THE ISOLATED WARM-LEAD TEST CAN REACH NO QUEUE, SCHEDULER, API, MAIL CODE OR CAMPAIGN CODE.
//
// The runner imports warmleads/service.ts, warmleads/sample.ts and the safety
// helpers, and nothing else. This follows every import of those modules and
// fails if any path leads to the queue, the worker, the web server, the
// outreach / bulk-email code, an approval or orchestration step, or a mail
// library — so a future import cannot quietly give the test a way to send.

const root = path.resolve('src')

function closure(entries: string[]): Set<string> {
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
  return seen
}

describe('what the isolated test can reach', () => {
  const seen = closure(['warmleads/service.ts', 'warmleads/sample.ts', 'warmleads/isolatedTestSafety.ts'])
  const rel = [...seen].map((f) => path.relative(root, f).split(path.sep).join('/'))

  it('is a real, substantial closure (so an empty result cannot pass by accident)', () => {
    expect(rel.length).toBeGreaterThan(40)
    expect(rel).toContain('warmleads/service.ts')
    expect(rel).toContain('crm/nxtSales/httpClient.ts')
    expect(rel).toContain('llm/gemini/geminiGateway.ts')
    expect(rel).toContain('research/pageFetch.ts')
  })

  it('never reaches the queue, worker, web server or any scheduler', () => {
    for (const bad of ['platform/queue.ts', 'worker.ts', 'index.ts', 'app.ts', 'intent/intentMonitor.ts', 'decisionmakers/leadWatch.ts', 'intentscore/trigger.ts', 'crmsync/trigger.ts', 'salesqualification/trigger.ts']) {
      expect(rel, bad).not.toContain(bad)
    }
  })

  it('never reaches outreach, bulk email, API routes, orchestration or approvals', () => {
    expect(rel.filter((x) => /^(outreach|api|orchestrator|approval)\//.test(x))).toEqual([])
  })

  it('never imports a mail, queue or server library', () => {
    const libs = [...seen].filter((f) => /from '(nodemailer|pg-boss|express|imapflow|googleapis|@google-cloud\/[^']+)'/.test(fs.readFileSync(f, 'utf8')))
    expect(libs.map((f) => path.relative(root, f))).toEqual([])
  })
})
