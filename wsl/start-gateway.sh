#!/usr/bin/env bash
#
# Start a workbuddy-gateway instance INSIDE WSL.
#
# Why this exists
# ---------------
# WSL in NAT mode has its own 127.0.0.1, and the Windows-side gateway binds to
# Windows loopback only, so WSL cannot reach it. The two usual fixes are
# unavailable here:
#   - mirrored networking (networkingMode=mirrored) needs Windows 11 22H2+
#   - netsh portproxy needs administrator rights
#
# Instead this runs a second gateway instance inside WSL that reads the Windows
# login state through /mnt/c. The Windows gateway keeps its 127.0.0.1 binding and
# is never touched; VS Code in WSL connects to this instance on 127.0.0.1:8791.
#
# Usage:
#   bash wsl/start-gateway.sh              # start (detached)
#   WORKBUDDY_WSL_PORT=9000 bash wsl/start-gateway.sh
#
set -uo pipefail

PORT="${WORKBUDDY_WSL_PORT:-8791}"
API_KEY="${WORKBUDDY_GATEWAY_API_KEY:-workbuddy-local}"
STATE_DIR="${HOME}/.workbuddy-gateway-wsl"
PID_FILE="${STATE_DIR}/gateway.pid"
LOG_FILE="${STATE_DIR}/gateway.log"
OUT_FILE="${STATE_DIR}/gateway.out.log"

say() { printf '[workbuddy-wsl] %s\n' "$*"; }
die() { printf '[workbuddy-wsl] %s\n' "$*" >&2; exit 1; }

# --- already running? -------------------------------------------------------
# Scoped to THIS port, by process rather than by the pid file.
#
# Matching every `gateway.js` would be wrong: an instance on another port is a
# different service (the 8792 used during testing, say), and refusing to start
# because of it makes the port argument useless. The pid file is also not
# evidence — a crashed process leaves it behind, and a recycled pid would then
# point at an unrelated program.
PORT_PIDS="$(pgrep -f "gateway\.js.*--port ${PORT}([^0-9]|\$)" 2>/dev/null || true)"
if [ -n "${PORT_PIDS:-}" ]; then
  COUNT="$(printf '%s\n' "$PORT_PIDS" | wc -l | tr -d ' ')"
  if [ "$COUNT" -gt 1 ]; then
    say "WARNING: ${COUNT} gateway processes are claiming port ${PORT}:"
    for pid in $PORT_PIDS; do
      tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | sed 's/^/  /'
      echo ""
    done
    say "stop them first: bash wsl/stop-gateway.sh --port ${PORT}"
    exit 1
  fi
  CODE="$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo '000')"
  if [ "$CODE" = "200" ]; then
    say "already running (pid ${PORT_PIDS}) on port ${PORT}, healthy"
    exit 0
  fi
  # Process alive but not answering: wedged, or still starting up.
  say "a gateway process (pid ${PORT_PIDS}) is using port ${PORT} but /health answers ${CODE}"
  say "stop it first: bash wsl/stop-gateway.sh --port ${PORT}"
  exit 1
fi

# Instances on other ports are fine, but say so: they are easy to forget and they
# all share one auth file.
OTHERS="$(pgrep -f 'gateway\.js' 2>/dev/null || true)"
if [ -n "${OTHERS:-}" ]; then
  say "note: another gateway is already running on a different port:"
  pgrep -af 'gateway\.js' | sed 's/^/  /'
fi
rm -f "$PID_FILE"

# --- locate node ------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found in WSL. Install it with: sudo apt install nodejs"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required, found $(node --version)"

# --- locate gateway.js ------------------------------------------------------
GW=""
for cand in \
  "${WORKBUDDY_GATEWAY_JS:-}" \
  "/mnt/d/Project/WorkBuddyToDeepSeekHarness/gateway.js" \
  "${HOME}/workbuddy-gateway/gateway.js" \
  "${HOME}/WorkBuddyToDeepSeekHarness/gateway.js"
do
  [ -n "$cand" ] && [ -f "$cand" ] && GW="$cand" && break
