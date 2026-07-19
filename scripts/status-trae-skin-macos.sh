#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

discover_trae_app
require_trae_runtime
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
  printf '{"session":"%s","traeRunning":%s,"ownedAppJob":%s,"ownedWatcherJob":%s}\n' \
    "$SESSION_STATUS" "$(trae_is_running && printf true || printf false)" \
    "$OWNED_APP_JOB" "$OWNED_WATCHER_JOB"
  exit 0
fi

PORT="$(state_field port)"
THEME_ID="$(state_field themeId)"
THEME_REVISION="$(state_field themeRevision)"
BROWSER_ID="$(state_field browserId)"
INJECTOR_PID="$(state_field injectorPid)"
INJECTOR_STARTED_AT="$(state_field injectorStartedAt)"
INJECTOR_ALIVE="false"
recorded_injector_is_alive "$INJECTOR_PID" "$INJECTOR_STARTED_AT" && INJECTOR_ALIVE="true"
CDP_OK="false"
if verified_cdp_endpoint "$PORT"; then
  CURRENT_BROWSER_ID="$(cdp_browser_id "$PORT" 2>/dev/null || true)"
  if [ -z "$BROWSER_ID" ] || [ "$CURRENT_BROWSER_ID" = "$BROWSER_ID" ]; then
    CDP_OK="true"
  fi
fi

THEME_REVISION_JSON="null"
if [[ "$THEME_REVISION" =~ ^[0-9a-f]{64}$ ]]; then
  THEME_REVISION_JSON="\"$THEME_REVISION\""
fi
printf '{"session":"%s","themeId":"%s","themeRevision":%s,"port":%s,"injectorAlive":%s,"cdpOk":%s}\n' \
  "$(state_field session)" "$THEME_ID" "$THEME_REVISION_JSON" "$PORT" "$INJECTOR_ALIVE" "$CDP_OK"
