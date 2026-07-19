# Trae-Dream-Skin Agent Tool v1

## Boundary

Trae-Dream-Skin is the single local tool layer used by coding agents now and by a standalone user application later. It owns structured theme data, validation, semantic Trae component mapping, the reversible injection runtime, and lifecycle verification. Consumers do not reimplement those behaviors.

Version 1 intentionally excludes the standalone application, marketplace, cloud sync, embedded model, and arbitrary CSS editing.

## Interfaces

The primary agent interface is the stdio MCP server:

```bash
node ./src/mcp-server.mjs
```

Point an MCP client directly at Node so package-manager banners cannot corrupt
the stdio protocol. A generic client entry is:

```json
{
  "mcpServers": {
    "trae-dream-skin": {
      "command": "node",
      "args": ["/absolute/path/to/Trae-Dream-Skin/src/mcp-server.mjs"],
      "cwd": "/absolute/path/to/Trae-Dream-Skin"
    }
  }
}
```

The universal and debugging interface is the JSON CLI:

```bash
npm run cli -- inspect
```

Both expose the same nine operations: `inspect`, `theme_list`, `theme_read`, `theme_write`, `theme_validate`, `preview`, `apply`, `verify`, and `restore`.

## Ownership

- `src/core/`: shared domain logic and platform orchestration
- `src/mcp-server.mjs`: thin MCP adapter
- `src/cli.mjs`: thin JSON CLI adapter
- `schemas/theme-v1.schema.json`: public structured theme contract
- `registry/components.v1.json`: semantic components mapped to internal Trae selectors
- `skills/trae-dream-skin/`: thin agent workflow adapter
- `scripts/` and `assets/`: existing macOS/Windows runtime and renderer

## Transactions

`theme_write` stages a complete theme beside the live repository, validates config and image content, checks `expectedRevision`, and atomically replaces the theme. Existing data is copied into `.trae-dream-skin/backups/<transactionId>/` before commit. Rollback validates the backup revision before restoring it and is idempotent.

No normal Agent Tool operation accepts raw CSS. Existing legacy `skin.css` files are preserved for compatibility but cannot be edited through v1.

`preview` snapshots the current runtime state, applies and verifies the requested theme, captures an optional screenshot, then restores the previous active theme or native Trae in `finally`.

## Safety

- CDP is loopback-only and tied to a verified Trae process identity.
- The official Trae app bundle is never patched or re-signed.
- Theme ids and asset paths cannot escape the theme directory.
- Images are size-limited and signature-checked.
- Structured colors reject executable CSS values.
- Runtime commands use fixed executable paths and argument arrays, not shell command strings.
- `restore` is idempotent and closes only the recorded owned session.

## Result Envelope

CLI success:

```json
{ "ok": true, "result": {} }
```

CLI or MCP operation error:

```json
{
  "ok": false,
  "error": {
    "code": "STABLE_ERROR_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```
