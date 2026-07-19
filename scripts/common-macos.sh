#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
INJECTOR="$SCRIPT_DIR/injector.mjs"
THEMES_ROOT="$PROJECT_ROOT/themes"
DEFAULT_THEME_ID="neon-portal"
DEFAULT_PORT="9342"
SKIN_VERSION="0.1.0"

STATE_ROOT="${TRAE_DREAM_SKIN_HOME:-$HOME/Library/Application Support/TraeDreamSkin}"
STATE_PATH="$STATE_ROOT/state.json"
INJECTOR_LOG="$STATE_ROOT/injector.log"
INJECTOR_ERROR_LOG="$STATE_ROOT/injector-error.log"
APP_LOG="$STATE_ROOT/trae-launch.log"
APP_ERROR_LOG="$STATE_ROOT/trae-launch-error.log"
LAUNCH_AGENT_LABEL="${TRAE_DREAM_SKIN_LAUNCH_LABEL:-local.trae-dream-skin.injector}"
LAUNCH_AGENT_PLIST="$STATE_ROOT/injector-launch-agent.plist"
LAUNCH_AGENT_DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCH_AGENT_TARGET="$LAUNCH_AGENT_DOMAIN/$LAUNCH_AGENT_LABEL"
TRAE_LAUNCH_AGENT_LABEL="local.trae-dream-skin.trae"
TRAE_LAUNCH_AGENT_PLIST="$STATE_ROOT/trae-launch-agent.plist"
TRAE_LAUNCH_AGENT_TARGET="$LAUNCH_AGENT_DOMAIN/$TRAE_LAUNCH_AGENT_LABEL"
OPERATION_LOCK_DIR="$STATE_ROOT/operation.lock"
OPERATION_LOCK_OWNER="$OPERATION_LOCK_DIR/owner"
OPERATION_LOCK_HELD="false"

EXPECTED_TRAE_TEAM_ID="${TRAE_EXPECTED_TEAM_ID:-CG2SCM6AV5}"
SUPPORTED_TRAE_BUNDLE_IDS="cn.trae.solo.app"
KNOWN_TRAE_0_1_36_EXECUTABLE_SHA256="8407be5ebf6dc889fd48665a54321f4f313243a26108e8910737f56b674014fd"
KNOWN_TRAE_0_1_36_BUNDLE_SHA256="5a7495d76dd36fb2e66de511c49d917aee81ca79e6bd8fc725596eb0656676f6"

fail() {
  printf 'Trae Dream Skin: %s\n' "$*" >&2
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
  for allowed in $SUPPORTED_TRAE_BUNDLE_IDS; do
    [ "$identifier" = "$allowed" ] && return 0
  done
  return 1
}

discover_trae_app() {
  local candidate=""
  local identifier=""
  local configured="${TRAE_APP_BUNDLE:-}"

  for candidate in \
    "$configured" \
    "/Applications/TRAE SOLO CN.app" \
    "/Applications/Trae.app" \
    "$HOME/Applications/TRAE SOLO CN.app" \
    "$HOME/Applications/Trae.app"
  do
    [ -n "$candidate" ] || continue
    [ -f "$candidate/Contents/Info.plist" ] || continue
    identifier="$(plist_value "$candidate" CFBundleIdentifier)"
    if is_supported_bundle_id "$identifier"; then
      TRAE_BUNDLE="$candidate"
      TRAE_BUNDLE_ID="$identifier"
      break
    fi
  done

  if [ -z "${TRAE_BUNDLE:-}" ]; then
    candidate="$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "cn.trae.solo.app"' 2>/dev/null | /usr/bin/head -n 1)"
    if [ -n "$candidate" ] && [ -f "$candidate/Contents/Info.plist" ]; then
      identifier="$(plist_value "$candidate" CFBundleIdentifier)"
      if is_supported_bundle_id "$identifier"; then
        TRAE_BUNDLE="$candidate"
        TRAE_BUNDLE_ID="$identifier"
      fi
    fi
  fi

  [ -n "${TRAE_BUNDLE:-}" ] || fail "Could not find the supported TRAE SOLO CN app."
  TRAE_EXECUTABLE_NAME="$(plist_value "$TRAE_BUNDLE" CFBundleExecutable)"
  TRAE_EXE="$TRAE_BUNDLE/Contents/MacOS/$TRAE_EXECUTABLE_NAME"
  TRAE_VERSION="$(plist_value "$TRAE_BUNDLE" CFBundleShortVersionString)"
  [ -x "$TRAE_EXE" ] || fail "Trae executable is missing: $TRAE_EXE"
  export TRAE_BUNDLE TRAE_BUNDLE_ID TRAE_EXE TRAE_VERSION
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
    ELECTRON_RUN_AS_NODE=1 "$TRAE_EXE" "$@"
}

