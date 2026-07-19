# Trae-Dream-Skin Tool API v1

## MCP Tools

| Tool | Main input | Result |
| --- | --- | --- |
| `inspect` | `{}` | Runtime, status, repository, registry, schema, safety flags |
| `theme_list` | `{}` | Theme summaries and revisions |
| `theme_read` | `{ "id": "violet-rift" }` | Raw and normalized theme, asset metadata, revision |
| `theme_write` | Write or rollback input | Transaction id and before/after revisions |
| `theme_validate` | Exactly one of `id` or `theme` | Normalized theme and warnings |
| `preview` | `id`, optional screenshot fields | Verification plus restored previous state |
| `apply` | `id` | Applied theme and current runtime status |
| `verify` | Optional screenshot fields | Renderer and layout verification |
| `restore` | `{}` | Native-state restoration and final status |

### Write Input

```json
{
  "operation": "write",
  "id": "violet-rift",
  "themePatch": {
    "states": { "tooltipBackground": "#19172F" },
    "appearance": { "surfaceOpacity": 0.56 }
  },
  "expectedRevision": "revision from theme_read",
  "dryRun": true
}
```

Set `imagePath` to a local PNG, JPEG, or WebP when replacing the background. New themes require an image. The tool validates size, extension, signature, and the complete staged theme before mutation.

Rollback:

```json
{
  "operation": "rollback",
  "transactionId": "transaction id from theme_write"
}
```

## JSON CLI

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

## Theme Fields

- Content: `name`, `description`, `layout`, `brandSubtitle`, `tagline`, `statusText`, `quote`, `image`
- Semantic colors: `background`, `panel`, `panelAlt`, `accent`, `accentAlt`, `secondary`, `highlight`, `onAccent`, `success`, `warning`, `danger`, `info`, `disabled`, `text`, `muted`, `line`, `selection`, `terminal`
- Interaction states: `surfaceHover`, `surfaceActive`, `focus`, `tooltipBackground`, `tooltipText`
- Appearance: treatment, background positioning/blending/opacity, surface/sidebar opacity, blur, saturation, radius, shadow, and color scheme

## Common Errors

- `REVISION_CONFLICT`: another write changed the theme; read and reconcile.
- `THEME_INVALID`: config or image validation failed.
- `THEME_NOT_FOUND`: requested id is absent.
- `REPOSITORY_BUSY`: another transaction owns the repository lock.
- `RUNTIME_COMMAND_FAILED`: platform runtime rejected or could not complete the operation.
- `PREVIEW_FAILED`: verification failed; previous state was restored.
- `PREVIEW_RESTORE_FAILED`: urgent; automatic restoration also failed.
- `UNSUPPORTED_PLATFORM`: runtime operations require macOS or Windows.
