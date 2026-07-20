#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
INJECTOR="$SCRIPT_DIR/workbuddy-injector.mjs"
THEMES_ROOT="${WORKBUDDY_DREAM_SKIN_THEMES_ROOT:-$PROJECT_ROOT/plugins/workbuddy/catalog}"
WORKBUDDY_SKIN_CSS_PATH="${WORKBUDDY_DREAM_SKIN_CSS_PATH:-$PROJECT_ROOT/plugins/workbuddy/assets/workbuddy-skin.css}"
WORKBUDDY_RENDERER_TEMPLATE_PATH="${WORKBUDDY_DREAM_SKIN_TEMPLATE_PATH:-$PROJECT_ROOT/assets/workbuddy-renderer-inject.js}"
WORKBUDDY_COMPONENT_REGISTRY_PATH="${WORKBUDDY_DREAM_SKIN_REGISTRY_PATH:-$PROJECT_ROOT/plugins/workbuddy/resources/components.v1.json}"
DEFAULT_THEME_ID="harbor-focus"
DEFAULT_PORT="9432"
SKIN_VERSION="0.4.0"

STATE_ROOT="${WORKBUDDY_DREAM_SKIN_HOME:-$HOME/Library/Application Support/WorkBuddyDreamSkin}"
STATE_PATH="$STATE_ROOT/state.json"
INJECTOR_LOG="$STATE_ROOT/injector.log"
INJECTOR_ERROR_LOG="$STATE_ROOT/injector-error.log"
APP_LOG="$STATE_ROOT/workbuddy-launch.log"
APP_ERROR_LOG="$STATE_ROOT/workbuddy-launch-error.log"
LAUNCH_AGENT_LABEL="${WORKBUDDY_DREAM_SKIN_LAUNCH_LABEL:-local.workbuddy-dream-skin.injector}"
LAUNCH_AGENT_PLIST="$STATE_ROOT/injector-launch-agent.plist"
LAUNCH_AGENT_DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCH_AGENT_TARGET="$LAUNCH_AGENT_DOMAIN/$LAUNCH_AGENT_LABEL"
WORKBUDDY_LAUNCH_AGENT_LABEL="local.workbuddy-dream-skin.workbuddy"
WORKBUDDY_LAUNCH_AGENT_PLIST="$STATE_ROOT/workbuddy-launch-agent.plist"
WORKBUDDY_LAUNCH_AGENT_TARGET="$LAUNCH_AGENT_DOMAIN/$WORKBUDDY_LAUNCH_AGENT_LABEL"
OPERATION_LOCK_DIR="$STATE_ROOT/operation.lock"
OPERATION_LOCK_OWNER="$OPERATION_LOCK_DIR/owner"
OPERATION_LOCK_HELD="false"

EXPECTED_WORKBUDDY_TEAM_ID="${WORKBUDDY_EXPECTED_TEAM_ID:-FN2V63AD2J}"
SUPPORTED_WORKBUDDY_BUNDLE_IDS="com.workbuddy.workbuddy"

fail() {
  printf 'WorkBuddy Dream Skin: %s\n' "$*" >&2
  exit 1
}

ensure_state_root() {
  /bin/mkdir -p "$STATE_ROOT"
  /bin/chmod 700 "$STATE_ROOT"
}

acquire_operation_lock() {
  ensure_state_root
  local attempt=0
  local owner=""
  while [ "$attempt" -lt 2 ]; do
    if /bin/mkdir "$OPERATION_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$OPERATION_LOCK_OWNER"
      /bin/chmod 600 "$OPERATION_LOCK_OWNER"
      OPERATION_LOCK_HELD="true"
      return 0
    fi
    owner="$(/bin/cat "$OPERATION_LOCK_OWNER" 2>/dev/null || true)"
    case "$owner" in
      ''|*[!0-9]*) ;;
      *) /bin/kill -0 "$owner" 2>/dev/null \
        && fail "Another start, switch, verify, stop, or status operation is already running." ;;
    esac
    /bin/rm -f "$OPERATION_LOCK_OWNER"
    /bin/rmdir "$OPERATION_LOCK_DIR" 2>/dev/null || true
    attempt=$((attempt + 1))
  done
  fail "The operation lock could not be acquired."
}

