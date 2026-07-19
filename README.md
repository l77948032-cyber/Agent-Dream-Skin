# Agent Dream Skin / DreamSkin Studio

Agent Dream Skin 是一套本地主题工具与桌面 Studio。用户可以从主题中心添加模板、
新建空白主题，并在“我的主题”中通过本地 CLI Agent 对话修改主题，最后由 Studio
显式预览、验证或应用到目标应用。

当前随仓库交付的第一个目标插件是 **Trae DreamSkin**，适配 TRAE SOLO CN / TRAE
Work CN。运行时通过仅监听回环地址的 Chromium DevTools Protocol（CDP）注入样式，
不会修改 Trae 的 `app.asar`，也不会重签名已安装的 Trae。

> 产品边界：DreamSkin 是 **Tool + Plugin + Studio**，不是一个需要用户单独启动的
> MCP 服务。MCP 只保留为隐藏的 stdio 兼容传输。

## 当前状态

| 模块 | 当前状态 |
| --- | --- |
| DreamSkin Tool Core | 已实现结构化主题的 inspect/list/read/create/update/validate、乐观并发、原子写入与备份 |
| Trae Plugin | 已实现插件清单、六套模板、组件 registry、runtime mapping 与可逆 CDP runtime |
| DreamSkin Studio | 已实现主题中心、我的主题、空白新建、复制、删除、编辑、Agent 对话、预览、应用与恢复 |
| ACP | 已打通本地 Codex CLI；桌面包内置单文件 `codex-acp` 适配器，但不内置 Codex 二进制 |
| macOS 桌面 | Apple silicon / arm64 的 `.app` 已能构建；当前本地产物是 ad-hoc 签名，正式分发仍需要 Developer ID 与公证凭据 |
| Windows | Trae runtime 脚本有静态测试，Electron/NSIS 配置已预留；尚未在真实 Windows 机器完成桌面安装包验收 |

macOS Trae runtime 当前实机基线：

- `/Applications/TRAE SOLO CN.app`
- Bundle ID：`cn.trae.solo.app`
- Trae `0.1.36`
- VS Code base `1.107.1`
- Electron `39.2.7`
- 主 renderer：`solo/solo-lite.html`

这是一条已测试基线，不代表未来 Trae 版本无需重新验证。

## 快速开始

要求 Node.js `>= 22.12`（与 Electron 43 的构建工具链一致）。

```bash
npm install
npm --prefix studio install
npm run studio:dev
```

浏览器开发界面位于 `http://127.0.0.1:5173`，本地后端位于
`http://127.0.0.1:4242`。生产式单进程 Web 预览使用：

```bash
npm run studio:start
```

启动 Electron 开发版：

```bash
npm run desktop:dev
```

Studio 会扫描本机 CLI。正式桌面包只随包携带 `codex-acp` 适配器，Codex CLI 必须
已安装在本机；也可通过 `DREAMSKIN_CODEX_PATH` 明确指定可执行文件。

## Studio 工作流

1. 在“主题中心”查看内置模板。
2. 点击“添加到我的主题”，模板会被复制到用户主题库，内置模板保持只读。
3. 也可以在“我的主题”点击“新建空白主题”，从中性结构开始创作。
4. 打开主题后，左侧连接本地 Agent 并对话，右侧实时展示 Work、Code、Design、
   对话页和语义组件状态。
5. Agent 只能修改当前选中主题的结构化字段；应用、恢复和 runtime 验证始终由
   Studio 的显式操作触发。
6. 本地主题支持复制与带 revision 校验的删除；正在应用的主题必须先恢复或切换。

每次更新都携带 `expectedRevision`。如果主题在界面打开后被其他进程修改，Studio
会返回 `REVISION_CONFLICT`，不会覆盖较新的版本。

主题的本地 `id` 只标识“我的主题”中的具体实例。模板被添加或再次复制时会得到新的本地
`id`，但 `appearance.treatment` 会保留为稳定的视觉配方身份；Trae CSS 按 treatment
选择完整的组件细节，而不是按 catalog 或本地 theme id 选择。因此复制后的主题不会丢失
模板视觉语言，改名也不会改变配方。空白主题使用 `neutral` treatment，从无模板装饰的
中性界面开始。`appearance.backgroundOverlay` 和 `backgroundBlendMode` 也已进入
runtime mapping，Studio 预览与 Trae 注入使用同一组运行时变量。

## Tool 与兼容层

Agent 看到的是一个 `dreamskin_theme` Tool，包含六个 action：

- `inspect`
- `list`
- `read`
- `create`
- `update`
- `validate`

`preview`、`apply`、`verify`、`restore` 和事务回滚属于宿主能力，不暴露给 Agent。
调试或自动化可使用 JSON CLI：

```bash
npm run cli -- inspect
npm run cli -- theme list
npm run cli -- theme read violet-rift
npm run cli -- preview violet-rift --screenshot
npm run cli -- apply violet-rift
npm run cli -- verify
npm run cli -- restore
```

对仅支持 MCP 的 Agent host，仓库保留 stdio 兼容入口：

```bash
npm run mcp
```

默认仍只暴露一个 `dreamskin_theme`。旧的九工具协议仅供已有集成迁移：

```bash
npm run mcp:legacy
```