require_trae_runtime() {
  [ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "This launcher requires macOS."
  [ -n "${TRAE_BUNDLE:-}" ] || fail "Discover Trae before validating its runtime."
  TRAE_TEAM_ID="$(codesign_team_id "$TRAE_BUNDLE")"
  [ "$TRAE_TEAM_ID" = "$EXPECTED_TRAE_TEAM_ID" ] \
    || fail "Unexpected Trae signing team: ${TRAE_TEAM_ID:-missing}."
  if ! /usr/bin/codesign --verify --deep --strict "$TRAE_BUNDLE" >/dev/null 2>&1; then
    if [ "${TRAE_REQUIRE_VALID_SIGNATURE:-0}" = "1" ]; then
      fail "Trae's code signature is invalid. Reinstall the official app before continuing."
    fi
    TRAE_EXECUTABLE_SHA256="$(sha256_file "$TRAE_EXE")"
    TRAE_BUNDLE_SHA256="$(sha256_bundle_tree "$TRAE_BUNDLE")"
    if [ "$TRAE_VERSION" = "0.1.36" ] && \
      [ "$TRAE_EXECUTABLE_SHA256" = "$KNOWN_TRAE_0_1_36_EXECUTABLE_SHA256" ] && \
      [ "$TRAE_BUNDLE_SHA256" = "$KNOWN_TRAE_0_1_36_BUNDLE_SHA256" ]; then
      printf 'Trae Dream Skin: warning: strict signing verification failed, but the complete app bundle, executable, bundle id, and Team ID match the pinned tested Trae 0.1.36 build.\n' >&2
    elif [ "${TRAE_ALLOW_INVALID_SIGNATURE:-0}" = "1" ]; then
      printf 'Trae Dream Skin: warning: continuing with an unverified Trae binary because TRAE_ALLOW_INVALID_SIGNATURE=1.\n' >&2
    else
      fail "Trae's signature is invalid and this executable is not the pinned tested build. Reinstall Trae or explicitly set TRAE_ALLOW_INVALID_SIGNATURE=1."
    fi
  fi
  NODE_VERSION="$(run_node --version 2>/dev/null || true)"
  case "$NODE_VERSION" in v2[0-9].*|v[3-9][0-9].*) ;; *) fail "Trae's embedded Node runtime is unsupported: ${NODE_VERSION:-missing}." ;; esac
  export TRAE_TEAM_ID NODE_VERSION
}

trae_main_pids() {
  local pid=""
  local command_line=""
  while read -r pid command_line; do
    [ -n "$pid" ] || continue
    case "$command_line" in
      "$TRAE_EXE"|"$TRAE_EXE --"*) printf '%s\n' "$pid" ;;
    esac
  done < <(/bin/ps -axo pid=,command= 2>/dev/null || true)
}

pid_is_trae_main() {
  local pid="$1"
  local command_line=""
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in "$TRAE_EXE"|"$TRAE_EXE --"*) return 0 ;; esac
  return 1
}