release_operation_lock() {
  [ "$OPERATION_LOCK_HELD" = "true" ] || return 0
  local owner=""
  owner="$(/bin/cat "$OPERATION_LOCK_OWNER" 2>/dev/null || true)"
  if [ "$owner" = "$$" ]; then
    /bin/rm -f "$OPERATION_LOCK_OWNER"
    /bin/rmdir "$OPERATION_LOCK_DIR" 2>/dev/null || true
  fi
  OPERATION_LOCK_HELD="false"
}

plist_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null || true
}

is_supported_bundle_id() {
  local identifier="$1"
  local allowed
  for allowed in $SUPPORTED_WORKBUDDY_BUNDLE_IDS; do
    [ "$identifier" = "$allowed" ] && return 0
  done
  return 1
}

discover_workbuddy_app() {
  local candidate=""
  local identifier=""
  local configured="${WORKBUDDY_APP_BUNDLE:-}"

  for candidate in \
    "$configured" \
    "/Applications/WorkBuddy.app" \
    "$HOME/Applications/WorkBuddy.app"
  do
    [ -n "$candidate" ] || continue
    [ -f "$candidate/Contents/Info.plist" ] || continue
    identifier="$(plist_value "$candidate" CFBundleIdentifier)"
    if is_supported_bundle_id "$identifier"; then
      WORKBUDDY_BUNDLE="$candidate"
      WORKBUDDY_BUNDLE_ID="$identifier"
      break
    fi
  done

  if [ -z "${WORKBUDDY_BUNDLE:-}" ]; then
    candidate="$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.workbuddy.workbuddy"' 2>/dev/null | /usr/bin/head -n 1)"
    if [ -n "$candidate" ] && [ -f "$candidate/Contents/Info.plist" ]; then
      identifier="$(plist_value "$candidate" CFBundleIdentifier)"
      if is_supported_bundle_id "$identifier"; then
        WORKBUDDY_BUNDLE="$candidate"
        WORKBUDDY_BUNDLE_ID="$identifier"
      fi
    fi
  fi

  [ -n "${WORKBUDDY_BUNDLE:-}" ] || fail "Could not find the official WorkBuddy app."
  WORKBUDDY_EXECUTABLE_NAME="$(plist_value "$WORKBUDDY_BUNDLE" CFBundleExecutable)"
  WORKBUDDY_EXE="$WORKBUDDY_BUNDLE/Contents/MacOS/$WORKBUDDY_EXECUTABLE_NAME"
  WORKBUDDY_VERSION="$(plist_value "$WORKBUDDY_BUNDLE" CFBundleShortVersionString)"
  [ -x "$WORKBUDDY_EXE" ] || fail "WorkBuddy executable is missing: $WORKBUDDY_EXE"
  export WORKBUDDY_BUNDLE WORKBUDDY_BUNDLE_ID WORKBUDDY_EXE WORKBUDDY_VERSION
}

codesign_team_id() {
  /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 \
    | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2; exit}'
}

sha256_file() {
  /usr/bin/shasum -a 256 "$1" 2>/dev/null | /usr/bin/awk '{print $1}'
}

sha256_bundle_tree() {
  local bundle="$1"
  (
    cd "$bundle"
    {
      /usr/bin/find Contents -type f -print0 \
        | /usr/bin/sort -z \
        | /usr/bin/xargs -0 /usr/bin/shasum -a 256
      /usr/bin/find Contents -type l -print0 \
        | /usr/bin/sort -z \
        | /usr/bin/xargs -0 /usr/bin/stat -f 'L %N -> %Y'
    } | LC_ALL=C /usr/bin/sort \
      | /usr/bin/shasum -a 256 \
      | /usr/bin/awk '{print $1}'
  )
}

run_node() {
  /usr/bin/env -u NODE_OPTIONS -u NODE_REPL_EXTERNAL_MODULE \
    ELECTRON_RUN_AS_NODE=1 "$WORKBUDDY_EXE" "$@"
}

