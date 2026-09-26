import { spawnSync } from 'node:child_process'

// Runs the integration suite against REAL services. Kept as a script rather
// than an inline env prefix so it works identically on Windows and POSIX —
// `VAR=x npm test` is not valid on cmd.exe, which is what npm uses there.
//
// Run in ONE fork, deliberately.
//
// Every file here talks to the same Postgres. Under parallel workers the
// suite has repeatedly exhausted its connection limit, and the way that
// presents is nasty: workers die ("Worker exited unexpectedly"), their files
// never report, unrelated tests fail on `findFirstOrThrow`, and vitest has
// still exited 0 — a green run that never ran. Serialising costs wall-clock
// and buys a result that means something.
const res = spawnSync(
  'npx',
  ['vitest', 'run', 'tests/integration', '--pool=forks', '--poolOptions.forks.singleFork=true'],
  {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, TEST_USE_REAL: '1' },
  },
)
process.exit(res.status ?? 1)
