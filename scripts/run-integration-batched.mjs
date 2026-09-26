import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

// Runs the integration suite in SMALL BATCHES.
//
// This machine has 6 GB of RAM. A single vitest process holding all nineteen
// files accumulates enough that the worker is killed part-way through, which
// shows up as "Worker exited unexpectedly" and — worse — as a run that reports
// a partial tally and still exits 0.
//
// Batching bounds the memory any one process can reach. It costs startup time
// per batch and buys a result that is actually complete.

const BATCH = Number(process.env.INTEGRATION_BATCH ?? 4)
const files = readdirSync('tests/integration')
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => `tests/integration/${f}`)

let passed = 0
let failed = 0
let skipped = 0
const failures = []

for (let i = 0; i < files.length; i += BATCH) {
  const batch = files.slice(i, i + BATCH)
  const label = `${i / BATCH + 1}/${Math.ceil(files.length / BATCH)}`
  console.log(`\n=== batch ${label}: ${batch.map((b) => b.split('/').pop()).join(', ')}`)

  const res = spawnSync(
    'npx',
    ['vitest', 'run', ...batch, '--pool=forks', '--poolOptions.forks.singleFork=true', '--reporter=basic'],
    { encoding: 'utf8', shell: true, env: { ...process.env, TEST_USE_REAL: '1' }, maxBuffer: 64 * 1024 * 1024 },
  )

  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '')
  const tally = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?/)
  if (tally) {
    failed += Number(tally[1] ?? 0)
    passed += Number(tally[2] ?? 0)
    skipped += Number(tally[3] ?? 0)
    console.log(`    ${tally[2]} passed, ${tally[1] ?? 0} failed, ${tally[3] ?? 0} skipped`)
  } else {
    console.log('    NO TALLY — the batch did not report; treating as a failure')
    failed += 1
  }

  for (const m of out.matchAll(/^\s*FAIL\s+(.+)$/gm)) failures.push(m[1].trim())
  if (/Worker exited unexpectedly/.test(out)) {
    console.log('    WARNING: a worker died in this batch — the tally above may be short')
    failures.push(`${label}: worker died`)
  }
}

console.log('\n' + '='.repeat(60))
console.log(`INTEGRATION TOTAL: ${passed} passed, ${failed} failed, ${skipped} skipped`)
for (const f of [...new Set(failures)]) console.log(`  FAIL ${f}`)
process.exit(failed > 0 ? 1 : 0)
