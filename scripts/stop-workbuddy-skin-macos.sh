#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-workbuddy-macos.sh"

RELAUNCH="true"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-relaunch) RELAUNCH="false"; shift ;;
    *) fail "Unknown stop argument: $1" ;;
  esac
done

[ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "This launcher requires macOS."
ensure_state_root
acquire_operation_lock
trap release_operation_lock EXIT

STATE_TRUSTWORTHY="false"
HOST_RUNTIME_AVAILABLE="false"
if workbuddy_state_is_trustworthy; then
  STATE_TRUSTWORTHY="true"
  WORKBUDDY_BUNDLE="$(state_field workbuddyBundle)"
  WORKBUDDY_EXE="$(state_field workbuddyExe)"
  WORKBUDDY_VERSION="$(state_field workbuddyVersion 2>/dev/null || true)"
  WORKBUDDY_BUNDLE_ID="$(plist_value "$WORKBUDDY_BUNDLE" CFBundleIdentifier)"
  if [ -x "$WORKBUDDY_EXE" ] && is_supported_bundle_id "$WORKBUDDY_BUNDLE_ID" && \
    [ "$(codesign_team_id "$WORKBUDDY_BUNDLE")" = "$EXPECTED_WORKBUDDY_TEAM_ID" ] && \
    /usr/bin/codesign --verify --deep --strict "$WORKBUDDY_BUNDLE" >/dev/null 2>&1 && \
    [ -f "$WORKBUDDY_SKIN_CSS_PATH" ] && \
    [ -f "$WORKBUDDY_RENDERER_TEMPLATE_PATH" ] && \
    [ -f "$WORKBUDDY_COMPONENT_REGISTRY_PATH" ]; then
    NODE_VERSION="$(run_node --version 2>/dev/null || true)"
    case "$NODE_VERSION" in
      v2[0-9].*|v[3-9][0-9].*) HOST_RUNTIME_AVAILABLE="true" ;;
    esac
  fi
  export WORKBUDDY_BUNDLE WORKBUDDY_EXE WORKBUDDY_VERSION WORKBUDDY_BUNDLE_ID
fi

relaunch_after_cleanup() {
  local was_running="$1"
  [ "$RELAUNCH" = "true" ] && [ "$was_running" = "true" ] || return 0
  if [ "$HOST_RUNTIME_AVAILABLE" = "true" ] && [ -d "$WORKBUDDY_BUNDLE" ]; then
    launch_workbuddy_normally \
      || printf 'WorkBuddy Dream Skin: warning: cleanup succeeded, but WorkBuddy could not be relaunched.\n' >&2
  else
    printf 'WorkBuddy Dream Skin: warning: cleanup succeeded without relaunching an unavailable or untrusted WorkBuddy runtime.\n' >&2
  fi
}

stop_launchd_owned_session() {
  local remove_state="$1"
  local app_pid=""
  local app_port=""
  local was_running="false"
  local saved_port=""
  local saved_theme=""
  local saved_browser_id=""
  local theme_dir=""

  app_pid="$(workbuddy_launch_agent_pid)"
  app_port="$(workbuddy_launch_agent_port)"
  if [ -n "$app_pid" ] && /bin/kill -0 "$app_pid" 2>/dev/null; then
    was_running="true"
  fi

  if launch_agent_path_is_owned; then
    stop_path_owned_launch_agent \
      || fail "The owned skin watcher could not be stopped; state was preserved."
  fi

  if [ "$remove_state" = "true" ] && [ "$HOST_RUNTIME_AVAILABLE" = "true" ]; then
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
      [ "$(workbuddy_main_pid_for_listener "$app_port" 2>/dev/null || true)" = "$app_pid" ] && \
      [ "$(cdp_browser_id "$app_port" 2>/dev/null || true)" = "$saved_browser_id" ]; then
      if ! run_node "$INJECTOR" --remove --port "$app_port" \
        --theme-dir "$theme_dir" --browser-id "$saved_browser_id" \
        --timeout-ms 10000 >/dev/null; then
        printf 'WorkBuddy Dream Skin: warning: live DOM cleanup failed; closing the owned WorkBuddy job will still remove the skin.\n' >&2
      fi
    else
      printf 'WorkBuddy Dream Skin: warning: state or theme assets could not be used for live DOM cleanup; the owned WorkBuddy job will still be closed.\n' >&2
    fi
  fi

  stop_path_owned_workbuddy_launch_agent \
    || fail "The owned WorkBuddy launch job could not be stopped; state was preserved."
  if [ -n "$app_port" ]; then
    case "$app_port" in
      *[!0-9]*)
        printf 'WorkBuddy Dream Skin: warning: the owned job port could not be parsed; process and job shutdown were still verified.\n' >&2
        ;;
      *)
        if [ "$app_port" -ge 1024 ] && [ "$app_port" -le 65535 ]; then
          wait_for_port_available "$app_port" 6 \
            || fail "The owned WorkBuddy debugging port is still listening; state was preserved."
        else
          printf 'WorkBuddy Dream Skin: warning: the owned job port was outside the allowed range; process and job shutdown were still verified.\n' >&2
        fi
        ;;
    esac
  fi
  launch_agent_path_is_owned \
    && fail "The owned skin watcher is still loaded; state was preserved."
  workbuddy_launch_agent_path_is_owned \
    && fail "The owned WorkBuddy launch job is still loaded; state was preserved."
  /bin/rm -f "$LAUNCH_AGENT_PLIST" "$WORKBUDDY_LAUNCH_AGENT_PLIST"

  if [ "$remove_state" = "true" ]; then
    /bin/rm -f "$STATE_PATH"
  fi
  relaunch_after_cleanup "$was_running"
  clear_app_launch_logs
}