done
[ -n "$GW" ] || die "gateway.js not found. Set WORKBUDDY_GATEWAY_JS=/path/to/gateway.js"
say "gateway : $GW"

# --- locate the Windows login state ----------------------------------------
# The desktop client stores its session under the Windows user's AppData.
WIN_AUTH=""
if [ -n "${WORKBUDDY_AUTH_FILE:-}" ] && [ -r "${WORKBUDDY_AUTH_FILE}" ]; then
  WIN_AUTH="${WORKBUDDY_AUTH_FILE}"
else
  for dir in /mnt/c/Users/*/AppData/Local/CodeBuddyExtension/Data/Public/auth; do
    case "$dir" in
      */Users/Public/*|*/Users/Default/*|*/Users/Default\ User/*|*/Users/All\ Users/*) continue ;;
    esac
    if [ -d "$dir" ]; then
      # Prefer the live session file `workbuddy-desktop.info` (no timestamp
      # suffix) — that is the one the desktop client keeps writing. Only fall
      # back to timestamped snapshots when the live file is absent. The old
      # naive glob `workbuddy*.info` sorted the timestamped snapshots ahead of
      # the live file, so WSL could pick a stale session from a different
      # account and every request was rejected with 11140 "request illegal".
      if [ -r "$dir/workbuddy-desktop.info" ]; then
        WIN_AUTH="$dir/workbuddy-desktop.info"
      else
        # Newest .info by mtime (most recently refreshed session).
        WIN_AUTH="$(ls -1t "$dir"/*.info 2>/dev/null | head -n 1)"
      fi
    fi
    [ -n "$WIN_AUTH" ] && break
  done
fi
[ -n "$WIN_AUTH" ] || die "no Windows login state found. Sign in with the WorkBuddy desktop client, or set WORKBUDDY_AUTH_FILE"
say "auth file: $WIN_AUTH"

# --- can we reach the upstream at all? -------------------------------------
UPSTREAM_HTTP="$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://copilot.tencent.com/ 2>/dev/null || echo 000)"
if [ "$UPSTREAM_HTTP" = "000" ]; then
  say "warning: cannot reach copilot.tencent.com from WSL (curl exit non-zero)."
  say "         if the gateway starts but every request fails, this is why."
fi

# --- start ------------------------------------------------------------------
mkdir -p "$STATE_DIR"
say "starting on 127.0.0.1:${PORT} ..."

# Detach properly. `nohup ... &` alone is not enough when this script is invoked
# through `wsl.exe -e bash -lc`: the process stays in the caller's session and is
# reaped when that session ends. setsid() starts it in a new session so it is
# reparented to init and survives.
if command -v setsid >/dev/null 2>&1; then
  setsid node "$GW" \
    --host 127.0.0.1 \
    --port "$PORT" \
    --api-key "$API_KEY" \
    --auth-file "$WIN_AUTH" \
    --log "$LOG_FILE" \
    --debug \
    >>"$OUT_FILE" 2>&1 < /dev/null &
else
  nohup node "$GW" \
    --host 127.0.0.1 \
    --port "$PORT" \
    --api-key "$API_KEY" \
    --auth-file "$WIN_AUTH" \
    --log "$LOG_FILE" \
    --debug \
    >>"$OUT_FILE" 2>&1 < /dev/null &
fi

GW_PID=$!
disown "$GW_PID" 2>/dev/null || true
echo "$GW_PID" > "$PID_FILE"
say "pid $GW_PID"

# --- wait for health --------------------------------------------------------
for i in $(seq 1 15); do
  sleep 1
  CODE="$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo 000)"
  if [ "$CODE" = "200" ]; then
    MODELS="$(curl -s -m 5 -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${PORT}/v1/models" \
      | grep -o '"id"' | wc -l | tr -d ' ')"
    say "ready — ${MODELS} models"
    say "set workbuddyAgent.gatewayUrl to http://127.0.0.1:${PORT}  (the extension probes it automatically)"
    exit 0
  fi
done

say "health check did not pass within 15s. Last log lines:"
tail -n 15 "$OUT_FILE" 2>/dev/null || true
die "start failed"
