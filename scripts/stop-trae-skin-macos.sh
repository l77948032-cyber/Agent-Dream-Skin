#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

RELAUNCH="true"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-relaunch) RELAUNCH="false"; shift ;;
    *) fail "Unknown stop argument: $1" ;;
  esac
done

discover_trae_app
require_trae_runtime
ensure_state_root
acquire_operation_lock
trap release_operation_lock EXIT

stop_launchd_owned_session() {
  local remove_state="$1"
  local app_pid=""
  local app_port=""
  local was_running="false"
  local saved_port=""
  local saved_theme=""
  local saved_browser_id=""
  local theme_dir=""

  app_pid="$(trae_launch_agent_pid)"
  app_port="$(trae_launch_agent_port)"
  if [ -n "$app_pid" ] && pid_is_trae_main "$app_pid"; then
    was_running="true"
  fi

  if launch_agent_is_owned; then
    stop_owned_launch_agent \
      || fail "The owned skin watcher could not be stopped; state was preserved."
  fi

  if [ "$remove_state" = "true" ]; then
    saved_port="$(state_field port 2>/dev/null || true)"
    saved_theme="$(state_field themeId 2>/dev/null || true)"
    saved_browser_id="$(state_field browserId 2>/dev/null || true)"
    case "$saved_theme" in
      ''|*[!A-Za-z0-9_-]*) saved_theme="" ;;
    esac
    theme_dir="$THEMES_ROOT/$saved_theme"
    if [ -n "$saved_port" ] && [ "$saved_port" = "$app_port" ] && \
      [ -n "$saved_browser_id" ] && [ -f "$theme_dir/theme.json" ] && \
      verified_cdp_endpoint "$app_port" && \
      [ "$(trae_main_pid_for_listener "$app_port" 2>/dev/null || true)" = "$app_pid" ] && \
      [ "$(cdp_browser_id "$app_port" 2>/dev/null || true)" = "$saved_browser_id" ]; then
      if ! run_node "$INJECTOR" --remove --port "$app_port" \
        --theme-dir "$theme_dir" --browser-id "$saved_browser_id" \
        --timeout-ms 10000 >/dev/null; then
        printf 'Trae Dream Skin: warning: live DOM cleanup failed; closing the owned Trae job will still remove the skin.\n' >&2
      fi
    else
      printf 'Trae Dream Skin: warning: state or theme assets could not be used for live DOM cleanup; the owned Trae job will still be closed.\n' >&2
    fi
  fi

  stop_owned_trae_launch_agent \
    || fail "The owned Trae launch job could not be stopped; state was preserved."
  if [ -n "$app_port" ]; then
    case "$app_port" in
      *[!0-9]*)
        printf 'Trae Dream Skin: warning: the owned job port could not be parsed; process and job shutdown were still verified.\n' >&2
        ;;
      *)
        if [ "$app_port" -ge 1024 ] && [ "$app_port" -le 65535 ]; then
          wait_for_port_available "$app_port" 6 \
            || fail "The owned Trae debugging port is still listening; state was preserved."
        else
          printf 'Trae Dream Skin: warning: the owned job port was outside the allowed range; process and job shutdown were still verified.\n' >&2
        fi
        ;;
    esac
  fi
  launch_agent_is_owned \
    && fail "The owned skin watcher is still loaded; state was preserved."
  trae_launch_agent_is_owned \
    && fail "The owned Trae launch job is still loaded; state was preserved."

  if [ "$remove_state" = "true" ]; then
    /bin/rm -f "$STATE_PATH"
  fi
  if [ "$RELAUNCH" = "true" ] && [ "$was_running" = "true" ]; then
    launch_trae_normally
  fi
  clear_app_launch_logs
}

if [ ! -f "$STATE_PATH" ]; then
  if trae_launch_agent_is_owned; then
    stop_launchd_owned_session false
  else
    if launch_agent_is_owned; then
      stop_owned_launch_agent \
        || fail "The owned skin watcher could not be stopped."
    fi
    launch_agent_is_owned && fail "The owned skin watcher is still loaded."
    clear_app_launch_logs
  fi
  printf 'Trae Dream Skin is already off; no recorded skin session was found.\n'
  exit 0
fi

if trae_launch_agent_is_owned; then
  stop_launchd_owned_session true
  printf 'Trae Dream Skin is fully off; injected UI and the CDP session were removed.\n'
  exit 0
fi

PORT="$DEFAULT_PORT"
THEME_ID="$DEFAULT_THEME_ID"
BROWSER_ID=""
saved_port="$(state_field port 2>/dev/null || true)"
saved_theme="$(state_field themeId 2>/dev/null || true)"
BROWSER_ID="$(state_field browserId 2>/dev/null || true)"
TRAE_PID="$(state_field traePid 2>/dev/null || true)"
TRAE_STARTED_AT="$(state_field traeStartedAt 2>/dev/null || true)"
OWNS_SESSION="$(state_field ownsSession 2>/dev/null || true)"
[ -z "$saved_port" ] || PORT="$saved_port"
[ -z "$saved_theme" ] || THEME_ID="$saved_theme"
case "$PORT" in ''|*[!0-9]*) fail "The recorded skin port is invalid; state was preserved." ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] \
  || fail "The recorded skin port is outside the allowed range; state was preserved."