桌面 Studio 会在 ACP 会话内部按当前 plugin、theme 和 revision 启动这个 stdio 子进程；
它不监听网络端口，用户不需要配置或常驻一个 MCP server。

## 本地路径

Web Studio 默认路径：

- 用户主题：`~/.dreamskin/themes`
- Studio library：`~/.dreamskin/library.json`
- Studio 数据：`~/.dreamskin/data`

仓库内 JSON CLI / Tool 的默认主题是 `<repo>/themes`，事务数据是
`<repo>/.trae-dream-skin`；可通过 `TRAE_DREAM_SKIN_THEMES_ROOT` 和
`TRAE_DREAM_SKIN_TOOL_HOME` 覆盖。Studio 会把自己的用户主题根显式传给隐藏兼容子进程，
不会误写仓库模板。

Electron 使用 `app.getPath("userData")/dreamskin` 作为可写根。macOS 正式包通常是：

```text
~/Library/Application Support/DreamSkin Studio/dreamskin/
  themes/dreamskin.trae/
  state/dreamskin.trae/library.json
  state/dreamskin.trae/backups/
  runtime/dreamskin.trae/
  logs/
```

Trae 注入会话的进程状态独立保存在
`~/Library/Application Support/TraeDreamSkin`。打包内的只读资源位于
`DreamSkin Studio.app/Contents/Resources/dreamskin`。

## 桌面构建

构建经过校验的只读资源树：

```bash
npm run desktop:resources
```

生成 unpacked 应用：

```bash
npm run desktop:pack
npm run desktop:verify:packaged -- --skip-agent
```

生成 macOS arm64 DMG 与 ZIP：

```bash
npm run desktop:dist:mac
```

正式签名与公证使用：

```bash
npm run desktop:release:mac
```

最后一个命令要求本机或 CI 已配置 Developer ID Application 证书及 Apple 公证凭据；
没有这些凭据时，本地 ad-hoc 构建不能作为正式下载包发布。完整发布步骤见
[docs/release-checklist.md](docs/release-checklist.md)。

资源构建器不会复制整个 `node_modules` 或 `@openai/codex` 平台二进制。它只提取
自包含的 `codex-acp` 单文件适配器、Studio 静态文件、Trae 插件数据和最小 runtime，
并为全部必需文件生成 `resource-manifest.v1.json`。版本化 Trae runtime 另有
`runtime-manifest.v1.json`。正式包把资源清单视为 exact inventory：除清单、清单声明的
文件和必要父目录外，额外文件、symlink 或特殊节点都会使启动失败；资源清单版本、应用版本
或已安装 runtime 版本不一致时同样 fail closed。

## 内置主题

- `neon-portal`：深色青绿、荧光绿与玫红
- `ember-glass`：石墨、珊瑚、金色与青色
- `paper-aurora`：浅色纸面、莓红、青绿与黄铜
- `sunlit-spark`：明亮全幅插画与半透明浅色界面
- `violet-rift`：暗色风暴角色场景与克制玻璃材质
- `spark-atelier`：基于 Sunlit artwork 的实验性组件方案

素材来源、许可与 SHA-256 记录见 [NOTICE.md](NOTICE.md) 和
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 安全边界

- Electron renderer 开启 sandbox 与 context isolation，关闭 Node integration。
- 桌面 UI 使用 `dreamskin://studio`、严格 CSP、受限 IPC sender 和拒绝默认权限。
- 打包资源启动前按 SHA-256 与字节数校验，symlink 与路径穿越会被拒绝。
- Electron fuses 禁用 `NODE_OPTIONS`、Node inspector 和额外 file protocol 权限，
  并启用 ASAR integrity 与 only-load-from-ASAR。
- `RunAsNode` fuse 有意保留，用于受控启动 ACP/MCP 子进程；这是明确接受的执行面，
  由固定入口、固定参数、`shell: false`、关闭 `NODE_OPTIONS` 与关闭 inspector 共同约束。
- 主题 id 与资源路径不能逃出仓库，图片有大小和文件签名校验。
- Agent Tool 不接受任意 CSS、任意路径或 runtime apply。
- CDP 仅绑定 `127.0.0.1`，并校验 Trae 签名、PID、启动时间和 browser identity。

CDP 能在 Trae renderer 中执行 JavaScript。皮肤会话开启期间不要运行不可信本地软件，
不要转发 CDP 端口；不使用时通过 Studio 恢复，或运行平台 stop 脚本。

## 开发与验证

```bash
npm test
npm run check
npm run studio:build
```

连接真实 Codex CLI 的测试默认跳过，需要显式开启：

```bash
RUN_REAL_AGENT_E2E=1 node --test tests/real-agent-e2e.test.mjs
```

桌面发布还必须分别通过不连接 Agent 的打包态资源/UI/退出 smoke，以及包含真实本地 Codex
对话和 revision 更新的打包态验收：

```bash
npm run desktop:verify:packaged -- --skip-agent
npm run desktop:verify:packaged
```

详细分层与数据流见 [docs/architecture.md](docs/architecture.md)，Tool v1 契约见
[docs/agent-tool-v1.md](docs/agent-tool-v1.md)。

## 来源说明

外部注入思路参考了
[Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin)。
本项目是非官方工具，不代表 Trae、ByteDance、OpenAI 或相关产品方。
