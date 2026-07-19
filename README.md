# Trae-Dream-Skin

Trae-Dream-Skin is an unofficial Agent Tool and reversible skin runtime for
TRAE SOLO CN / TRAE Work CN. Codex, Trae, WorkBuddy, and a future standalone
user application can all use the same structured theme and lifecycle API. It
applies themes through the Chromium DevTools Protocol (CDP) on loopback,
covers the Work, Code and Design surfaces, and does not patch `app.asar` or
modify the installed application.

The implementation borrows the external injection approach from
[Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin).
See [NOTICE.md](NOTICE.md) for attribution and asset details.

## Agent Tool

Install the tool dependencies once:

```bash
npm install
```

The preferred agent interface is the stdio MCP server:

```bash
node ./src/mcp-server.mjs
```

The equivalent JSON CLI is available to every agent and to the future user
application:

```bash
npm run cli -- inspect
npm run cli -- theme list
npm run cli -- theme read violet-rift
npm run cli -- preview violet-rift --screenshot
npm run cli -- apply violet-rift
npm run cli -- verify
npm run cli -- restore
```

The API is frozen around nine operations: `inspect`, `theme_list`,
`theme_read`, `theme_write`, `theme_validate`, `preview`, `apply`, `verify`,
and `restore`. Agents write only structured theme data. The core stages and
validates every theme edit, checks revisions, commits atomically, keeps a
rollback backup, and does not accept raw CSS.

See [docs/agent-tool-v1.md](docs/agent-tool-v1.md) for the architecture and
[skills/trae-dream-skin/SKILL.md](skills/trae-dream-skin/SKILL.md) for the
agent workflow. The standalone user application is intentionally a separate
second phase and will call this same tool layer.

## Tested build

- macOS arm64
- `/Applications/TRAE SOLO CN.app`
- Bundle ID: `cn.trae.solo.app`
- TRAE version: `0.1.36`
- VS Code base: `1.107.1`
- Electron: `39.2.7`
- Main renderer: `solo/solo-lite.html`

## Included themes

- `neon-portal`: dark teal, lime and rose accents
- `ember-glass`: graphite, coral, gold and cyan
- `paper-aurora`: light paper surface with berry, teal and brass accents
- `sunlit-spark`: a bright full-bleed illustrated scene under translucent light UI
- `violet-rift`: a dark storm character scene under restrained glass UI

The first three presets use the same MIT-covered abstract demo artwork copied
from the source repository. `sunlit-spark` and `violet-rift` instead use two
original fictional-character scenes generated specifically for this project;
they are not source-repository gallery or identity-reference images. The tree
also contains `spark-atelier`, an earlier experimental styling variant that
uses the same artwork as `sunlit-spark`.

Exact per-file provenance and SHA-256 digests are recorded in
[NOTICE.md](NOTICE.md).

## macOS

Install the runtime once so Finder launchers continue to work even when
Terminal does not have access to the Documents folder:

```bash
./scripts/install-macos-runtime.sh
```

Start the default skin:

```bash
./scripts/start-trae-skin-macos.sh --theme neon-portal
```

Switch without restarting the debug-enabled Trae session:

```bash
./scripts/switch-theme-macos.sh ember-glass
./scripts/switch-theme-macos.sh paper-aurora
```

Verify and capture a renderer screenshot:

```bash
./scripts/verify-trae-skin-macos.sh --screenshot ./artifacts/verify.png
```

Fully turn the skin off:

```bash
./scripts/stop-trae-skin-macos.sh
```

The stop command removes injected styles, unloads both owned launchd jobs,
verifies the CDP port has closed, and relaunches Trae normally. It is
idempotent and will not close an unrelated normally launched Trae process. The
three `.command` files in the project root provide the same workflow through
Finder.

## Windows

Windows launchers live under `windows/` and use the same injector and theme
packs. Run them from a normal PowerShell session or use the `.cmd` entry
points. The Windows package is statically checked in this repository; it must
also be smoke-tested on an actual Windows installation before release.

```powershell
.\scripts\start-trae-skin-windows.ps1 -Theme neon-portal -RestartExisting
.\scripts\switch-theme-windows.ps1 -Theme paper-aurora
.\scripts\stop-trae-skin-windows.ps1
```

## Runtime model

```text
platform launcher
  -> start official Trae with a loopback-only CDP port
  -> on macOS, own that exact process through a per-user launchd job
  -> verify the listener belongs to that Trae process
  -> identify the solo-lite/workbench renderer by URL and DOM markers
  -> run a separate watcher and keep the theme installed across renderer reloads

stop/restore
  -> remove the injected runtime
  -> stop the owned watcher
  -> close only the recorded debug-enabled Trae process
  -> confirm the CDP endpoint is gone
  -> relaunch official Trae without debug flags
```

The injector runs with the Node runtime embedded in Trae by setting
`ELECTRON_RUN_AS_NODE=1`. The legacy Finder and PowerShell runtime does not
need npm dependencies; MCP and JSON CLI consumers run `npm install` once.

## Security

CDP can execute JavaScript in the Trae renderer. While a themed session is
active:

- keep the endpoint bound to `127.0.0.1`;
- do not run untrusted local software;
- do not expose the port through forwarding or proxies;
- use the stop command when the skin is not needed.

The launchers validate the application identity, process ownership and CDP
endpoint before injection. They refuse to attach to an existing CDP session
unless it matches a recorded skin-owned Trae process. On the tested macOS
build, a strict signing failure is accepted only when the executable and the
complete app bundle match pinned SHA-256 digests; any other unsigned or changed
build is rejected unless `TRAE_ALLOW_INVALID_SIGNATURE=1` is explicitly set.
Set `TRAE_REQUIRE_VALID_SIGNATURE=1` to reject even the pinned fallback.

## Development

```bash
npm test
npm run check
```

The injection runtime uses only Node built-ins. The Agent Tool additionally
uses the official MCP SDK and Zod. Theme packs contain `theme.json`, an image,
and optionally a legacy theme-specific `skin.css`; Agent Tool v1 preserves but
does not edit legacy CSS.