case "$BROWSER_ID" in ''|*[!A-Za-z0-9._-]*) fail "The recorded browser identity is invalid; state was preserved." ;; esac
[ "$OWNS_SESSION" = "true" ] || fail "The state does not identify an owned skin session; state was preserved."
case "$TRAE_PID" in ''|0|*[!0-9]*) fail "The recorded Trae PID is invalid; state was preserved." ;; esac
[ -n "$TRAE_STARTED_AT" ] || fail "The recorded Trae process start time is missing; state was preserved."
THEME_DIR="$THEMES_ROOT/$THEME_ID"
THEME_AVAILABLE="false"
[ -f "$THEME_DIR/theme.json" ] && THEME_AVAILABLE="true"

if ! stop_recorded_injector; then
  printf 'Trae Dream Skin: warning: the watcher did not stop cleanly; shutdown will continue.\n' >&2
fi

ENDPOINT_MATCH="false"
RECORDED_TRAE_ALIVE="false"
process_identity_matches "$TRAE_PID" "$TRAE_STARTED_AT" && RECORDED_TRAE_ALIVE="true"

if ! port_is_available "$PORT"; then
  if ! verified_cdp_endpoint "$PORT"; then
    [ "$RECORDED_TRAE_ALIVE" = "true" ] \
      || fail "The recorded port is occupied by an unverified process; state was preserved."
    printf 'Trae Dream Skin: warning: CDP did not answer verification; closing only the recorded Trae process.\n' >&2
  else
    ENDPOINT_MATCH="true"
  fi
fi

if [ "$ENDPOINT_MATCH" = "true" ]; then
  CURRENT_BROWSER_ID="$(cdp_browser_id "$PORT" 2>/dev/null || true)"
  if [ "$CURRENT_BROWSER_ID" != "$BROWSER_ID" ]; then
    fail "The live CDP browser does not match the recorded skin session; state was preserved."
  fi
  [ "$RECORDED_TRAE_ALIVE" = "true" ] \
    || fail "The live CDP browser is no longer owned by the recorded Trae process; state was preserved."
  LISTENER_TRAE_PID="$(trae_main_pid_for_listener "$PORT" 2>/dev/null || true)"
  [ "$LISTENER_TRAE_PID" = "$TRAE_PID" ] \
    || fail "The live CDP listener is not owned by the recorded Trae process; state was preserved."
  if [ "$THEME_AVAILABLE" = "true" ]; then
    REMOVE_ARGS=("$INJECTOR" --remove --port "$PORT" --theme-dir "$THEME_DIR" --timeout-ms 10000)
    REMOVE_ARGS+=(--browser-id "$BROWSER_ID")
    if ! run_node "${REMOVE_ARGS[@]}" >/dev/null; then
      printf 'Trae Dream Skin: warning: live DOM cleanup failed; closing the recorded Trae process will still remove the skin.\n' >&2
    fi
  else
    printf 'Trae Dream Skin: warning: the recorded theme assets are missing; closing the recorded Trae process will still remove the skin.\n' >&2
  fi
fi

WAS_RUNNING="false"
if [ "$RECORDED_TRAE_ALIVE" = "true" ]; then
  WAS_RUNNING="true"
  if trae_launch_agent_is_owned; then
    APP_AGENT_PID="$(trae_launch_agent_pid)"
    [ -z "$APP_AGENT_PID" ] || [ "$APP_AGENT_PID" = "$TRAE_PID" ] \
      || fail "The owned Trae launch job PID does not match state; state was preserved."
    stop_owned_trae_launch_agent \
      || fail "The owned Trae launch job could not be stopped; state was preserved."
  else
    stop_recorded_trae_process "$TRAE_PID" "$TRAE_STARTED_AT" \
      || fail "The recorded Trae skin process could not be stopped; state was preserved."
  fi
fi

wait_for_port_available "$PORT" 6 \
  || fail "The recorded debugging port is still listening; state was preserved."
if launch_agent_is_owned && ! stop_owned_launch_agent; then
  fail "The skin watcher is still loaded; state was preserved."
fi
if trae_launch_agent_is_owned && ! stop_owned_trae_launch_agent; then
  fail "The owned Trae launch job is still loaded; state was preserved."
fi

/bin/rm -f "$STATE_PATH"

if [ "$RELAUNCH" = "true" ] && [ "$WAS_RUNNING" = "true" ]; then
  launch_trae_normally
fi

clear_app_launch_logs

printf 'Trae Dream Skin is fully off; injected UI and the CDP session were removed.\n'
