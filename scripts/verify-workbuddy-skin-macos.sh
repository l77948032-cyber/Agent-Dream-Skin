#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-workbuddy-macos.sh"

SCREENSHOT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --screenshot) SCREENSHOT="${2:-}"; shift 2 ;;
    *) fail "Unknown verify argument: $1" ;;
  esac
done

discover_workbuddy_app
require_workbuddy_runtime
acquire_operation_lock
trap release_operation_lock EXIT
[ -f "$STATE_PATH" ] || fail "No active skin state was found."
PORT="$(state_field port)"
THEME_ID="$(state_field themeId)"
BROWSER_ID="$(state_field browserId)"
INJECTOR_PID="$(state_field injectorPid)"
INJECTOR_STARTED_AT="$(state_field injectorStartedAt)"
WORKBUDDY_PID="$(state_field workbuddyPid)"
WORKBUDDY_STARTED_AT="$(state_field workbuddyStartedAt)"
resolve_theme_dir "$THEME_ID"
recorded_injector_is_alive "$INJECTOR_PID" "$INJECTOR_STARTED_AT" \
  || fail "The persistent WorkBuddy skin watcher is not alive. Apply the theme again before verifying."
launch_agent_is_owned \
  || fail "The persistent WorkBuddy skin watcher job is not owned by this runtime."
[ "$(launch_agent_pid)" = "$INJECTOR_PID" ] \
  || fail "The persistent WorkBuddy skin watcher job no longer matches the recorded process."
process_identity_matches "$WORKBUDDY_PID" "$WORKBUDDY_STARTED_AT" \
  || fail "The recorded WorkBuddy process is no longer alive."
workbuddy_launch_agent_is_owned \
  || fail "The WorkBuddy skin application job is not owned by this runtime."
[ "$(workbuddy_launch_agent_pid)" = "$WORKBUDDY_PID" ] \
  || fail "The WorkBuddy skin application job no longer matches the recorded process."
verified_cdp_endpoint "$PORT" || fail "The saved port is not a verified WorkBuddy CDP endpoint."
[ -n "$BROWSER_ID" ] || fail "The saved CDP browser identity is missing."
[ "$(cdp_browser_id "$PORT")" = "$BROWSER_ID" ] || fail "The live CDP browser does not match the saved skin session."
[ "$(workbuddy_main_pid_for_listener "$PORT" 2>/dev/null || true)" = "$WORKBUDDY_PID" ] \
  || fail "The live CDP listener no longer belongs to the recorded WorkBuddy process."

ARGS=("$INJECTOR" --verify --port "$PORT" --browser-id "$BROWSER_ID" \
  --theme-dir "$THEME_DIR" --css-path "$WORKBUDDY_SKIN_CSS_PATH" \
  --template-path "$WORKBUDDY_RENDERER_TEMPLATE_PATH" \
  --registry-path "$WORKBUDDY_COMPONENT_REGISTRY_PATH" --timeout-ms 20000)
[ -n "$SCREENSHOT" ] && ARGS+=(--screenshot "$SCREENSHOT")
VERIFY_OUTPUT="$(run_node "${ARGS[@]}")" \
  || fail "WorkBuddy skin DOM verification failed."
run_node -e '
  const result = JSON.parse(process.argv[1]);
  result.persistence = {
    watcherAlive: true,
    watcherJobOwned: true,
    workbuddyAlive: true,
    appJobOwned: true,
    cdpOwned: true,
  };
  const targetsPass = Array.isArray(result.targets) && result.targets.length > 0 &&
    result.targets.every((target) => target?.result?.pass === true);
  result.pass = result.pass === true && targetsPass;
  process.stdout.write(`${JSON.stringify(result)}\n`);
' "$VERIFY_OUTPUT"
