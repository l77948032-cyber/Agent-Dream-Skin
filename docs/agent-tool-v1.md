# Trae-Dream-Skin Agent Tool v1

## Boundary

Trae-Dream-Skin is the single local tool layer used by coding agents and
DreamSkin Studio. It owns structured theme data, validation, semantic Trae
component mapping, the reversible injection runtime, and lifecycle
verification. Consumers do not reimplement those behaviors.

DreamSkin is a Tool product, not an MCP product. Its stable boundary is the
structured Tool contract and shared domain service. MCP is only a compatibility
adapter for agent hosts that cannot yet provide DreamSkin Tool through a native
tool callback.

Version 1 intentionally excludes the marketplace, cloud sync, embedded model,
and arbitrary CSS editing.

## Interfaces

Studio and in-process integrations call the shared service directly. The
universal and debugging adapter is the JSON CLI:

```bash
npm run cli -- inspect
```

Agent hosts expose one `dreamskin_theme` tool. Its structured `action` is one
of `inspect`, `list`, `read`, `create`, `update`, or `validate`. Runtime
operations are deliberately excluded from the Agent Tool and remain owned by
Studio. For hosts that currently require MCP, the project provides this stdio
compatibility adapter:

```bash
node ./src/mcp-server.mjs
```

Point an MCP client directly at Node so package-manager banners cannot corrupt
the stdio protocol. A generic compatibility entry is:

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

The default compatibility profile exposes only `dreamskin_theme`. Existing
integrations that still need the original nine-tool surface can run
`npm run mcp:legacy`; this profile is not used by Studio.

## Ownership

- `src/core/`: shared domain logic and platform orchestration
- `src/mcp-server.mjs`: thin MCP compatibility adapter
- `src/cli.mjs`: thin JSON CLI adapter
- `plugins/trae/`: self-contained Trae target entry, catalog, schema, component registry, and runtime mapping
- `skills/trae-dream-skin/`: thin agent workflow adapter
- `scripts/` and `assets/`: existing macOS/Windows runtime and renderer

## Transactions

`dreamskin_theme` actions `create` and `update` stage a complete theme beside the live repository, validate config and image content, check `expectedRevision`, and atomically replace the theme. Existing data is copied into the managed backup directory before commit. Host-only rollback validates the backup revision before restoring it and is idempotent.

No normal Agent Tool operation accepts raw CSS. Existing legacy `skin.css` files are preserved for compatibility but cannot be edited through v1.

The optional structured `visual` profile gives each theme its own component language. The renderer marks live Trae nodes with semantic component ids from the registry, then applies validated icon, surface, accent, card, motif, and ornament recipes. Studio loads the same registry, mapping, theme data, and runtime CSS instead of maintaining a second preview-only design.

Studio's host-only preview records the current runtime theme id and exact revision, holds the repository lock while it applies and verifies the requested theme, captures an optional screenshot, then restores that exact active revision or native Trae in `finally`. If the recorded runtime revision has diverged from the repository, preview fails before switching instead of restoring different content under the same theme id.

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

DreamSkin Tool operation error (including CLI and compatibility adapters):

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
