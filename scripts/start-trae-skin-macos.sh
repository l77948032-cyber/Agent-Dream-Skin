#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

PORT="$DEFAULT_PORT"
PORT_EXPLICIT="false"
THEME_ID=""
LAST_THEME_PATH="$STATE_ROOT/last-theme"

is_public_theme_id() {
  case "$1" in
    neon-portal|ember-glass|paper-aurora|sunlit-spark|violet-rift) return 0 ;;
    *) return 1 ;;
  esac
}

read_last_theme() {
  local saved_theme=""
  [ -f "$LAST_THEME_PATH" ] || return 0
  IFS= read -r saved_theme < "$LAST_THEME_PATH" || true
  is_public_theme_id "$saved_theme" || return 0
  [ -f "$THEMES_ROOT/$saved_theme/theme.json" ] || return 0
  printf '%s' "$saved_theme"
}

write_last_theme() {
  local theme_id="$1"
  local temporary="$LAST_THEME_PATH.$$"
  is_public_theme_id "$theme_id" || return 0
  if ! (umask 077; printf '%s\n' "$theme_id" > "$temporary"); then
    /bin/rm -f "$temporary"
    return 1
  fi
  if ! /bin/mv -f "$temporary" "$LAST_THEME_PATH"; then
    /bin/rm -f "$temporary"
    return 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; PORT_EXPLICIT="true"; shift 2 ;;
    --theme) THEME_ID="${2:-}"; shift 2 ;;
    *) fail "Unknown start argument: $1" ;;
  esac
done

case "$PORT" in ''|*[!0-9]*) fail "Invalid port: $PORT" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "Port must be between 1024 and 65535."

discover_trae_app
require_trae_runtime
ensure_state_root
acquire_operation_lock
trap release_operation_lock EXIT

if [ -f "$STATE_PATH" ]; then
  if [ "$PORT_EXPLICIT" = "false" ]; then
    saved_port="$(state_field port 2>/dev/null || true)"
    [ -z "$saved_port" ] || PORT="$saved_port"
  fi
  if [ -z "$THEME_ID" ]; then
    THEME_ID="$(state_field themeId 2>/dev/null || true)"
  fi
fi
if [ -z "$THEME_ID" ]; then
  THEME_ID="$(read_last_theme 2>/dev/null || true)"
fi
case "$PORT" in ''|*[!0-9]*) fail "Invalid saved port: $PORT" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "Saved port must be between 1024 and 65535."
[ -n "$THEME_ID" ] || THEME_ID="$DEFAULT_THEME_ID"
resolve_theme_dir "$THEME_ID"

TRAE_WAS_RUNNING="false"
trae_is_running && TRAE_WAS_RUNNING="true"
SESSION_OWNED="false"
STARTED_CDP_HERE="false"
SESSION_TRAE_PID=""
SESSION_TRAE_STARTED_AT=""
LAUNCHED_TRAE_PID=""
START_TRANSACTION_ACTIVE="false"

capture_launched_trae_identity() {
  local timeout_seconds="${1:-15}"
  local deadline=$((SECONDS + timeout_seconds))
  local started_at=""
  case "$LAUNCHED_TRAE_PID" in ''|0|*[!0-9]*) return 1 ;; esac
  while [ "$SECONDS" -lt "$deadline" ]; do
    /bin/kill -0 "$LAUNCHED_TRAE_PID" 2>/dev/null || return 1
    if pid_is_trae_main "$LAUNCHED_TRAE_PID"; then
      started_at="$(process_started_at "$LAUNCHED_TRAE_PID")"
      if [ -n "$started_at" ]; then
        SESSION_TRAE_PID="$LAUNCHED_TRAE_PID"
        SESSION_TRAE_STARTED_AT="$started_at"
        return 0
      fi
    fi
    /bin/sleep 0.1
  done
  return 1
}