require_workbuddy_runtime() {
  [ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "This launcher requires macOS."
  [ -n "${WORKBUDDY_BUNDLE:-}" ] || fail "Discover WorkBuddy before validating its runtime."
  WORKBUDDY_TEAM_ID="$(codesign_team_id "$WORKBUDDY_BUNDLE")"
  [ "$WORKBUDDY_TEAM_ID" = "$EXPECTED_WORKBUDDY_TEAM_ID" ] \
    || fail "Unexpected WorkBuddy signing team: ${WORKBUDDY_TEAM_ID:-missing}."
  /usr/bin/codesign --verify --deep --strict "$WORKBUDDY_BUNDLE" >/dev/null 2>&1 \
    || fail "WorkBuddy's code signature is invalid. Reinstall the official app before continuing."
  [ -f "$WORKBUDDY_SKIN_CSS_PATH" ] || fail "WorkBuddy skin CSS is missing: $WORKBUDDY_SKIN_CSS_PATH"
  [ -f "$WORKBUDDY_RENDERER_TEMPLATE_PATH" ] \
    || fail "WorkBuddy renderer template is missing: $WORKBUDDY_RENDERER_TEMPLATE_PATH"
  [ -f "$WORKBUDDY_COMPONENT_REGISTRY_PATH" ] \
    || fail "WorkBuddy component registry is missing: $WORKBUDDY_COMPONENT_REGISTRY_PATH"
  NODE_VERSION="$(run_node --version 2>/dev/null || true)"
  case "$NODE_VERSION" in v2[0-9].*|v[3-9][0-9].*) ;; *) fail "WorkBuddy's embedded Node runtime is unsupported: ${NODE_VERSION:-missing}." ;; esac
  export WORKBUDDY_TEAM_ID NODE_VERSION
}

workbuddy_main_pids() {
  local pid=""
  local command_line=""
  while read -r pid command_line; do
    [ -n "$pid" ] || continue
    case "$command_line" in
      "$WORKBUDDY_EXE"|"$WORKBUDDY_EXE --"*) printf '%s\n' "$pid" ;;
    esac
  done < <(/bin/ps -axo pid=,command= 2>/dev/null || true)
}

pid_is_workbuddy_main() {
  local pid="$1"
  local command_line=""
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in "$WORKBUDDY_EXE"|"$WORKBUDDY_EXE --"*) return 0 ;; esac
  return 1
}

process_identity_matches() {
  local pid="$1"
  local expected_start="$2"
  pid_is_workbuddy_main "$pid" || return 1
  [ -z "$expected_start" ] || [ "$(process_started_at "$pid")" = "$expected_start" ]
}

recorded_injector_is_alive() {
  local pid="$1"
  local expected_start="$2"
  local command_line=""
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in *"$INJECTOR"*--watch*) ;; *) return 1 ;; esac
  [ -z "$expected_start" ] || [ "$(process_started_at "$pid")" = "$expected_start" ]
}

stop_recorded_workbuddy_process() {
  local pid="$1"
  local expected_start="$2"
  local deadline=$((SECONDS + 15))
  process_identity_matches "$pid" "$expected_start" || return 0
  /bin/kill -TERM "$pid" 2>/dev/null || true
  while process_identity_matches "$pid" "$expected_start" && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.25
  done
  ! process_identity_matches "$pid" "$expected_start"
}

workbuddy_is_running() {
  [ -n "$(workbuddy_main_pids)" ]
}

process_started_at() {
  LC_ALL=C /bin/ps -p "$1" -o lstart= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

stop_workbuddy() {
  local allow_force="${1:-false}"
  local deadline=$((SECONDS + 15))
  local pid=""

  workbuddy_is_running || return 0
  /usr/bin/osascript -e "tell application id \"$WORKBUDDY_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  while workbuddy_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.25; done
  workbuddy_is_running || return 0

  [ "$allow_force" = "true" ] || fail "WorkBuddy did not close within 15 seconds."
  while IFS= read -r pid; do
    [ -n "$pid" ] && /bin/kill -TERM "$pid" 2>/dev/null || true
  done < <(workbuddy_main_pids)
  deadline=$((SECONDS + 5))
  while workbuddy_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.25; done
  workbuddy_is_running && fail "WorkBuddy could not be stopped safely."
}

listener_pids() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | /usr/bin/sort -u || true
}

