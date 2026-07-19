# Trae-Dream-Skin Tool API v1

## DreamSkin Tool

The Agent receives one `dreamskin_theme` Tool. `action` is one of `inspect`,
`list`, `read`, `create`, `update`, or `validate`. Studio owns preview and all
runtime actions.

### Write Input

```json
{
  "action": "update",
  "themeId": "violet-rift",
  "themePatch": {
    "states": { "tooltipBackground": "#19172F" },
    "visual": { "motif": "prism", "iconTreatment": "tile", "ornament": "facets" },
    "appearance": { "surfaceOpacity": 0.56 }
  },
  "expectedRevision": "revision from action read",
  "dryRun": true
}
```

The Agent Tool never accepts arbitrary local paths. Studio imports reference
images and background assets into its managed asset store before a theme action
can refer to them.

## Host JSON CLI

Run from the Trae-Dream-Skin project root. Every command writes one JSON envelope to stdout and uses a nonzero exit code on error.

```bash
npm run cli -- inspect
npm run cli -- theme list
npm run cli -- theme read violet-rift
npm run cli -- theme write --input @change.json --dry-run
npm run cli -- theme validate violet-rift
npm run cli -- preview violet-rift --screenshot
npm run cli -- apply violet-rift
npm run cli -- verify --screenshot-path /absolute/path/verify.png
npm run cli -- restore
```

Use `--input -` to read JSON from stdin. Direct JSON text is also accepted.
These runtime commands are host/debugging operations and are not exposed to an
Agent session.

## Theme Fields

- Content: `name`, `description`, `layout`, `brandSubtitle`, `tagline`, `statusText`, `quote`, `image`
- Semantic colors: `background`, `panel`, `panelAlt`, `accent`, `accentAlt`, `secondary`, `highlight`, `onAccent`, `success`, `warning`, `danger`, `info`, `disabled`, `text`, `muted`, `line`, `selection`, `terminal`
- Interaction states: `surfaceHover`, `surfaceActive`, `focus`, `tooltipBackground`, `tooltipText`
- Visual recipes: `motif`, `iconTreatment`, `surfaceTreatment`, `accentPlacement`, `cardTreatment`, `ornament`
- Appearance: treatment, background positioning/blending/opacity, surface/sidebar opacity, blur, saturation, radius, shadow, and color scheme

`inspect.registry.components[*].visualSlots` describes the exact creative opportunities for each semantic component. For example, `sidebar.task` exposes `sectionDivider`, `rowIcon`, and `selectionMarker`, while `home.showcase` exposes `iconBadge`, `cornerLabel`, and `cta`. Select only the validated recipe enums from `themeSchema`; raw selectors and CSS are never accepted.

## Common Errors

- `REVISION_CONFLICT`: another write changed the theme; read and reconcile.
- `THEME_INVALID`: config or image validation failed.
- `THEME_NOT_FOUND`: requested id is absent.
- `REPOSITORY_BUSY`: another transaction owns the repository lock.
- `RUNTIME_COMMAND_FAILED`: platform runtime rejected or could not complete the operation.
- `PREVIEW_FAILED`: verification failed; previous state was restored.
- `PREVIEW_RESTORE_FAILED`: urgent; automatic restoration also failed.
- `UNSUPPORTED_PLATFORM`: runtime operations require macOS or Windows.