recover_launched_trae_identity() {
  if [ -z "$LAUNCHED_TRAE_PID" ] && trae_launch_agent_is_owned; then
    LAUNCHED_TRAE_PID="$(trae_launch_agent_pid)"
  fi
  if [ -z "$SESSION_TRAE_PID" ] && [ -n "$LAUNCHED_TRAE_PID" ] && \
    pid_is_trae_main "$LAUNCHED_TRAE_PID"; then
    local started_at=""
    started_at="$(process_started_at "$LAUNCHED_TRAE_PID")"
    if [ -n "$started_at" ]; then
      SESSION_TRAE_PID="$LAUNCHED_TRAE_PID"
      SESSION_TRAE_STARTED_AT="$started_at"
      return 0
    fi
  fi
  return 1
}

session_identity_matches_port() {
  local listener_main_pid=""
  listener_main_pid="$(trae_main_pid_for_listener "$PORT")" || return 1
  [ "$listener_main_pid" = "$SESSION_TRAE_PID" ] && \
    process_identity_matches "$SESSION_TRAE_PID" "$SESSION_TRAE_STARTED_AT"
}

rollback_start_session() {
  stop_recorded_injector || true
  if [ "$STARTED_CDP_HERE" = "true" ] && [ -z "$SESSION_TRAE_PID" ]; then
    recover_launched_trae_identity || true
  fi
  if [ "$SESSION_OWNED" = "true" ] && [ -n "${BROWSER_ID:-}" ] && \
    verified_cdp_endpoint "$PORT" && session_identity_matches_port; then
    run_node "$INJECTOR" --remove --port "$PORT" --browser-id "$BROWSER_ID" \
      --theme-dir "$THEME_DIR" --timeout-ms 5000 >/dev/null 2>&1 || true
  fi
  if [ "$SESSION_OWNED" = "true" ] && [ -n "$SESSION_TRAE_PID" ] && \
    [ -n "$SESSION_TRAE_STARTED_AT" ]; then
    if trae_launch_agent_is_owned; then
      stop_owned_trae_launch_agent >/dev/null 2>&1 || \
        stop_recorded_trae_process "$SESSION_TRAE_PID" "$SESSION_TRAE_STARTED_AT" \
          >/dev/null 2>&1 || true
    else
      stop_recorded_trae_process "$SESSION_TRAE_PID" "$SESSION_TRAE_STARTED_AT" \
        >/dev/null 2>&1 || true
    fi
  elif [ "$STARTED_CDP_HERE" = "true" ]; then
    stop_owned_trae_launch_agent >/dev/null 2>&1 || true
  fi
  if [ "$TRAE_WAS_RUNNING" = "true" ] && ! trae_is_running; then
    launch_trae_normally >/dev/null 2>&1 || true
  fi
  port_is_available "$PORT" && /bin/rm -f "$STATE_PATH"
}

cleanup_start_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$START_TRANSACTION_ACTIVE" = "true" ]; then
    rollback_start_session
  fi
  release_operation_lock
  exit "$status"
}

trap cleanup_start_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

DEBUG_READY="false"
if verified_cdp_endpoint "$PORT"; then
  LIVE_BROWSER_ID="$(cdp_browser_id "$PORT" 2>/dev/null || true)"
  SAVED_OWNS_SESSION="$(state_field ownsSession 2>/dev/null || true)"
  SAVED_BROWSER_ID="$(state_field browserId 2>/dev/null || true)"
  SAVED_TRAE_PID="$(state_field traePid 2>/dev/null || true)"
  SAVED_TRAE_STARTED_AT="$(state_field traeStartedAt 2>/dev/null || true)"
  LIVE_TRAE_PID="$(trae_main_pid_for_listener "$PORT" 2>/dev/null || true)"
  if [ -f "$STATE_PATH" ] && [ "$SAVED_OWNS_SESSION" = "true" ] && \
    [ -n "$LIVE_BROWSER_ID" ] && [ "$SAVED_BROWSER_ID" = "$LIVE_BROWSER_ID" ] && \
    [ "$SAVED_TRAE_PID" = "$LIVE_TRAE_PID" ] && \
    process_identity_matches "$SAVED_TRAE_PID" "$SAVED_TRAE_STARTED_AT"; then
    DEBUG_READY="true"
    SESSION_OWNED="true"
    BROWSER_ID="$LIVE_BROWSER_ID"
    SESSION_TRAE_PID="$SAVED_TRAE_PID"
    SESSION_TRAE_STARTED_AT="$SAVED_TRAE_STARTED_AT"
  else
    fail "Port $PORT is an existing Trae CDP session not owned by Trae Dream Skin; close that debug session or choose another port."
  fi