process_identity_matches() {
  local pid="$1"
  local expected_start="$2"
  pid_is_trae_main "$pid" || return 1
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

stop_recorded_trae_process() {
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

trae_is_running() {
  [ -n "$(trae_main_pids)" ]
}

process_started_at() {
  LC_ALL=C /bin/ps -p "$1" -o lstart= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

stop_trae() {
  local allow_force="${1:-false}"
  local deadline=$((SECONDS + 15))
  local pid=""

  trae_is_running || return 0
  /usr/bin/osascript -e "tell application id \"$TRAE_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  while trae_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.25; done
  trae_is_running || return 0

  [ "$allow_force" = "true" ] || fail "Trae did not close within 15 seconds."
  while IFS= read -r pid; do
    [ -n "$pid" ] && /bin/kill -TERM "$pid" 2>/dev/null || true
  done < <(trae_main_pids)
  deadline=$((SECONDS + 5))
  while trae_is_running && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.25; done
  trae_is_running && fail "Trae could not be stopped safely."
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

pid_is_trae_descendant() {
  trae_main_ancestor_pid "$1" >/dev/null
}

trae_main_ancestor_pid() {
  local current="$1"
  local parent=""
  local command_line=""
  local depth=0
  while [ "$current" -gt 1 ] 2>/dev/null && [ "$depth" -lt 32 ]; do
    command_line="$(/bin/ps -p "$current" -o command= 2>/dev/null || true)"
    case "$command_line" in
      "$TRAE_EXE"|"$TRAE_EXE --"*) printf '%s\n' "$current"; return 0 ;;
    esac
    parent="$(/bin/ps -p "$current" -o ppid= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')"
    case "$parent" in ''|*[!0-9]*) return 1 ;; esac
    [ "$parent" -ne "$current" ] || return 1
    current="$parent"
    depth=$((depth + 1))
  done
  return 1
}

trae_main_pid_for_listener() {
  local port="$1"
  local listener_pid=""
  local main_pid=""
  local resolved_pid=""
  while IFS= read -r listener_pid; do
    [ -n "$listener_pid" ] || continue
    main_pid="$(trae_main_ancestor_pid "$listener_pid")" || return 1
    if [ -n "$resolved_pid" ] && [ "$resolved_pid" != "$main_pid" ]; then
      return 1
    fi
    resolved_pid="$main_pid"
  done < <(listener_pids "$port")
  [ -n "$resolved_pid" ] || return 1
  printf '%s\n' "$resolved_pid"
}

port_belongs_to_trae() {
  local pid=""
  local found="false"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    pid_is_trae_descendant "$pid" || return 1
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
  cdp_http_ready "$1" && port_belongs_to_trae "$1" && port_listens_on_loopback_only "$1"
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
  run_node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$STATE_PATH" "$key"
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
  local trae_pid="$4"
  local trae_started_at="$5"
  local browser_id="$6"
  local owns_session="$7"
  local started_cdp_here="$8"
  run_node -e '
    const fs = require("node:fs");
    const [file, version, port, browserId, pid, startedAt, injector, nodeVersion, bundle, exe, appVersion, teamId, root, themeId, themeDir, appPid, appStartedAt, ownsSession, startedCdpHere, arch, launchLabel, launchPlist, appLaunchLabel, appLaunchPlist] = process.argv.slice(1);
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
      traeBundle: bundle,
      traeExe: exe,
      traeVersion: appVersion,
      traeTeamId: teamId,
      traePid: Number(appPid || 0),
      traeStartedAt: appStartedAt,
      projectRoot: root,
      themeId,
      themeDir,
      launchAgentLabel: launchLabel,
      launchAgentPlist: launchPlist,
      appLaunchAgentLabel: appLaunchLabel,
      appLaunchAgentPlist: appLaunchPlist,
      createdAt: new Date().toISOString()
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  ' "$STATE_PATH" "$SKIN_VERSION" "$port" "$browser_id" "$injector_pid" "$injector_started_at" "$INJECTOR" "$NODE_VERSION" "$TRAE_BUNDLE" "$TRAE_EXE" "$TRAE_VERSION" "$TRAE_TEAM_ID" "$PROJECT_ROOT" "$THEME_ID" "$THEME_DIR" "$trae_pid" "$trae_started_at" "$owns_session" "$started_cdp_here" "$(/usr/bin/uname -m)" "$LAUNCH_AGENT_LABEL" "$LAUNCH_AGENT_PLIST" "$TRAE_LAUNCH_AGENT_LABEL" "$TRAE_LAUNCH_AGENT_PLIST"
}

trae_launch_agent_output() {
  /bin/launchctl print "$TRAE_LAUNCH_AGENT_TARGET" 2>/dev/null || true
}

trae_launch_agent_pid() {
  trae_launch_agent_output \
    | /usr/bin/awk '$1 == "pid" && $2 == "=" { pid = $3 } END { if (pid) print pid }'
}

trae_launch_agent_port() {
  trae_launch_agent_output \
    | /usr/bin/sed -n 's/.*--remote-debugging-port=\([0-9][0-9]*\).*/\1/p' \
    | /usr/bin/head -n 1
}

trae_launch_agent_is_owned() {
  local output=""
  output="$(trae_launch_agent_output)"
  [ -n "$output" ] || return 1
  case "$output" in
    *"path = $TRAE_LAUNCH_AGENT_PLIST"*"program = $TRAE_EXE"*) return 0 ;;
  esac
  return 1
}

stop_owned_trae_launch_agent() {
  local pid=""
  trae_launch_agent_is_owned || return 0
  pid="$(trae_launch_agent_pid)"
  /bin/launchctl bootout "$TRAE_LAUNCH_AGENT_TARGET" >/dev/null 2>&1 || return 1
  if [ -n "$pid" ]; then
    local deadline=$((SECONDS + 15))
    while /bin/kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
      /bin/sleep 0.2
    done
  fi
  [ -z "$(trae_launch_agent_output)" ] && { [ -z "$pid" ] || ! /bin/kill -0 "$pid" 2>/dev/null; }
}

launch_agent_output() {
  /bin/launchctl print "$LAUNCH_AGENT_TARGET" 2>/dev/null || true
}

launch_agent_pid() {
  launch_agent_output | /usr/bin/awk '$1 == "pid" && $2 == "=" { pid = $3 } END { if (pid) print pid }'
}

launch_agent_is_owned() {
  local output=""
  output="$(launch_agent_output)"
  [ -n "$output" ] || return 1
  case "$output" in
    *"path = $LAUNCH_AGENT_PLIST"*) return 0 ;;
    *"program = $TRAE_EXE"*"$INJECTOR"*) return 0 ;;
  esac
  return 1
}

