#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-workbuddy-macos.sh"

[ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "This launcher requires macOS."
DISCOVERED_WORKBUDDY_EXE=""
if DISCOVERED_WORKBUDDY_EXE="$(
  discover_workbuddy_app 2>/dev/null
  printf '%s' "$WORKBUDDY_EXE"
)"; then
  WORKBUDDY_EXE="$DISCOVERED_WORKBUDDY_EXE"
  export WORKBUDDY_EXE
fi
ensure_state_root
acquire_operation_lock
trap release_operation_lock EXIT

if [ ! -f "$STATE_PATH" ]; then
  OWNED_APP_JOB="false"
  OWNED_WATCHER_JOB="false"
  workbuddy_launch_agent_path_is_owned && OWNED_APP_JOB="true"
  launch_agent_path_is_owned && OWNED_WATCHER_JOB="true"
  WORKBUDDY_RUNNING="false"
  [ -n "$DISCOVERED_WORKBUDDY_EXE" ] && workbuddy_is_running && WORKBUDDY_RUNNING="true"
  SESSION_STATUS="off"
  if [ "$OWNED_APP_JOB" = "true" ] || [ "$OWNED_WATCHER_JOB" = "true" ]; then
    SESSION_STATUS="orphaned"
  fi
  printf '{"session":"%s","workbuddyRunning":%s,"ownedAppJob":%s,"ownedWatcherJob":%s}\n' \
    "$SESSION_STATUS" "$WORKBUDDY_RUNNING" \
    "$OWNED_APP_JOB" "$OWNED_WATCHER_JOB"
  exit 0
fi

if ! workbuddy_state_is_trustworthy; then
  OWNED_APP_JOB="false"
  OWNED_WATCHER_JOB="false"
  workbuddy_launch_agent_path_is_owned && OWNED_APP_JOB="true"
  launch_agent_path_is_owned && OWNED_WATCHER_JOB="true"
  WORKBUDDY_RUNNING="false"
  [ -n "$DISCOVERED_WORKBUDDY_EXE" ] && workbuddy_is_running && WORKBUDDY_RUNNING="true"
  SESSION_STATUS="off"
  if [ "$OWNED_APP_JOB" = "true" ] || [ "$OWNED_WATCHER_JOB" = "true" ]; then
    SESSION_STATUS="orphaned-unverified"
  fi
  printf '{"session":"%s","stateValid":false,"workbuddyRunning":%s,"ownedAppJob":%s,"ownedWatcherJob":%s}\n' \
    "$SESSION_STATUS" "$WORKBUDDY_RUNNING" \
    "$OWNED_APP_JOB" "$OWNED_WATCHER_JOB"
  exit 0
fi

WORKBUDDY_BUNDLE="$(state_field workbuddyBundle)"
WORKBUDDY_EXE="$(state_field workbuddyExe)"
WORKBUDDY_VERSION="$(state_field workbuddyVersion 2>/dev/null || true)"
export WORKBUDDY_BUNDLE WORKBUDDY_EXE WORKBUDDY_VERSION

PORT="$(state_field port)"
THEME_ID="$(state_field themeId)"
THEME_REVISION="$(state_field themeRevision)"
BROWSER_ID="$(state_field browserId)"
INJECTOR_PID="$(state_field injectorPid)"
INJECTOR_STARTED_AT="$(state_field injectorStartedAt)"
WORKBUDDY_PID="$(state_field workbuddyPid)"
WORKBUDDY_STARTED_AT="$(state_field workbuddyStartedAt)"
OWNS_SESSION="$(state_field ownsSession)"
INJECTOR_ALIVE="false"
recorded_injector_is_alive "$INJECTOR_PID" "$INJECTOR_STARTED_AT" && INJECTOR_ALIVE="true"
WORKBUDDY_ALIVE="false"
process_identity_matches "$WORKBUDDY_PID" "$WORKBUDDY_STARTED_AT" && WORKBUDDY_ALIVE="true"
OWNED_APP_JOB="false"
if workbuddy_launch_agent_is_owned && \
  [ "$(workbuddy_launch_agent_pid)" = "$WORKBUDDY_PID" ]; then
  OWNED_APP_JOB="true"
fi
OWNED_WATCHER_JOB="false"
if launch_agent_is_owned && [ "$(launch_agent_pid)" = "$INJECTOR_PID" ]; then
  OWNED_WATCHER_JOB="true"
fi
CDP_OK="false"
if [ "$WORKBUDDY_ALIVE" = "true" ] && verified_cdp_endpoint "$PORT"; then
  CURRENT_BROWSER_ID="$(cdp_browser_id "$PORT" 2>/dev/null || true)"
  LISTENER_WORKBUDDY_PID="$(workbuddy_main_pid_for_listener "$PORT" 2>/dev/null || true)"
  if [ -n "$BROWSER_ID" ] && [ "$CURRENT_BROWSER_ID" = "$BROWSER_ID" ] && \
    [ "$LISTENER_WORKBUDDY_PID" = "$WORKBUDDY_PID" ]; then
    CDP_OK="true"
  fi
fi

SESSION_STATUS="$(state_field session)"
if [ "$SESSION_STATUS" = "active" ] && { \
  [ "$OWNS_SESSION" != "true" ] || [ "$INJECTOR_ALIVE" != "true" ] || \
  [ "$WORKBUDDY_ALIVE" != "true" ] || [ "$CDP_OK" != "true" ] || \
  [ "$OWNED_APP_JOB" != "true" ] || [ "$OWNED_WATCHER_JOB" != "true" ];
}; then
  SESSION_STATUS="degraded"
fi

THEME_REVISION_JSON="null"
if [[ "$THEME_REVISION" =~ ^[0-9a-f]{64}$ ]]; then
  THEME_REVISION_JSON="\"$THEME_REVISION\""
fi
printf '{"session":"%s","themeId":"%s","themeRevision":%s,"port":%s,"injectorAlive":%s,"workbuddyAlive":%s,"cdpOk":%s,"ownedAppJob":%s,"ownedWatcherJob":%s}\n' \
  "$SESSION_STATUS" "$THEME_ID" "$THEME_REVISION_JSON" "$PORT" "$INJECTOR_ALIVE" \
  "$WORKBUDDY_ALIVE" "$CDP_OK" "$OWNED_APP_JOB" "$OWNED_WATCHER_JOB"
