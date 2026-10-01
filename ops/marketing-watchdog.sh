#!/usr/bin/env bash
# THE MARKETING AI AGENT'S WATCHDOG (2026-10-01).
#
# Run every minute by nxt-marketing-watchdog.timer. pm2 already restarts a
# process that exits; this covers the two cases pm2 cannot see:
#
#   1. HUNG.   The API is still a running process but no longer answers. pm2
#              thinks all is well. /health is a pure liveness check — it does
#              not touch the database — so it fails only when the process
#              itself is stuck. Three misses in a row (about three minutes)
#              and the API is restarted.
#
#   2. GIVEN UP OR GONE. pm2 stops retrying after max_restarts, and a process
#              can be deleted by hand. Either way it is no longer "online", and
#              this starts it again from ecosystem.config.cjs.
#
# IT ONLY EVER TOUCHES nxt-marketing-api AND nxt-marketing-worker. It never
# runs `pm2 restart all`, `pm2 resurrect`, `pm2 save` or `pm2 kill`, so no
# other application on this server is started, stopped or re-registered by it.
#
# Every action is written to the journal:
#   journalctl -u nxt-marketing-watchdog --since today

set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_URL="${MARKETING_HEALTH_URL:-http://127.0.0.1:4100/health}"
FAIL_LIMIT="${MARKETING_HEALTH_FAIL_LIMIT:-3}"
# A process younger than this is still starting up; it is not judged yet.
GRACE_SECONDS=90
STATE_DIR=/run/nxt-marketing-watchdog
mkdir -p "$STATE_DIR"

PM2="$(command -v pm2 || echo /usr/local/bin/pm2)"

log() { echo "[watchdog] $*"; }

# name -> "status uptime_seconds", or "missing"
status_of() {
  "$PM2" jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = []; try { list = JSON.parse(s) } catch {}
      const p = list.find((x) => x.name === process.argv[1])
      if (!p) return console.log("missing")
      const up = p.pm2_env.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0
      console.log(`${p.pm2_env.status} ${up}`)
    })' "$1"
}

ensure_running() {
  local name="$1" state status
  state="$(status_of "$name")"
  status="${state%% *}"
  case "$status" in
    online) return 0 ;;
    # Transient: pm2 is already restarting it. Leave it, and do not count a
    # health miss this round — status is cut at the first space, so pm2's
    # "waiting restart" arrives here as "waiting".
    launching|waiting|stopping) return 1 ;;
    missing)
      log "$name is not registered with pm2 — starting it from ecosystem.config.cjs"
      (cd "$APP_DIR" && "$PM2" start ecosystem.config.cjs --only "$name" >/dev/null) \
        && log "$name started" || log "$name could NOT be started"
      ;;
    *)
      log "$name is '$status' — restarting it"
      "$PM2" restart "$name" >/dev/null && log "$name restarted" || log "$name could NOT be restarted"
      ;;
  esac
  return 1
}

ensure_running nxt-marketing-worker
if ! ensure_running nxt-marketing-api; then
  # Just (re)started, or pm2 is mid-restart: judge it on the next run.
  rm -f "$STATE_DIR/api-fails"
  exit 0
fi

# Too young to judge — it may still be connecting to the database.
api_uptime="$(status_of nxt-marketing-api | awk '{print $2}')"
if [ "${api_uptime:-0}" -lt "$GRACE_SECONDS" ]; then
  exit 0
fi

if curl -fsS -m 10 -o /dev/null "$HEALTH_URL"; then
  rm -f "$STATE_DIR/api-fails"
  exit 0
fi

fails=$(( $(cat "$STATE_DIR/api-fails" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE_DIR/api-fails"
log "nxt-marketing-api did not answer $HEALTH_URL ($fails of $FAIL_LIMIT)"

if [ "$fails" -ge "$FAIL_LIMIT" ]; then
  log "nxt-marketing-api has been unresponsive for $fails checks — restarting it"
  "$PM2" restart nxt-marketing-api >/dev/null && log "nxt-marketing-api restarted" || log "nxt-marketing-api could NOT be restarted"
  rm -f "$STATE_DIR/api-fails"
fi
