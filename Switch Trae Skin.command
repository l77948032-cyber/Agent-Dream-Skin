#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
INSTALLED_ROOT="$HOME/Library/Application Support/TraeDreamSkin/runtime"
RUNTIME_ROOT="$ROOT"
[ ! -f "$INSTALLED_ROOT/scripts/switch-theme-macos.sh" ] || RUNTIME_ROOT="$INSTALLED_ROOT"

status=0
/bin/bash "$RUNTIME_ROOT/scripts/switch-theme-macos.sh" || status=$?
if [ "$status" -ne 0 ]; then
  printf '\nPress Return to close this window.\n'
  read -r _
fi
exit "$status"
