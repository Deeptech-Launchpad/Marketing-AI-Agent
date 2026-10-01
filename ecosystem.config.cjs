// HOW THE MARKETING AI AGENT RUNS ON THE SERVER, 24/7 (2026-10-01).
//
//   pm2 start ecosystem.config.cjs      first time, or after `pm2 delete`
//   pm2 restart ecosystem.config.cjs    after a deploy
//
// Two processes, both required: the API (behind nginx on :8110) and the
// worker that runs the queued engine jobs. Neither does anything the other can
// cover for, so both are watched and both come back.
//
// WHY THESE SETTINGS, AND NOT PM2'S DEFAULTS.
//
//   node, not npm   The processes used to run as `npm start`, so pm2 watched
//                   the npm wrapper rather than the app. Signals and exit codes
//                   then pass through a middleman, and a killed wrapper can
//                   leave the real process orphaned. This runs exactly the same
//                   command — `node dist/index.js` — with nothing in between.
//
//   backoff         pm2's default gives up for good after 16 restarts that
//                   each last under a second. After a reboot the API can start
//                   before PostgreSQL is accepting connections, fail fast, and
//                   hit that limit in a few seconds — and then stay down. With
//                   an exponential delay (0.2s, growing to 15s) the same 50
//                   attempts span about ten minutes, which is far longer than
//                   the database ever needs.
//
//   kill_timeout    Both processes shut down cleanly on SIGINT (the queue is
//                   stopped, connections closed). pm2's default 1.6s can cut
//                   that short; 10s lets it finish.
//
//   memory ceiling  A leak is restarted at 1 GB rather than allowed to take
//                   the server down with it. Both normally sit under 100 MB.
//
// No env block, on purpose: .env is the only place configuration lives. A
// value set here would silently win over .env (dotenv never overrides an
// existing variable), which is exactly the kind of drift that is hard to find.
//
// Behind this, ops/marketing-watchdog.sh covers what pm2 cannot see: a process
// that is alive but no longer answering, or one pm2 has given up on.

const common = {
  cwd: __dirname,
  autorestart: true,
  exp_backoff_restart_delay: 200,
  max_restarts: 50,
  min_uptime: '10s',
  kill_timeout: 10000,
  max_memory_restart: '1G',
  watch: false,
}

module.exports = {
  apps: [
    { name: 'nxt-marketing-api', script: 'dist/index.js', ...common },
    { name: 'nxt-marketing-worker', script: 'dist/worker.js', ...common },
  ],
}