fi

if trae_is_running && [ "$DEBUG_READY" = "false" ]; then
  START_TRANSACTION_ACTIVE="true"
  printf 'Restarting Trae once to enable the local skin session...\n' >&2
  stop_trae true
fi

if [ "$DEBUG_READY" = "false" ]; then
  if ! PORT="$(select_available_port "$PORT")"; then
    trae_is_running || launch_trae_normally >/dev/null 2>&1 || true
    fail "No free loopback port was found."
  fi
  [ -z "$(trae_main_pids)" ] \
    || fail "Trae did not fully stop before the owned skin session could be launched."
  START_TRANSACTION_ACTIVE="true"
  SESSION_OWNED="true"
  STARTED_CDP_HERE="true"
  printf 'Launching Trae with loopback CDP on port %s...\n' "$PORT" >&2
  launch_trae_with_cdp "$PORT" \
    || fail "Trae could not be launched with a loopback CDP endpoint."
  if ! capture_launched_trae_identity 15; then
    fail "The launched Trae process identity could not be recorded."
  fi
  if ! wait_for_cdp "$PORT"; then
    fail "Trae did not expose a verified CDP endpoint. See $APP_ERROR_LOG"
  fi
  session_identity_matches_port \
    || fail "The CDP listener does not belong to the Trae process launched by this skin session."
fi

BROWSER_ID="${BROWSER_ID:-$(cdp_browser_id "$PORT" 2>/dev/null || true)}"
[ -n "$BROWSER_ID" ] || {
  fail "Trae's CDP browser identity could not be validated."
}

START_TRANSACTION_ACTIVE="true"
if ! stop_recorded_injector; then
  fail "The previous injector could not be stopped safely."
fi

if ! INJECTOR_PID="$(launch_injector_daemon "$PORT" "$BROWSER_ID")"; then
  fail "The persistent injector could not be started."
fi
INJECTOR_STARTED_AT="$(process_started_at "$INJECTOR_PID")"
[ -n "$INJECTOR_STARTED_AT" ] || {
  fail "Could not record the injector process start time."
}

if ! run_node "$INJECTOR" --once --port "$PORT" --browser-id "$BROWSER_ID" \
  --theme-dir "$THEME_DIR" --timeout-ms 20000 >/dev/null; then
  fail "The initial theme injection failed."
fi

VERIFY_PATH="$STATE_ROOT/last-verify.json"
if ! run_node "$INJECTOR" --verify --port "$PORT" --browser-id "$BROWSER_ID" \
  --theme-dir "$THEME_DIR" --timeout-ms 20000 >"$VERIFY_PATH"; then
  fail "Skin verification failed. See $VERIFY_PATH and $INJECTOR_ERROR_LOG"
fi

if ! process_identity_matches "$SESSION_TRAE_PID" "$SESSION_TRAE_STARTED_AT"; then
  fail "The active Trae process identity changed before state could be written."
fi
session_identity_matches_port \
  || fail "The active CDP listener changed before state could be written."
if ! write_state "$PORT" "$INJECTOR_PID" "$INJECTOR_STARTED_AT" \
  "$SESSION_TRAE_PID" "$SESSION_TRAE_STARTED_AT" "$BROWSER_ID" \
  "$SESSION_OWNED" "$STARTED_CDP_HERE"; then
  fail "The active skin state could not be written."
fi

START_TRANSACTION_ACTIVE="false"
if ! write_last_theme "$THEME_ID"; then
  printf 'Trae Dream Skin: warning: the last selected theme could not be saved.\n' >&2
fi
printf 'Trae Dream Skin %s is active: theme=%s port=%s\n' "$SKIN_VERSION" "$THEME_ID" "$PORT"
