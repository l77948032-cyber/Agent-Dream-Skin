# DreamSkin Agent Tool v1

## Boundary

DreamSkin Agent Tool is the single local tool layer used by coding agents and
DreamSkin Studio. It owns structured theme data, validation, target-specific
semantic component mapping, reversible injection runtimes, and lifecycle
verification. Consumers do not reimplement those behaviors. The current
first-party targets are `dreamskin.trae` and `dreamskin.workbuddy`.

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
Studio. `pluginId` selects the target; standalone compatibility calls default
to `dreamskin.trae`, while Studio supplies and locks the selected target.
For hosts that currently require MCP, the project provides this stdio
compatibility adapter:

```bash
node ./src/mcp-server.mjs
```

Point an MCP client directly at Node so package-manager banners cannot corrupt
the stdio protocol. A generic compatibility entry is:

```json
{
  "mcpServers": {
    "dreamskin-tool": {
      "command": "node",
      "args": ["/absolute/path/to/Agent-Dream-Skin/src/mcp-server.mjs"],
      "cwd": "/absolute/path/to/Agent-Dream-Skin"
    }
  }
}
```

The default compatibility profile exposes only `dreamskin_theme`. Studio starts
it as a short-lived stdio child with target-specific plugin, theme, data,
backup, and revision scope; it is not a network server. Existing integrations
that still need the original Trae nine-tool surface can run `npm run mcp:legacy`;
this profile is not used by Studio.

## Ownership

- `src/core/`: shared domain logic and platform orchestration
- `src/mcp-server.mjs`: thin MCP compatibility adapter
- `src/cli.mjs`: thin JSON CLI adapter
- `plugins/trae/`: self-contained Trae target entry, catalog, schema, component registry, and runtime mapping
- `plugins/workbuddy/`: self-contained WorkBuddy target entry, three templates, 32-component registry, eight-scene coverage, and runtime mapping
- `skills/trae-dream-skin/`: thin agent workflow adapter
- `scripts/` and `assets/`: target runtime scripts and renderer injectors

## Transactions

`dreamskin_theme` actions `create` and `update` stage a complete theme beside the selected plugin's live repository, validate config and image content, check `expectedRevision`, and atomically replace the theme. Existing data is copied into that plugin's managed backup directory before commit. Host-only rollback validates the backup revision before restoring it and is idempotent. Trae and WorkBuddy use separate theme, data, lock, and backup roots.

No normal Agent Tool operation accepts raw CSS. Existing legacy `skin.css` files are preserved for compatibility but cannot be edited through v1.

The optional structured `visual` profile gives each theme its own component language. Each target renderer marks live nodes with semantic component ids from that plugin's registry, then applies validated icon, surface, accent, card, motif, and ornament recipes. Studio loads the same registry, mapping, theme data, and runtime CSS instead of maintaining a second preview-only design. Trae currently exposes 20 semantic components; WorkBuddy exposes 32 components across eight canonical scenes.

Studio's host-only preview records the selected plugin's current runtime theme id and exact revision, holds that repository's lock while it applies and verifies the requested theme, captures an optional screenshot, then restores that exact active revision or the target's native UI in `finally`. If the recorded runtime revision has diverged from the repository, preview fails before switching instead of restoring different content under the same theme id.

## Safety

- CDP is loopback-only and tied to a verified target process identity.
- Loopback is not authentication: other processes on the same machine can try to access an open CDP port.
- Official Trae and WorkBuddy app bundles are never patched or re-signed.
- Theme ids and asset paths cannot escape the theme directory.
- Images are size-limited and signature-checked.
- Structured colors reject executable CSS values.
- Runtime commands use fixed executable paths and argument arrays, not shell command strings.
- `restore` is idempotent and closes only the recorded owned session.
- A successful restore closes the owned CDP listener.

On macOS, an applied WorkBuddy skin is maintained by DreamSkin-owned user
`launchd` jobs and therefore remains active when Studio exits. This is session
persistence, not automatic app resurrection. If WorkBuddy itself exits or an
owned job/CDP identity check fails, status becomes `degraded`; re-applying
validates and safely rebuilds the session.

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
