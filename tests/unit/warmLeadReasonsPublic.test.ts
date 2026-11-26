import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The keyed fingerprint (and the id of its key) is a SERVER-SIDE fact. It is stored in the evidence line of an opt-out proposal because the
// administrator's approval is checked against it, but it must never reach a browser or NXT Sales. Every place that returns stored reasons goes
// through reasonsPublic. The database is a stand-in.

const h = vi.hoisted(() => ({
  company: { id: 'row1', tenantId: 't1', crmCompanyId: 'c1', name: 'Acme' } as Record<string, any>,
  evaluations: [] as Array<Record<string, any>>,
  run: { id: 'r1', companyIds: ['c1'], createdAt: new Date('2026-11-01T00:00:00Z') } as Record<string, any>,
}))
vi.mock('../../src/platform/db.js', () => ({
  newId: () => 'id',
  prisma: {
    warmLeadCompany: { findUnique: async () => h.company },
    warmLeadEvaluation: { findMany: async () => h.evaluations },
    warmLeadRun: { findFirst: async () => h.run },
  },
}))

import { companyDetail } from '../../src/warmleads/companies.js'
import { pilotResults } from '../../src/warmleads/pilot.js'
import { publicEvaluation, redactEvidence, redactReasons } from '../../src/warmleads/reasonsPublic.js'

const FP = '0123456789abcdef'
const KEY = '89abcdef'
const LINE = { signal: 'opt_out_proposal', summary: 'r***@acme.example is PROPOSED', evidence: `status: awaiting_approval · NXT activity act_1 · received 2026-11-03 · fp ${FP} · key ${KEY} · phrase: UNSUBSCRIBE · one address only` }
const evaluation = (over: Record<string, any> = {}) => ({ id: 'e1', crmCompanyId: 'c1', status: 'done', score: 10, costUsd: 0, createdAt: new Date('2026-11-02T00:00:00Z'), reasons: [LINE, { signal: 'x', summary: 'y', evidence: null }], ...over })

beforeEach(() => {
  h.evaluations = [evaluation()]
})

describe('the helper', () => {
  it('removes exactly the fingerprint and the key id from an evidence line, and nothing else', () => {
    expect(redactEvidence(LINE.evidence)).toBe('status: awaiting_approval · NXT activity act_1 · received 2026-11-03 · phrase: UNSUBSCRIBE · one address only')
    expect(redactEvidence('status: dry_run · NXT activity act_1 · received 2026-11-03')).toBe('status: dry_run · NXT activity act_1 · received 2026-11-03')
    expect(redactEvidence('an ordinary fp 123 sentence about a key abc')).toBe('an ordinary fp 123 sentence about a key abc')
  })
  it('redactReasons keeps every other field and tolerates anything stored', () => {
    const out = redactReasons([LINE, { signal: 'x', summary: 'y', evidence: null }, null, 'odd', { signal: 'z' }]) as unknown[]
    expect(out[0]).toEqual({ ...LINE, evidence: redactEvidence(LINE.evidence) })
    expect(out.slice(1)).toEqual([{ signal: 'x', summary: 'y', evidence: null }, null, 'odd', { signal: 'z' }])
    expect(redactReasons(null)).toBeNull()
    expect(redactReasons('text' as never)).toBe('text')
    expect(redactReasons(undefined)).toBeUndefined()
    const original = [LINE]
    redactReasons(original)
    expect(original[0]!.evidence).toContain(FP) // the stored row itself is never changed
  })
  it('publicEvaluation redacts a row\'s reasons and leaves a row without reasons alone', () => {
    expect(JSON.stringify(publicEvaluation(evaluation()))).not.toContain(FP)
    const bare = { id: 'e2', reasons: null }
    expect(publicEvaluation(bare)).toBe(bare)
  })
})

describe('every API output of stored reasons is redacted', () => {
  it('companyDetail (GET /companies/:id): the history carries no fingerprint', async () => {
    const r = await companyDetail('t1', 'c1')
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${FP}|${KEY}`))
    expect(JSON.stringify(r)).toContain('phrase: UNSUBSCRIBE') // the rest of the evidence is still there
  })
  it('pilotResults (GET /pilot/results): no fingerprint', async () => {
    const r = await pilotResults('t1')
    expect(r).toHaveLength(1)
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${FP}|${KEY}`))
  })
  it('SOURCE SCAN: each place in src/warmleads that hands stored reasons to an API or to NXT Sales goes through reasonsPublic', () => {
    const read = (f: string) => fs.readFileSync(path.resolve('src/warmleads', f), 'utf8')
    expect(read('companies.ts')).toMatch(/history\.map\(\(e\) => publicEvaluation\(/)
    expect(read('pilot.ts')).toMatch(/latest\.map\(\(e\) => publicEvaluation\(/)
    const svc = read('service.ts')
    expect(svc).toMatch(/evaluations\.map\(\(e\) => publicEvaluation\(/) // runDetail (GET /runs/:id)
    expect(svc).toMatch(/reasons: redactReasons\(e\.reasons \?\? \[\]\)/) // syncEvaluation -> NXT Sales
    expect(read('sync.ts')).toMatch(/reasons: reasonsForCrm\(e\.reasons \?\? \[\]\)/) // syncPending -> NXT Sales (redacted, and without the opt-out details)
    // and nothing else in the module returns a raw `reasons` column to a caller or a transport
    for (const f of fs.readdirSync(path.resolve('src/warmleads')).filter((x) => x.endsWith('.ts'))) {
      const src = read(f)
      const raw = src.match(/reasons: e\.reasons\b(?! \?\? \[\] as)/g) ?? []
      expect(raw.length, `${f} sends a raw e.reasons`).toBe(0)
    }
  })
  it('SOURCE SCAN: no other code path reads stored evaluations (and so raw reasons) - the unused recentEvaluations() helper stays removed', () => {
    // Every file under src that reads WarmLeadEvaluation rows is one of these, each checked above (or, for optOutReview, reduced to booleans and
    // reason codes by toPublicItem). A new reader must be added here deliberately, after it redacts - that is the point of this list.
    const READERS = new Set(['warmleads/sync.ts', 'warmleads/optOutReview.ts', 'warmleads/service.ts', 'warmleads/companies.ts', 'warmleads/pilot.ts'])
    const found: string[] = []
    const walk = (dir: string) => {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n)
        if (fs.statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') && /warmLeadEvaluation\.(?:find|aggregate|groupBy)|FROM "WarmLeadEvaluation"/.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(path.resolve('src'), p).split(path.sep).join('/'))
      }
    }
    walk(path.resolve('src'))
    expect(found.filter((f) => !READERS.has(f))).toEqual([])
    const view = fs.readFileSync(path.resolve('src/warmleads/view.ts'), 'utf8')
    expect(view).not.toMatch(/recentEvaluations|warmLeadEvaluation/)
    for (const f of found) expect(fs.readFileSync(path.resolve('src', f), 'utf8'), `${f} must not export a raw evaluation reader`).not.toMatch(/export (?:async )?function recentEvaluations/)
  })
})