if [ ! -f "$STATE_PATH" ]; then
  if workbuddy_launch_agent_path_is_owned; then
    stop_launchd_owned_session false
  else
    if launch_agent_path_is_owned; then
      stop_path_owned_launch_agent \
        || fail "The owned skin watcher could not be stopped."
    fi
    launch_agent_path_is_owned && fail "The owned skin watcher is still loaded."
    clear_app_launch_logs
  fi
  printf 'WorkBuddy Dream Skin is already off; no recorded skin session was found.\n'
  exit 0
fi

if [ "$STATE_TRUSTWORTHY" != "true" ]; then
  if workbuddy_launch_agent_path_is_owned; then
    stop_launchd_owned_session true
  else
    if launch_agent_path_is_owned; then
      stop_path_owned_launch_agent \
        || fail "The owned skin watcher could not be stopped; invalid state was preserved."
    fi
    launch_agent_path_is_owned && fail "The owned skin watcher is still loaded; invalid state was preserved."
    /bin/rm -f "$LAUNCH_AGENT_PLIST" "$WORKBUDDY_LAUNCH_AGENT_PLIST"
    /bin/rm -f "$STATE_PATH"
    clear_app_launch_logs
  fi
  printf 'WorkBuddy Dream Skin recovered an invalid state and removed every confirmed owned session.\n'
  exit 0
fi

if workbuddy_launch_agent_path_is_owned; then
  stop_launchd_owned_session true
  printf 'WorkBuddy Dream Skin is fully off; injected UI and the CDP session were removed.\n'
  exit 0
fi

PORT="$DEFAULT_PORT"
THEME_ID="$DEFAULT_THEME_ID"
BROWSER_ID=""
saved_port="$(state_field port 2>/dev/null || true)"
saved_theme="$(state_field themeId 2>/dev/null || true)"
BROWSER_ID="$(state_field browserId 2>/dev/null || true)"
WORKBUDDY_PID="$(state_field workbuddyPid 2>/dev/null || true)"
WORKBUDDY_STARTED_AT="$(state_field workbuddyStartedAt 2>/dev/null || true)"
OWNS_SESSION="$(state_field ownsSession 2>/dev/null || true)"
[ -z "$saved_port" ] || PORT="$saved_port"
[ -z "$saved_theme" ] || THEME_ID="$saved_theme"
case "$PORT" in ''|*[!0-9]*) fail "The recorded skin port is invalid; state was preserved." ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] \
  || fail "The recorded skin port is outside the allowed range; state was preserved."
case "$BROWSER_ID" in ''|*[!A-Za-z0-9._-]*) fail "The recorded browser identity is invalid; state was preserved." ;; esac
[ "$OWNS_SESSION" = "true" ] || fail "The state does not identify an owned skin session; state was preserved."
case "$WORKBUDDY_PID" in ''|0|*[!0-9]*) fail "The recorded WorkBuddy PID is invalid; state was preserved." ;; esac
[ -n "$WORKBUDDY_STARTED_AT" ] || fail "The recorded WorkBuddy process start time is missing; state was preserved."
THEME_DIR="$THEMES_ROOT/$THEME_ID"
THEME_AVAILABLE="false"
[ -f "$THEME_DIR/theme.json" ] && THEME_AVAILABLE="true"