listener_names() {
  /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fn 2>/dev/null \
    | /usr/bin/awk '/^n/{print substr($0, 2)}' || true
}

port_listens_on_loopback_only() {
  local port="$1"
  local name=""
  local found="false"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    found="true"
    case "$name" in
      "127.0.0.1:$port"|"[::1]:$port"|"::1:$port") ;;
      *) return 1 ;;
    esac
  done < <(listener_names "$port")
  [ "$found" = "true" ]
}

port_is_available() {
  [ -z "$(listener_pids "$1")" ]
}

wait_for_port_available() {
  local port="$1"
  local timeout_seconds="${2:-6}"
  local deadline=$((SECONDS + timeout_seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do
    port_is_available "$port" && return 0
    /bin/sleep 0.2
  done
  port_is_available "$port"
}

pid_is_workbuddy_descendant() {
  workbuddy_main_ancestor_pid "$1" >/dev/null
}

workbuddy_main_ancestor_pid() {
  local current="$1"
  local parent=""
  local command_line=""
  local depth=0
  while [ "$current" -gt 1 ] 2>/dev/null && [ "$depth" -lt 32 ]; do
    command_line="$(/bin/ps -p "$current" -o command= 2>/dev/null || true)"
    case "$command_line" in
      "$WORKBUDDY_EXE"|"$WORKBUDDY_EXE --"*) printf '%s\n' "$current"; return 0 ;;
    esac
    parent="$(/bin/ps -p "$current" -o ppid= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')"
    case "$parent" in ''|*[!0-9]*) return 1 ;; esac
    [ "$parent" -ne "$current" ] || return 1
    current="$parent"
    depth=$((depth + 1))
  done
  return 1
}

workbuddy_main_pid_for_listener() {
  local port="$1"
  local listener_pid=""
  local main_pid=""
  local resolved_pid=""
  while IFS= read -r listener_pid; do
    [ -n "$listener_pid" ] || continue
    main_pid="$(workbuddy_main_ancestor_pid "$listener_pid")" || return 1
    if [ -n "$resolved_pid" ] && [ "$resolved_pid" != "$main_pid" ]; then
      return 1
    fi
    resolved_pid="$main_pid"
  done < <(listener_pids "$port")
  [ -n "$resolved_pid" ] || return 1
  printf '%s\n' "$resolved_pid"
}

port_belongs_to_workbuddy() {
  local pid=""
  local found="false"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    pid_is_workbuddy_descendant "$pid" || return 1
    found="true"
  done < <(listener_pids "$1")
  [ "$found" = "true" ]
}

cdp_http_ready() {
  /usr/bin/curl --noproxy '*' --silent --fail --max-time 1 \
    "http://127.0.0.1:$1/json/version" >/dev/null 2>&1
}

cdp_browser_id() {
  local port="$1"
  local payload=""
  payload="$(/usr/bin/curl --noproxy '*' --silent --fail --max-time 2 \
    "http://127.0.0.1:$port/json/version")" || return 1
  run_node -e '
    const [payload, expectedPort] = process.argv.slice(1);
    const parsed = JSON.parse(payload);
    const url = new URL(parsed.webSocketDebuggerUrl);
    const match = url.pathname.match(/^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/);
    const hosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
    if (url.protocol !== "ws:" || !hosts.has(url.hostname.toLowerCase()) ||
      Number(url.port) !== Number(expectedPort) || url.username || url.password ||
      url.search || url.hash || !match) process.exit(2);
    process.stdout.write(match[1]);
  ' "$payload" "$port"
}

verified_cdp_endpoint() {
  cdp_http_ready "$1" && port_belongs_to_workbuddy "$1" && port_listens_on_loopback_only "$1"
}

select_available_port() {
  local candidate="$1"
  local last=$((candidate + 100))
  [ "$last" -le 65535 ] || last=65535
  while [ "$candidate" -le "$last" ]; do
    if port_is_available "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  fail "No free loopback port was found."
}

