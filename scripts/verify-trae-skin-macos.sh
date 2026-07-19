#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

SCREENSHOT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --screenshot) SCREENSHOT="${2:-}"; shift 2 ;;
    *) fail "Unknown verify argument: $1" ;;
  esac
done

discover_trae_app
require_trae_runtime
acquire_operation_lock
trap release_operation_lock EXIT
[ -f "$STATE_PATH" ] || fail "No active skin state was found."
PORT="$(state_field port)"
THEME_ID="$(state_field themeId)"
BROWSER_ID="$(state_field browserId)"
resolve_theme_dir "$THEME_ID"
verified_cdp_endpoint "$PORT" || fail "The saved port is not a verified Trae CDP endpoint."
[ -n "$BROWSER_ID" ] || fail "The saved CDP browser identity is missing."
[ "$(cdp_browser_id "$PORT")" = "$BROWSER_ID" ] || fail "The live CDP browser does not match the saved skin session."

ARGS=("$INJECTOR" --verify --port "$PORT" --browser-id "$BROWSER_ID" --theme-dir "$THEME_DIR" --timeout-ms 20000)
[ -n "$SCREENSHOT" ] && ARGS+=(--screenshot "$SCREENSHOT")
exec /usr/bin/env -u NODE_OPTIONS -u NODE_REPL_EXTERNAL_MODULE \
  ELECTRON_RUN_AS_NODE=1 "$TRAE_EXE" "${ARGS[@]}"
