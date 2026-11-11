#!/usr/bin/env bash
#
# Stop the in-WSL workbuddy-gateway instance for one port.
#
#   bash wsl/stop-gateway.sh              # stops the instance on 8790
#   bash wsl/stop-gateway.sh --port 8792  # stops the instance on 8792
#   bash wsl/stop-gateway.sh --all        # stops every in-WSL instance
#
# Scoped by port on purpose. An earlier version matched every `gateway.js`, which
# meant stopping a test instance also killed the one serving VS Code. Ports are
# the thing that actually distinguishes the instances.
#
# Processes are found by command line rather than by the pid file: the file
# records one process, but more than one can be running (started by hand, or left
# over after the file was overwritten), and a crashed process leaves the file
# behind so its pid may now belong to something else.
#
set -uo pipefail

STATE_DIR="${HOME}/.workbuddy-gateway-wsl"
PID_FILE="${STATE_DIR}/gateway.pid"

PORT="${WORKBUDDY_WSL_PORT:-8790}"
MODE="port"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --all) MODE="all"; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf '[workbuddy-wsl] unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

say() { printf '[workbuddy-wsl] %s\n' "$*"; }

# Match the gateway for a specific port. The trailing guard stops `--port 879`
# from also matching `--port 8791`.
find_for_port() {
  pgrep -f "gateway\.js.*--port ${1}([^0-9]|\$)" 2>/dev/null || true
}
find_all() {
  pgrep -f 'gateway\.js' 2>/dev/null || true
}

if [ "$MODE" = "all" ]; then
  TARGETS="$(find_all)"
  LABEL="every in-WSL instance"
else
  TARGETS="$(find_for_port "$PORT")"
  LABEL="port ${PORT}"
fi

if [ -z "${TARGETS:-}" ]; then
  say "no gateway process for ${LABEL}"
  # The pid file belongs to whichever port this script was pointed at; clear it
  # only when nothing at all is running, so a live instance on another port keeps
  # its record.
  if [ "$MODE" = "all" ] || [ -z "$(find_all)" ]; then
    [ -f "$PID_FILE" ] && rm -f "$PID_FILE" && say "removed stale pid file"
  fi
else
  COUNT="$(printf '%s\n' "$TARGETS" | wc -l | tr -d ' ')"
  [ "$COUNT" -gt 1 ] && say "${COUNT} processes matched ${LABEL}"

  for pid in $TARGETS; do
    CMD="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | cut -c1-110)"
    say "stopping pid ${pid}: ${CMD:-<details unavailable>}"
    kill "$pid" 2>/dev/null || true
  done

  for _ in $(seq 1 20); do
    if [ "$MODE" = "all" ]; then
      [ -z "$(find_all)" ] && break
    else
      [ -z "$(find_for_port "$PORT")" ] && break
    fi
    sleep 0.5
  done

  if [ "$MODE" = "all" ]; then REMAIN="$(find_all)"; else REMAIN="$(find_for_port "$PORT")"; fi
  if [ -n "${REMAIN:-}" ]; then
    for pid in $REMAIN; do
      say "pid ${pid} ignored SIGTERM, sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
  fi

  if [ "$MODE" = "all" ]; then REMAIN="$(find_all)"; else REMAIN="$(find_for_port "$PORT")"; fi
  if [ -z "${REMAIN:-}" ]; then
    if [ "$MODE" = "all" ] || [ -z "$(find_all)" ]; then rm -f "$PID_FILE"; fi
    say "stopped"
  else
    say "WARNING: still running after SIGKILL:"
    for pid in $REMAIN; do
      tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | sed 's/^/  /'
      echo ""
    done
  fi
fi

# Report the port separately: "process gone" and "port free" are different facts,
# and a child holding the socket would otherwise go unnoticed.
if [ "$MODE" != "all" ]; then
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
      say "WARNING: port ${PORT} is still listening"
      ss -ltnp 2>/dev/null | grep ":${PORT}\b" | sed 's/^/  /'
    else
      say "port ${PORT} is free"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      say "WARNING: port ${PORT} is still listening"
    else
      say "port ${PORT} is free"
    fi
  fi
fi

# Mention survivors on other ports: they are easy to forget, and they share the
# same auth file.
LEFT="$(find_all)"
if [ -n "${LEFT:-}" ]; then
  say "other gateways still running:"
  pgrep -af 'gateway\.js' | sed 's/^/  /'
fi
