import { spawnSync } from 'node:child_process'

// Runs the integration suite against REAL services. Kept as a script rather
// than an inline env prefix so it works identically on Windows and POSIX —
// `VAR=x npm test` is not valid on cmd.exe, which is what npm uses there.
const res = spawnSync('npx', ['vitest', 'run', 'tests/integration'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TEST_USE_REAL: '1' },
})
process.exit(res.status ?? 1)