wait_for_cdp() {
  local port="$1"
  local deadline=$((SECONDS + 45))
  while [ "$SECONDS" -lt "$deadline" ]; do
    verified_cdp_endpoint "$port" && return 0
    /bin/sleep 0.35
  done
  return 1
}

state_field() {
  local key="$1"
  [ -f "$STATE_PATH" ] || return 0
  /usr/bin/plutil -extract "$key" raw -o - "$STATE_PATH" 2>/dev/null || true
}

workbuddy_state_is_trustworthy() {
  local schema_version=""
  local session=""
  local owns_session=""
  local port=""
  local browser_id=""
  local injector_pid=""
  local injector_started_at=""
  local workbuddy_pid=""
  local workbuddy_started_at=""
  local workbuddy_bundle=""
  local workbuddy_exe=""
  local theme_id=""
  local theme_revision=""
  local watcher_label=""
  local watcher_plist=""
  local app_label=""
  local app_plist=""
  [ -f "$STATE_PATH" ] || return 1
  /usr/bin/plutil -convert xml1 -o /dev/null "$STATE_PATH" >/dev/null 2>&1 || return 1
  schema_version="$(state_field schemaVersion)" || return 1
  session="$(state_field session)" || return 1
  owns_session="$(state_field ownsSession)" || return 1
  port="$(state_field port)" || return 1
  browser_id="$(state_field browserId)" || return 1
  injector_pid="$(state_field injectorPid)" || return 1
  injector_started_at="$(state_field injectorStartedAt)" || return 1
  workbuddy_pid="$(state_field workbuddyPid)" || return 1
  workbuddy_started_at="$(state_field workbuddyStartedAt)" || return 1
  workbuddy_bundle="$(state_field workbuddyBundle)" || return 1
  workbuddy_exe="$(state_field workbuddyExe)" || return 1
  theme_id="$(state_field themeId)" || return 1
  theme_revision="$(state_field themeRevision 2>/dev/null || true)"
  watcher_label="$(state_field launchAgentLabel)" || return 1
  watcher_plist="$(state_field launchAgentPlist)" || return 1
  app_label="$(state_field appLaunchAgentLabel)" || return 1
  app_plist="$(state_field appLaunchAgentPlist)" || return 1

  [ "$schema_version" = "1" ] && [ "$session" = "active" ] && [ "$owns_session" = "true" ] \
    || return 1
  case "$port" in ''|*[!0-9]*) return 1 ;; esac
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || return 1
  case "$browser_id" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$injector_pid" in ''|0|*[!0-9]*) return 1 ;; esac
  case "$workbuddy_pid" in ''|0|*[!0-9]*) return 1 ;; esac
  [ -n "$injector_started_at" ] && [ -n "$workbuddy_started_at" ] || return 1
  case "$theme_id" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  if [ -n "$theme_revision" ] && [[ ! "$theme_revision" =~ ^[a-f0-9]{64}$ ]]; then
    return 1
  fi
  case "$workbuddy_bundle" in /*.app) ;; *) return 1 ;; esac
  case "$workbuddy_exe" in "$workbuddy_bundle"/Contents/MacOS/*) ;; *) return 1 ;; esac
  [ "$watcher_label" = "$LAUNCH_AGENT_LABEL" ] \
    && [ "$watcher_plist" = "$LAUNCH_AGENT_PLIST" ] \
    && [ "$app_label" = "$WORKBUDDY_LAUNCH_AGENT_LABEL" ] \
    && [ "$app_plist" = "$WORKBUDDY_LAUNCH_AGENT_PLIST" ]
}

resolve_theme_dir() {
  local id="$1"
  case "$id" in ''|*[!A-Za-z0-9_-]*) fail "Invalid theme id: $id" ;; esac
  THEME_ID="$id"
  THEME_DIR="$THEMES_ROOT/$id"
  [ -f "$THEME_DIR/theme.json" ] || fail "Theme not found: $id"
  export THEME_ID THEME_DIR
}

write_state() {
  local port="$1"
  local injector_pid="$2"
  local injector_started_at="$3"
  local workbuddy_pid="$4"
  local workbuddy_started_at="$5"
  local browser_id="$6"
  local owns_session="$7"
  local started_cdp_here="$8"
  local theme_revision="${9:-}"
  run_node -e '
    const fs = require("node:fs");
    const [file, version, port, browserId, pid, startedAt, injector, nodeVersion, bundle, exe, appVersion, teamId, root, themeId, themeDir, themeRevision, appPid, appStartedAt, ownsSession, startedCdpHere, arch, launchLabel, launchPlist, appLaunchLabel, appLaunchPlist] = process.argv.slice(1);
    const state = {
      schemaVersion: 1,
      platform: `darwin-${arch}`,
      skinVersion: version,
      session: "active",
      ownsSession: ownsSession === "true",
      startedCdpHere: startedCdpHere === "true",
      port: Number(port),
      browserId,
      injectorPid: Number(pid),
      injectorStartedAt: startedAt,
      injectorPath: injector,
      nodeVersion,
      workbuddyBundle: bundle,
      workbuddyExe: exe,
      workbuddyVersion: appVersion,
      workbuddyTeamId: teamId,
      workbuddyPid: Number(appPid || 0),
      workbuddyStartedAt: appStartedAt,
      projectRoot: root,
      themeId,
      themeDir,
      themeRevision: themeRevision || null,
      launchAgentLabel: launchLabel,
      launchAgentPlist: launchPlist,
      appLaunchAgentLabel: appLaunchLabel,
      appLaunchAgentPlist: appLaunchPlist,
      createdAt: new Date().toISOString()
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  ' "$STATE_PATH" "$SKIN_VERSION" "$port" "$browser_id" "$injector_pid" "$injector_started_at" "$INJECTOR" "$NODE_VERSION" "$WORKBUDDY_BUNDLE" "$WORKBUDDY_EXE" "$WORKBUDDY_VERSION" "$WORKBUDDY_TEAM_ID" "$PROJECT_ROOT" "$THEME_ID" "$THEME_DIR" "$theme_revision" "$workbuddy_pid" "$workbuddy_started_at" "$owns_session" "$started_cdp_here" "$(/usr/bin/uname -m)" "$LAUNCH_AGENT_LABEL" "$LAUNCH_AGENT_PLIST" "$WORKBUDDY_LAUNCH_AGENT_LABEL" "$WORKBUDDY_LAUNCH_AGENT_PLIST"
}

workbuddy_launch_agent_output() {
  /bin/launchctl print "$WORKBUDDY_LAUNCH_AGENT_TARGET" 2>/dev/null || true
}

workbuddy_launch_agent_pid() {
  workbuddy_launch_agent_output \
    | /usr/bin/awk '$1 == "pid" && $2 == "=" { pid = $3 } END { if (pid) print pid }'
}

workbuddy_launch_agent_port() {
  workbuddy_launch_agent_output \
    | /usr/bin/sed -n 's/.*WORKBUDDY_REMOTE_DEBUGGING_PORT[^0-9]*\([0-9][0-9]*\).*/\1/p' \
    | /usr/bin/head -n 1
}

