#!/bin/bash

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PUBLIC_THEME_IDS=(
  neon-portal
  ember-glass
  paper-aurora
  sunlit-spark
  violet-rift
)

THEME_ID="${1:-}"
if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [theme-id]\n' "$0" >&2
  exit 1
fi

if [ -z "$THEME_ID" ]; then
  printf 'Available Trae skins:\n'
  for index in "${!PUBLIC_THEME_IDS[@]}"; do
    printf '  %s. %s\n' "$((index + 1))" "${PUBLIC_THEME_IDS[$index]}"
  done
  printf '\nChoose a number or enter a theme ID: '
  IFS= read -r selection || exit 1
  if [[ "$selection" =~ ^[0-9]+$ ]]; then
    [ "$selection" -ge 1 ] && [ "$selection" -le "${#PUBLIC_THEME_IDS[@]}" ] || {
      printf 'Theme selection is out of range.\n' >&2
      exit 1
    }
    THEME_ID="${PUBLIC_THEME_IDS[$((selection - 1))]}"
  else
    THEME_ID="$selection"
  fi
fi

PUBLIC_THEME="false"
for candidate in "${PUBLIC_THEME_IDS[@]}"; do
  [ "$candidate" != "$THEME_ID" ] || PUBLIC_THEME="true"
done
[ "$PUBLIC_THEME" = "true" ] || {
  printf 'Theme is not available in the public menu: %s\n' "$THEME_ID" >&2
  exit 1
}

exec /bin/bash "$SCRIPT_DIR/start-trae-skin-macos.sh" --theme "$THEME_ID"