stop_owned_launch_agent() {
  local pid=""
  launch_agent_is_owned || return 0
  pid="$(launch_agent_pid)"
  /bin/launchctl bootout "$LAUNCH_AGENT_TARGET" >/dev/null 2>&1 || return 1
  if [ -n "$pid" ]; then
    local deadline=$((SECONDS + 6))
    while /bin/kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.2; done
  fi
  [ -z "$(launch_agent_output)" ] && { [ -z "$pid" ] || ! /bin/kill -0 "$pid" 2>/dev/null; }
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
    const [file, label, exe, injector, port, browserId, themeDir, root, stdout, stderr] = process.argv.slice(1);
    const escape = (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll(String.fromCharCode(39), "&apos;");
    const args = [exe, injector, "--watch", "--port", port, "--browser-id", browserId, "--theme-dir", themeDir];
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
  ' "$LAUNCH_AGENT_PLIST" "$LAUNCH_AGENT_LABEL" "$TRAE_EXE" "$INJECTOR" "$port" "$browser_id" "$THEME_DIR" "$PROJECT_ROOT" "$INJECTOR_LOG" "$INJECTOR_ERROR_LOG"
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

launch_trae_with_cdp() {
  local port="$1"
  local pid=""
  local deadline=$((SECONDS + 15))
  : > "$APP_LOG"
  : > "$APP_ERROR_LOG"
  if [ -n "$(trae_launch_agent_output)" ]; then
    trae_launch_agent_is_owned \
      || fail "The launchd label $TRAE_LAUNCH_AGENT_LABEL is owned by another job."
    stop_owned_trae_launch_agent \
      || fail "The previous owned Trae launch job could not be unloaded."
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
    const args = [exe, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escape(label)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escape(arg)}</string>`).join("")}</array>
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
  ' "$TRAE_LAUNCH_AGENT_PLIST" "$TRAE_LAUNCH_AGENT_LABEL" "$TRAE_EXE" "$port" "$HOME" "$APP_LOG" "$APP_ERROR_LOG"
  /usr/bin/plutil -lint "$TRAE_LAUNCH_AGENT_PLIST" >/dev/null \
    || fail "The generated Trae launch agent is invalid."
  /bin/launchctl bootstrap "$LAUNCH_AGENT_DOMAIN" "$TRAE_LAUNCH_AGENT_PLIST" \
    2>>"$APP_ERROR_LOG" \
    || fail "The owned Trae launch agent could not be loaded. See $APP_ERROR_LOG"
  /bin/launchctl kickstart "$TRAE_LAUNCH_AGENT_TARGET" >/dev/null 2>&1 || true
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(trae_launch_agent_pid)"
    if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
      LAUNCHED_TRAE_PID="$pid"
      export LAUNCHED_TRAE_PID
      return 0
    fi
    /bin/sleep 0.2
  done
  stop_owned_trae_launch_agent || true
  fail "The owned Trae process did not stay running. See $APP_ERROR_LOG"
}

launch_trae_normally() {
  /usr/bin/open -na "$TRAE_BUNDLE"
}

clear_app_launch_logs() {
  [ ! -f "$APP_LOG" ] || : > "$APP_LOG"
  [ ! -f "$APP_ERROR_LOG" ] || : > "$APP_ERROR_LOG"
}