workbuddy_launch_agent_path_is_owned() {
  local output=""
  output="$(workbuddy_launch_agent_output)"
  [ -n "$output" ] || return 1
  case "$output" in *"path = $WORKBUDDY_LAUNCH_AGENT_PLIST"*) return 0 ;; esac
  return 1
}

workbuddy_launch_agent_is_owned() {
  local output=""
  workbuddy_launch_agent_path_is_owned || return 1
  [ -n "${WORKBUDDY_EXE:-}" ] || return 1
  output="$(workbuddy_launch_agent_output)"
  case "$output" in
    *"path = $WORKBUDDY_LAUNCH_AGENT_PLIST"*"program = $WORKBUDDY_EXE"*) return 0 ;;
  esac
  return 1
}

stop_path_owned_workbuddy_launch_agent() {
  local pid=""
  workbuddy_launch_agent_path_is_owned || return 0
  pid="$(workbuddy_launch_agent_pid)"
  /bin/launchctl bootout "$WORKBUDDY_LAUNCH_AGENT_TARGET" >/dev/null 2>&1 || return 1
  if [ -n "$pid" ]; then
    local deadline=$((SECONDS + 15))
    while /bin/kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
      /bin/sleep 0.2
    done
  fi
  [ -z "$(workbuddy_launch_agent_output)" ] && { [ -z "$pid" ] || ! /bin/kill -0 "$pid" 2>/dev/null; }
}

