import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Front-end tests run in a DOM, against the real components.
//
// `fetch` is stubbed per test so a component's behaviour is judged by the
// requests it actually makes — which is the only way to prove the thing that
// matters most here: that an approver identity is never sent, and that no CRM
// payload field can leave this interface.

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // One fork, deliberately.
    //
    // Under parallel workers this suite has exited 0 having silently run four
    // of its six files: a worker died ("Worker exited unexpectedly"), its
    // files never reported, and the summary counted only what survived. A
    // green run that skipped a third of the tests is worse than a red one, and
    // these suites are fast enough that serialising them costs nothing.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
