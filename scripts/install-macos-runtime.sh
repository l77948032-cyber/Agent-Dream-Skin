#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
INSTALL_ROOT="${TRAE_DREAM_SKIN_RUNTIME:-$HOME/Library/Application Support/TraeDreamSkin/runtime}"

/bin/mkdir -p "$INSTALL_ROOT"
/usr/bin/ditto --noextattr --noqtn "$PROJECT_ROOT/scripts" "$INSTALL_ROOT/scripts"
/usr/bin/ditto --noextattr --noqtn "$PROJECT_ROOT/assets" "$INSTALL_ROOT/assets"
/usr/bin/ditto --noextattr --noqtn "$PROJECT_ROOT/themes" "$INSTALL_ROOT/themes"
/usr/bin/ditto --noextattr --noqtn "$PROJECT_ROOT/registry" "$INSTALL_ROOT/registry"
/usr/bin/ditto --noextattr --noqtn "$PROJECT_ROOT/src/core" "$INSTALL_ROOT/src/core"
/bin/chmod 700 "$INSTALL_ROOT"
/usr/bin/find "$INSTALL_ROOT/scripts" -type f -name '*.sh' -exec /bin/chmod 755 {} +

printf 'Trae Dream Skin runtime installed at %s\n' "$INSTALL_ROOT"