stop_owned_workbuddy_launch_agent() {
  local pid=""
  workbuddy_launch_agent_is_owned || return 0
  stop_path_owned_workbuddy_launch_agent
}

launch_agent_output() {
  /bin/launchctl print "$LAUNCH_AGENT_TARGET" 2>/dev/null || true
}

launch_agent_pid() {
  launch_agent_output | /usr/bin/awk '$1 == "pid" && $2 == "=" { pid = $3 } END { if (pid) print pid }'
}

launch_agent_path_is_owned() {
  local output=""
  output="$(launch_agent_output)"
  [ -n "$output" ] || return 1
  case "$output" in *"path = $LAUNCH_AGENT_PLIST"*) return 0 ;; esac
  return 1
}

launch_agent_is_owned() {
  local output=""
  output="$(launch_agent_output)"
  [ -n "$output" ] || return 1
  case "$output" in
    *"path = $LAUNCH_AGENT_PLIST"*) return 0 ;;
    *"program = ${WORKBUDDY_EXE:-__missing_workbuddy_exe__}"*"$INJECTOR"*) return 0 ;;
  esac
  return 1
}

stop_path_owned_launch_agent() {
  local pid=""
  launch_agent_path_is_owned || return 0
  pid="$(launch_agent_pid)"
  /bin/launchctl bootout "$LAUNCH_AGENT_TARGET" >/dev/null 2>&1 || return 1
  if [ -n "$pid" ]; then
    local deadline=$((SECONDS + 6))
    while /bin/kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.2; done
  fi
  [ -z "$(launch_agent_output)" ] && { [ -z "$pid" ] || ! /bin/kill -0 "$pid" 2>/dev/null; }
}

stop_owned_launch_agent() {
  launch_agent_is_owned || return 0
  stop_path_owned_launch_agent
}

stop_recorded_injector() {
  stop_owned_launch_agent
  [ -f "$STATE_PATH" ] || return 0
  local pid="$(state_field injectorPid 2>/dev/null || true)"
  local saved_start="$(state_field injectorStartedAt 2>/dev/null || true)"
  recorded_injector_is_alive "$pid" "$saved_start" || return 0
  /bin/kill -TERM "$pid" 2>/dev/null || true
  local deadline=$((SECONDS + 6))
  while /bin/kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.2; done
  ! recorded_injector_is_alive "$pid" "$saved_start"
}

