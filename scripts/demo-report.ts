import { readFileSync, writeFileSync } from 'node:fs'

// PHASE 4 — rank the 20 on REAL evidence, then split 10 demo / 10 test.
//
// The score below reads only what the engines actually produced. It invents no
// number, and it cannot: every term is a fact recorded during the run.

interface Company {
  crmCompanyId: string
  name: string
  domain: string | null
  country: string | null
  industry: string | null
  source: string
  batch: string
}
interface EngineResult { status: string; detail: string; data?: Record<string, unknown> }
type Row = Partial<Record<string, EngineResult>>

const { cohort, results } = JSON.parse(readFileSync('scripts/.demo-results.json', 'utf8')) as {
  cohort: Company[]
  results: Record<string, Row>
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0)

function scoreOf(r: Row): { score: number; why: string[] } {
  const why: string[] = []
  let s = 0

  const pages = num(r.websiteAudit?.data?.pagesFetched)
  if (pages > 0) { s += Math.min(pages, 25); why.push(`${pages} pages crawled`) }
  const products = num(r.websiteAudit?.data?.productPages)
  if (products > 0) { s += products * 3; why.push(`${products} product pages`) }

  const findings = num(r.auditReport?.data?.findings)
  if (findings > 0) { s += Math.min(findings * 4, 30); why.push(`${findings} audit findings`) }

  if (r.enrichment?.status === 'ok') { s += 8; why.push('enrichment succeeded') }
  const tech = num(r.enrichment?.data?.technologies)
  if (tech > 0) { s += Math.min(tech * 2, 10); why.push(`${tech} technology signals`) }

  const signals = num(r.intent?.data?.signals)
  if (signals > 0) { s += Math.min(signals * 3, 12); why.push(`${signals} intent signals`) }

  const dm = num(r.decisionMakers?.data?.candidates)
  if (dm > 0) { s += Math.min(dm * 2, 8); why.push(`${dm} decision-maker candidates`) }

  if (r.workbench?.status === 'ok') { s += 12; why.push('Workbench built') }

  const events = num(r.engagement?.data?.events)
  if (events > 0) { s += Math.min(events, 10); why.push(`${events} engagement events`) }

  const iscore = num(r.intentScore?.data?.score)
  if (iscore > 0) { s += Math.min(iscore / 5, 20); why.push(`intent score ${iscore}`) }

  const qs = String(r.qualification?.data?.status ?? '')
  if (qs.startsWith('qualified')) { s += 20; why.push(`qualified (${qs})`) }

  if (r.crmHandoff?.data?.state === 'awaiting_user_approval') { s += 15; why.push('handoff awaiting human approval') }

  // A confusing failure is a cost at a demo, not a neutral.
  const errs = Object.entries(r).filter(([, v]) => v?.status === 'error')
  if (errs.length) { s -= errs.length * 10; why.push(`${errs.length} engine error(s)`) }

  return { score: Math.round(s), why }
}

const ranked = cohort
  .map((c) => {
    const r = results[c.crmCompanyId] ?? {}
    const { score, why } = scoreOf(r)
    return { ...c, score, why, r }
  })
  .sort((a, b) => b.score - a.score)

const demo = ranked.slice(0, 10)
const test = ranked.slice(10)

console.log('RANKING — real evidence only\n')
console.log('  #   score  company                              basis')
ranked.forEach((c, i) => {
  console.log(
    `  ${String(i + 1).padStart(2)}  ${String(c.score).padStart(5)}  ${c.name.slice(0, 34).padEnd(34)} ${c.why.slice(0, 3).join(', ') || 'no engine produced output'}`,
  )
})

console.log('\n\nBATCH B — MANAGER DEMO (top 10)')
demo.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}  —  ${c.why.join('; ') || 'nothing produced'}`))

console.log('\nBATCH A — TEST / EDGE CASES (remaining 10)')
test.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}  —  ${c.why.join('; ') || 'nothing produced'}`))

writeFileSync(
  'scripts/.demo-batches.json',
  JSON.stringify(
    {
      demo: demo.map((c) => ({ crmCompanyId: c.crmCompanyId, name: c.name, domain: c.domain, score: c.score, why: c.why })),
      test: test.map((c) => ({ crmCompanyId: c.crmCompanyId, name: c.name, domain: c.domain, score: c.score, why: c.why })),
    },
    null,
    2,
  ),
)
console.log('\nWrote scripts/.demo-batches.json')
