#!/usr/bin/env bash
# Starts the DeepRead API and Vite from this worktree against a fresh temp data dir, on non-default ports,
# with OCR unavailable (no Homebrew on PATH), like production. Never touches ./data, .env storage or R2.
#   bash e2e/perf/start-local.sh            -> prints data dir, ports, PIDs, log files; servers keep running
#   kill $(cat "$DEEPREAD_DATA_DIR/pids")   -> stops them
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
test -x "$NODE_BIN" || { echo "node not found; set NODE_BIN" >&2; exit 1; }
T=$(mktemp -d)
export DEEPREAD_DATA_DIR="${T:?}" DEEPREAD_STORAGE=local
unset DEEPREAD_REMOTE_KEY ADMIN_PASSKEY ADMIN_NAME DEEPREAD_PUBLIC_URL DEEPREAD_ENCRYPTION_KEY DEEPREAD_STORAGE_LIMIT
test -n "$DEEPREAD_DATA_DIR" && test "$DEEPREAD_DATA_DIR" != "$PWD/data" && test -d "$DEEPREAD_DATA_DIR" || { echo "refusing to start: unsafe data dir" >&2; exit 1; }
export DEEPREAD_API_PORT="${DEEPREAD_API_PORT:-18787}"
WEB_PORT="${WEB_PORT:-15173}"
# OCR off like production: PATH without Homebrew, node reachable by absolute path.
export PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
API_LOG="$DEEPREAD_DATA_DIR/api.log"
WEB_LOG="$DEEPREAD_DATA_DIR/web.log"
"$NODE_BIN" server/index.ts > "$API_LOG" 2>&1 &
API_PID=$!
"$NODE_BIN" node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$WEB_PORT" --strictPort > "$WEB_LOG" 2>&1 &
WEB_PID=$!
echo "$API_PID $WEB_PID" > "$DEEPREAD_DATA_DIR/pids"
wait_for() {
  local url=$1 pid=$2 label=$3 deadline=$((SECONDS + 60))
  until curl -fsS -o /dev/null "$url"; do
    kill -0 "$pid" 2>/dev/null || { echo "$label exited; see its log" >&2; exit 1; }
    test "$SECONDS" -lt "$deadline" || { echo "$label did not answer at $url within 60s" >&2; exit 1; }
    sleep 0.5
  done
}
wait_for "http://127.0.0.1:$DEEPREAD_API_PORT/api/session" "$API_PID" API
wait_for "http://127.0.0.1:$WEB_PORT/" "$WEB_PID" Vite
echo "data_dir: $DEEPREAD_DATA_DIR"
echo "api: http://127.0.0.1:$DEEPREAD_API_PORT (pid $API_PID, log $API_LOG)"
echo "web: http://127.0.0.1:$WEB_PORT (pid $WEB_PID, log $WEB_LOG)"
echo "stop: kill $API_PID $WEB_PID"