launch_injector_daemon() {
  local port="$1"
  local browser_id="$2"
  local pid=""
  local deadline=$((SECONDS + 10))
  : > "$INJECTOR_LOG"
  : > "$INJECTOR_ERROR_LOG"
  if [ -n "$(launch_agent_output)" ]; then
    launch_agent_is_owned || fail "The launchd label $LAUNCH_AGENT_LABEL is already owned by another job."
    stop_owned_launch_agent
  fi
  run_node -e '
    const fs = require("node:fs");
    const [file, label, exe, injector, port, browserId, themeDir, cssPath, templatePath, registryPath, root, stdout, stderr] = process.argv.slice(1);
    const escape = (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll(String.fromCharCode(39), "&apos;");
    const args = [exe, injector, "--watch", "--port", port, "--browser-id", browserId,
      "--theme-dir", themeDir, "--css-path", cssPath, "--template-path", templatePath];
    args.push("--registry-path", registryPath);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escape(label)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escape(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${escape(stdout)}</string>
  <key>StandardErrorPath</key><string>${escape(stderr)}</string>
</dict></plist>\n`;
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, xml, { mode: 0o600 });
    fs.renameSync(temporary, file);
  ' "$LAUNCH_AGENT_PLIST" "$LAUNCH_AGENT_LABEL" "$WORKBUDDY_EXE" "$INJECTOR" "$port" "$browser_id" "$THEME_DIR" "$WORKBUDDY_SKIN_CSS_PATH" "$WORKBUDDY_RENDERER_TEMPLATE_PATH" "$WORKBUDDY_COMPONENT_REGISTRY_PATH" "$PROJECT_ROOT" "$INJECTOR_LOG" "$INJECTOR_ERROR_LOG"
  /usr/bin/plutil -lint "$LAUNCH_AGENT_PLIST" >/dev/null \
    || fail "The generated injector launch agent is invalid."
  /bin/launchctl bootstrap "$LAUNCH_AGENT_DOMAIN" "$LAUNCH_AGENT_PLIST" 2>>"$INJECTOR_ERROR_LOG" \
    || fail "The injector launch agent could not be loaded. See $INJECTOR_ERROR_LOG"
  /bin/launchctl kickstart "$LAUNCH_AGENT_TARGET" >/dev/null 2>&1 || true
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(launch_agent_pid)"
    if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' "$pid"
      return 0
    fi
    /bin/sleep 0.2
  done
  stop_owned_launch_agent
  fail "The injector exited. See $INJECTOR_ERROR_LOG"
}

launch_workbuddy_with_cdp() {
  local port="$1"
  local pid=""
  local deadline=$((SECONDS + 15))
  : > "$APP_LOG"
  : > "$APP_ERROR_LOG"
  if [ -n "$(workbuddy_launch_agent_output)" ]; then
    workbuddy_launch_agent_is_owned \
      || fail "The launchd label $WORKBUDDY_LAUNCH_AGENT_LABEL is owned by another job."
    stop_owned_workbuddy_launch_agent \
      || fail "The previous owned WorkBuddy launch job could not be unloaded."
  fi
  run_node -e '
    const fs = require("node:fs");
    const [file, label, exe, port, home, stdout, stderr] = process.argv.slice(1);
    const escape = (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll(String.fromCharCode(39), "&apos;");
    const args = [exe, "--remote-debugging-address=127.0.0.1"];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escape(label)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escape(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>
    <key>WORKBUDDY_REMOTE_DEBUGGING_PORT</key><string>${escape(port)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${escape(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${escape(stdout)}</string>
  <key>StandardErrorPath</key><string>${escape(stderr)}</string>
</dict></plist>\n`;
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, xml, { mode: 0o600 });
    fs.renameSync(temporary, file);
  ' "$WORKBUDDY_LAUNCH_AGENT_PLIST" "$WORKBUDDY_LAUNCH_AGENT_LABEL" "$WORKBUDDY_EXE" "$port" "$HOME" "$APP_LOG" "$APP_ERROR_LOG"
  /usr/bin/plutil -lint "$WORKBUDDY_LAUNCH_AGENT_PLIST" >/dev/null \
    || fail "The generated WorkBuddy launch agent is invalid."
  /bin/launchctl bootstrap "$LAUNCH_AGENT_DOMAIN" "$WORKBUDDY_LAUNCH_AGENT_PLIST" \
    2>>"$APP_ERROR_LOG" \
    || fail "The owned WorkBuddy launch agent could not be loaded. See $APP_ERROR_LOG"
  /bin/launchctl kickstart "$WORKBUDDY_LAUNCH_AGENT_TARGET" >/dev/null 2>&1 || true
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(workbuddy_launch_agent_pid)"
    if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
      LAUNCHED_WORKBUDDY_PID="$pid"
      export LAUNCHED_WORKBUDDY_PID
      return 0
    fi
    /bin/sleep 0.2
  done
  stop_owned_workbuddy_launch_agent || true
  fail "The owned WorkBuddy process did not stay running. See $APP_ERROR_LOG"
}

launch_workbuddy_normally() {
  /usr/bin/open -na "$WORKBUDDY_BUNDLE"
}

clear_app_launch_logs() {
  [ ! -f "$APP_LOG" ] || : > "$APP_LOG"
  [ ! -f "$APP_ERROR_LOG" ] || : > "$APP_ERROR_LOG"
}
