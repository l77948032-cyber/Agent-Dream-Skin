#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

discover_trae_app
# Applying and verifying a theme perform the full deep-signature check. The
# frequently polled status path only needs the exact bundle/Team ID binding.
require_trae_runtime identity
acquire_operation_lock
trap release_operation_lock EXIT

if [ ! -f "$STATE_PATH" ]; then
  OWNED_APP_JOB="false"
  OWNED_WATCHER_JOB="false"
  trae_launch_agent_is_owned && OWNED_APP_JOB="true"
  launch_agent_is_owned && OWNED_WATCHER_JOB="true"
  SESSION_STATUS="off"
  if [ "$OWNED_APP_JOB" = "true" ] || [ "$OWNED_WATCHER_JOB" = "true" ]; then
    SESSION_STATUS="orphaned"
  fi
  printf '{"session":"%s","traeRunning":%s,"ownedAppJob":%s,"ownedWatcherJob":%s,"hostProfile":"%s","traeDisplayName":"%s","traeBundleId":"%s","traeVersion":"%s"}\n' \
    "$SESSION_STATUS" "$(trae_is_running && printf true || printf false)" \
    "$OWNED_APP_JOB" "$OWNED_WATCHER_JOB" "$TRAE_VARIANT" "$TRAE_DISPLAY_NAME" "$TRAE_BUNDLE_ID" "$TRAE_VERSION"
  exit 0
fi

if ! trae_state_is_trustworthy; then
  OWNED_APP_JOB="false"
  OWNED_WATCHER_JOB="false"
  trae_launch_agent_is_owned && OWNED_APP_JOB="true"
  launch_agent_is_owned && OWNED_WATCHER_JOB="true"
  TRAE_RUNNING="false"
  trae_is_running && TRAE_RUNNING="true"
  SESSION_STATUS="off"
  if [ "$OWNED_APP_JOB" = "true" ] || [ "$OWNED_WATCHER_JOB" = "true" ]; then
    SESSION_STATUS="orphaned-unverified"
  fi
  printf '{"session":"%s","stateValid":false,"traeRunning":%s,"ownedAppJob":%s,"ownedWatcherJob":%s,"hostProfile":"%s","traeDisplayName":"%s","traeBundleId":"%s","traeVersion":"%s"}\n' \
    "$SESSION_STATUS" "$TRAE_RUNNING" "$OWNED_APP_JOB" "$OWNED_WATCHER_JOB" \
    "$TRAE_VARIANT" "$TRAE_DISPLAY_NAME" "$TRAE_BUNDLE_ID" "$TRAE_VERSION"
  exit 0
fi

PORT="$(state_field port)"
THEME_ID="$(state_field themeId)"
THEME_REVISION="$(state_field themeRevision)"
BROWSER_ID="$(state_field browserId)"
INJECTOR_PID="$(state_field injectorPid)"
INJECTOR_STARTED_AT="$(state_field injectorStartedAt)"
TRAE_PID="$(state_field traePid)"
TRAE_STARTED_AT="$(state_field traeStartedAt)"
OWNS_SESSION="$(state_field ownsSession)"
INJECTOR_ALIVE="false"
recorded_injector_is_alive "$INJECTOR_PID" "$INJECTOR_STARTED_AT" && INJECTOR_ALIVE="true"
TRAE_ALIVE="false"
process_identity_matches "$TRAE_PID" "$TRAE_STARTED_AT" && TRAE_ALIVE="true"
OWNED_APP_JOB="false"
if trae_launch_agent_is_owned && [ "$(trae_launch_agent_pid)" = "$TRAE_PID" ]; then
  OWNED_APP_JOB="true"
fi
OWNED_WATCHER_JOB="false"
if launch_agent_is_owned && [ "$(launch_agent_pid)" = "$INJECTOR_PID" ]; then
  OWNED_WATCHER_JOB="true"
fi
CDP_OK="false"
if [ "$TRAE_ALIVE" = "true" ] && verified_cdp_endpoint "$PORT"; then
  CURRENT_BROWSER_ID="$(cdp_browser_id "$PORT" 2>/dev/null || true)"
  LISTENER_TRAE_PID="$(trae_main_pid_for_listener "$PORT" 2>/dev/null || true)"
  if [ -n "$BROWSER_ID" ] && [ "$CURRENT_BROWSER_ID" = "$BROWSER_ID" ] && \
    [ "$LISTENER_TRAE_PID" = "$TRAE_PID" ]; then
    CDP_OK="true"
  fi
fi

SESSION_STATUS="$(state_field session)"
if [ "$SESSION_STATUS" = "active" ] && { \
  [ "$OWNS_SESSION" != "true" ] || [ "$INJECTOR_ALIVE" != "true" ] || \
  [ "$TRAE_ALIVE" != "true" ] || [ "$CDP_OK" != "true" ] || \
  [ "$OWNED_APP_JOB" != "true" ] || [ "$OWNED_WATCHER_JOB" != "true" ];
}; then
  SESSION_STATUS="degraded"
fi

THEME_REVISION_JSON="null"
if [[ "$THEME_REVISION" =~ ^[0-9a-f]{64}$ ]]; then
  THEME_REVISION_JSON="\"$THEME_REVISION\""
fi
printf '{"session":"%s","themeId":"%s","themeRevision":%s,"port":%s,"injectorAlive":%s,"traeAlive":%s,"cdpOk":%s,"ownedAppJob":%s,"ownedWatcherJob":%s,"hostProfile":"%s","traeDisplayName":"%s","traeBundleId":"%s","traeVersion":"%s"}\n' \
  "$SESSION_STATUS" "$THEME_ID" "$THEME_REVISION_JSON" "$PORT" "$INJECTOR_ALIVE" \
  "$TRAE_ALIVE" "$CDP_OK" "$OWNED_APP_JOB" "$OWNED_WATCHER_JOB" \
  "$TRAE_VARIANT" "$TRAE_DISPLAY_NAME" "$TRAE_BUNDLE_ID" "$TRAE_VERSION"
