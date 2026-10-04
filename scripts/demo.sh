#!/usr/bin/env bash
# Demo-day commands (WORK-PLAN §5.3 OPS step 4). Never prints connection strings or keys.
#
#   npm run demo:reset      stop the demo server (kills any in-flight team run), reseed the demo branch
#   npm run demo:server     the server on :8787 against the demo branch (DANA_MODE / LLM_PROVIDER from env)
#   npm run demo:web        the web on :3000, http mode, demo build (VITE_DEMO=1)
#   npm run demo:electron   the built app in Electron over app://fabric, http mode, demo build
#   npm run demo:offline    the built app in Electron, mock mode (no server, no network): the L0 fallback
#
# One run at a time: the Spark lane takes 8 requests and one research run holds 4. Reset between
# rehearsals so an abandoned run can't keep the lane busy.
set -euo pipefail
cd "$(dirname "$0")/.."
NEON_PROJECT=solitary-meadow-39146227
BRANCH="${DEMO_BRANCH:-demo}"

# Stops whatever fabric process listens on a port (its whole process group). Port-based on purpose:
# pkill -f would match this shell too.
stop_port() {
  local port=$1 pid
  pid=$(ss -ltnp 2>/dev/null | grep ":$port\b" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
  [ -z "$pid" ] && return 0
  if ps -o args= -p "$pid" | grep -q fabric; then
    kill -TERM -"$(ps -o pgid= -p "$pid" | tr -d ' ')" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    echo "stopped the process on :$port"
  else
    echo "something else is on :$port; leaving it alone" >&2
  fi
}

demo_url() { neon connection-string --project-id "$NEON_PROJECT" --branch "$BRANCH" --pooled | tail -1; }

case "${1:-}" in
  reset)
    stop_port 8787
    npm run seed -- --profile demo --branch "$BRANCH"
    echo "demo branch reset. Next: npm run demo:server, then npm run demo:electron (or demo:web)."
    ;;
  server)
    stop_port 8787
    DATABASE_URL="$(demo_url)" NEON_BRANCH="$BRANCH" exec npm run start -w @fabric/server
    ;;
  web)
    VITE_API_MODE=http VITE_DEMO=1 exec npm run dev -w web
    ;;
  electron)
    VITE_API_MODE=http VITE_DEMO=1 exec npm run electron:start -w web
    ;;
  offline)
    VITE_API_MODE=mock VITE_DEMO=1 exec npm run electron:start -w web
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