if ! stop_recorded_injector; then
  printf 'WorkBuddy Dream Skin: warning: the watcher did not stop cleanly; shutdown will continue.\n' >&2
fi

ENDPOINT_MATCH="false"
RECORDED_WORKBUDDY_ALIVE="false"
process_identity_matches "$WORKBUDDY_PID" "$WORKBUDDY_STARTED_AT" && RECORDED_WORKBUDDY_ALIVE="true"

if ! port_is_available "$PORT"; then
  if [ "$HOST_RUNTIME_AVAILABLE" != "true" ] || ! verified_cdp_endpoint "$PORT"; then
    [ "$RECORDED_WORKBUDDY_ALIVE" = "true" ] \
      || fail "The recorded port is occupied by an unverified process; state was preserved."
    printf 'WorkBuddy Dream Skin: warning: CDP did not answer verification; closing only the recorded WorkBuddy process.\n' >&2
  else
    ENDPOINT_MATCH="true"
  fi
fi

if [ "$ENDPOINT_MATCH" = "true" ]; then
  CURRENT_BROWSER_ID="$(cdp_browser_id "$PORT" 2>/dev/null || true)"
  if [ "$CURRENT_BROWSER_ID" != "$BROWSER_ID" ]; then
    fail "The live CDP browser does not match the recorded skin session; state was preserved."
  fi
  [ "$RECORDED_WORKBUDDY_ALIVE" = "true" ] \
    || fail "The live CDP browser is no longer owned by the recorded WorkBuddy process; state was preserved."
  LISTENER_WORKBUDDY_PID="$(workbuddy_main_pid_for_listener "$PORT" 2>/dev/null || true)"
  [ "$LISTENER_WORKBUDDY_PID" = "$WORKBUDDY_PID" ] \
    || fail "The live CDP listener is not owned by the recorded WorkBuddy process; state was preserved."
  if [ "$THEME_AVAILABLE" = "true" ]; then
    REMOVE_ARGS=("$INJECTOR" --remove --port "$PORT" --theme-dir "$THEME_DIR" --timeout-ms 10000)
    REMOVE_ARGS+=(--browser-id "$BROWSER_ID")
    if ! run_node "${REMOVE_ARGS[@]}" >/dev/null; then
      printf 'WorkBuddy Dream Skin: warning: live DOM cleanup failed; closing the recorded WorkBuddy process will still remove the skin.\n' >&2
    fi
  else
    printf 'WorkBuddy Dream Skin: warning: the recorded theme assets are missing; closing the recorded WorkBuddy process will still remove the skin.\n' >&2
  fi
fi

WAS_RUNNING="false"
if [ "$RECORDED_WORKBUDDY_ALIVE" = "true" ]; then
  WAS_RUNNING="true"
  if workbuddy_launch_agent_is_owned; then
    APP_AGENT_PID="$(workbuddy_launch_agent_pid)"
    [ -z "$APP_AGENT_PID" ] || [ "$APP_AGENT_PID" = "$WORKBUDDY_PID" ] \
      || fail "The owned WorkBuddy launch job PID does not match state; state was preserved."
    stop_owned_workbuddy_launch_agent \
      || fail "The owned WorkBuddy launch job could not be stopped; state was preserved."
  else
    stop_recorded_workbuddy_process "$WORKBUDDY_PID" "$WORKBUDDY_STARTED_AT" \
      || fail "The recorded WorkBuddy skin process could not be stopped; state was preserved."
  fi
fi

wait_for_port_available "$PORT" 6 \
  || fail "The recorded debugging port is still listening; state was preserved."
if launch_agent_is_owned && ! stop_owned_launch_agent; then
  fail "The skin watcher is still loaded; state was preserved."
fi
if workbuddy_launch_agent_is_owned && ! stop_owned_workbuddy_launch_agent; then
  fail "The owned WorkBuddy launch job is still loaded; state was preserved."
fi

/bin/rm -f "$LAUNCH_AGENT_PLIST" "$WORKBUDDY_LAUNCH_AGENT_PLIST"

/bin/rm -f "$STATE_PATH"

relaunch_after_cleanup "$WAS_RUNNING"

clear_app_launch_logs

printf 'WorkBuddy Dream Skin is fully off; injected UI and the CDP session were removed.\n'
