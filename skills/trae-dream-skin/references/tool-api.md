# DreamSkin CLI Contract v1

## Commands

Every theme command requires an explicit target plugin returned by
`dreamskin targets`.

```bash
dreamskin targets
dreamskin theme inspect --plugin dreamskin.trae
dreamskin theme list --plugin dreamskin.trae
dreamskin theme read violet-rift --plugin dreamskin.trae
dreamskin theme create my-theme --plugin dreamskin.trae --source paper-aurora --input @theme-patch.json --dry-run
dreamskin theme update violet-rift --plugin dreamskin.trae --expected-revision <sha256> --input @theme-patch.json --dry-run
dreamskin theme asset import violet-rift --plugin dreamskin.trae --expected-revision <sha256> --file /absolute/path/background.png --dry-run
dreamskin theme validate violet-rift --plugin dreamskin.trae
dreamskin theme validate --plugin dreamskin.trae --input @complete-theme.json
```

`--input` accepts a JSON object as literal text, `@file` input, or `-` for
stdin. Input is limited to 1 MiB. Create and update input is a structured theme
patch; validate input is a complete structured theme. Unknown, duplicate,
extra, and action-inapplicable arguments are rejected.

Omit `--source` (or pass `--source blank`) to create a blank theme. A real
catalog source deep-inherits the complete template before applying the input
patch, and its source metadata persists independently of the new theme id.

## Envelope

The CLI writes exactly one JSON document to stdout and exits with `0` on
success or `1` on failure.

```json
{
  "protocolVersion": 1,
  "ok": true,
  "operation": "theme.update",
  "scope": {
    "pluginId": "dreamskin.trae",
    "themeId": "violet-rift"
  },
  "result": {}
}
```

Failures replace `result` with a stable `error` object containing `code`,
`message`, and optional `details`. Error envelopes do not expose a stack or
nested cause.

## Write Input

```json
{
  "states": { "tooltipBackground": "#19172F" },
  "visual": { "motif": "prism", "iconTreatment": "tile", "ornament": "facets" },
  "appearance": { "surfaceOpacity": 0.56 }
}
```

Always dry-run before committing an update. A committed update must use the
revision returned by the latest read or list operation. The CLI never accepts
CSS, selectors, shell commands, runtime actions, or general-purpose file reads.
`theme asset import` is the only asset-path command: it accepts a regular
PNG/JPEG/WebP file up to 16 MiB, rejects symlinks, verifies its signature, and
copies the bytes into the managed theme directory.

## Theme Fields

- Content: `name`, `description`, `layout`, `brandSubtitle`, `tagline`, `statusText`, `quote`. Background `image` is managed by `theme asset import`.
- Semantic colors: `background`, `panel`, `panelAlt`, `accent`, `accentAlt`, `secondary`, `highlight`, `onAccent`, `success`, `warning`, `danger`, `info`, `disabled`, `text`, `muted`, `line`, `selection`, `terminal`
- Interaction states: `surfaceHover`, `surfaceActive`, `focus`, `tooltipBackground`, `tooltipText`
- Visual recipes: `motif`, `iconTreatment`, `surfaceTreatment`, `accentPlacement`, `cardTreatment`, `ornament`
- Appearance: treatment, background positioning/blending/opacity, surface/sidebar opacity, blur, saturation, radius, shadow, and color scheme

`inspect` describes each component's semantic visual slots and the exact enum
values accepted by the theme schema.

## Common Errors

- `REVISION_CONFLICT`: another write changed the theme; read and reconcile.
- `THEME_INVALID`: structured theme validation failed.
- `THEME_NOT_FOUND`: the requested id is absent.
- `THEME_ALREADY_EXISTS`: create selected an existing id.
- `REPOSITORY_BUSY`: another transaction owns the repository lock.
- `INPUT_TOO_LARGE`: input exceeds 1 MiB.
- `INPUT_FILE_UNAVAILABLE`: an `@file` input is missing, is not a regular file, or cannot be read.
- `ASSET_NOT_FOUND`: the requested background file is missing.
- `INVALID_ASSET_PATH`: the background is a symlink, directory, or otherwise unsafe path.
- `INVALID_IMAGE`: the extension or file signature is not a supported image.
- `ASSET_TOO_LARGE`: the background exceeds 16 MiB.
- `INVALID_ARGUMENT`: the command or its arguments violate the CLI contract.
