# Agent Dream Skin / DreamSkin Studio

Agent Dream Skin 是一套本地主题工具与桌面 Studio。用户可以从主题中心添加模板、
新建空白主题，并在“我的主题”中通过本地 CLI Agent 对话修改主题，最后由 Studio
显式预览、验证或应用到目标应用。

当前随仓库交付两个第一方目标插件：**Trae DreamSkin**（TRAE SOLO CN / TRAE Work CN）
与 **WorkBuddy DreamSkin**（macOS WorkBuddy）。两者复用同一套结构化 Tool Core，但各自
拥有 schema、组件 registry、模板 catalog、runtime mapping 和应用运行时。皮肤通过仅监听
回环地址的 Chromium DevTools Protocol（CDP）注入，不修改目标应用的 `app.asar`，也不
重签名已安装应用。

> 产品边界：DreamSkin 是 **Tool + Plugin + Studio**，不是一个需要用户单独启动的
> MCP 服务。MCP 只保留为隐藏的 stdio 兼容传输。

## 当前状态

| 模块 | 当前状态 |
| --- | --- |
| DreamSkin Tool Core | 已实现结构化主题的 inspect/list/read/create/update/validate、乐观并发、原子写入与备份 |
| Trae Plugin | 已实现六套模板、20 个语义组件、runtime mapping 与可逆 CDP runtime |
| WorkBuddy Plugin | 已实现三套模板、32 个语义组件、8 个完整场景与 macOS 可逆 CDP runtime |
| DreamSkin Studio | 已实现双目标主题中心、我的主题、空白新建、复制、删除、编辑、Agent 对话、场景预览、应用与恢复 |
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

macOS WorkBuddy runtime 当前实机基线：

- `/Applications/WorkBuddy.app`
- Bundle ID：`com.workbuddy.workbuddy`
- Team ID：`FN2V63AD2J`
- WorkBuddy `5.2.6`
- selector profile `5.2`

三套 WorkBuddy 模板已在该版本完成真实首页、对话页的注入与验证，并验证恢复清理。未来
WorkBuddy 版本、签名、renderer 或 DOM 结构变化时仍需重新执行完整验收。

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
4. 打开主题后，左侧连接本地 Agent 并对话，右侧按所选目标展示完整界面和语义组件状态。
   Trae 覆盖 Work、Code、Design、对话页与 20 个组件；WorkBuddy 覆盖首页、对话、
   结果与产物、专家与技能、自动化、项目与空间、设置、浮层与状态共 8 个场景和 32 个组件。
5. Agent 只能修改当前选中主题的结构化字段；应用、恢复和 runtime 验证始终由
   Studio 的显式操作触发。
6. 本地主题支持复制与带 revision 校验的删除；正在应用的主题必须先恢复或切换。

每次更新都携带 `expectedRevision`。如果主题在界面打开后被其他进程修改，Studio
会返回 `REVISION_CONFLICT`，不会覆盖较新的版本。

主题的本地 `id` 只标识“我的主题”中的具体实例。模板被添加或再次复制时会得到新的本地
`id`，但 `appearance.treatment` 会保留为稳定的视觉配方身份；目标插件的 CSS 按
treatment 选择完整组件细节，而不是按 catalog 或本地 theme id 选择。因此复制后的主题
不会丢失模板视觉语言，改名也不会改变配方。空白主题使用 `neutral` treatment，从无模板
装饰的中性界面开始。`appearance.backgroundOverlay` 和 `backgroundBlendMode` 也已进入
各目标的 runtime mapping，Studio 预览与真实注入使用同一份结构化主题。

## WorkBuddy 会话行为

WorkBuddy 主题应用成功后，目标应用和持久注入 watcher 由 DreamSkin 自己的用户级
`launchd` job 托管，状态与 Studio 进程分离。因此关闭 DreamSkin Studio 不会主动恢复
WorkBuddy，已经应用的皮肤会在当前 WorkBuddy 会话中继续生效。

这不代表 WorkBuddy 被自动保活。用户退出 WorkBuddy、目标进程身份变化、watcher 退出或
CDP 失联时，状态会变为 `degraded`；再次点击应用会重新校验所有权并安全重建托管会话，
而不是把旧状态误报为 active。执行“恢复原生界面”会停止 DreamSkin 拥有的两个 job、移除
注入并关闭对应 CDP 端口，再以普通模式启动 WorkBuddy。

## Tool 与兼容层

Agent 看到的是一个 `dreamskin_theme` Tool，包含六个 action：

- `inspect`
- `list`
- `read`
- `create`
- `update`
- `validate`

`pluginId` 选择 `dreamskin.trae` 或 `dreamskin.workbuddy`。Studio 会把它连同当前 theme 和
revision 一起锁进 Agent session；直接启动的兼容入口为兼容旧调用默认选择 Trae。

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

默认仍只暴露一个 `dreamskin_theme`。旧的 Trae 九工具协议仅供已有集成迁移：

```bash
npm run mcp:legacy
```

桌面 Studio 会在 ACP 会话内部按当前 plugin、theme 和 revision 启动这个 stdio 子进程；
它不监听网络端口，用户不需要配置或常驻一个 MCP server。

## 本地路径

Web Studio 默认路径：

- Trae 用户主题：`~/.dreamskin/themes/`
- WorkBuddy 用户主题：`~/.dreamskin/themes/dreamskin.workbuddy/`
- Trae library：`~/.dreamskin/library.json`
- WorkBuddy library：`~/.dreamskin/libraries/dreamskin.workbuddy.json`
- Trae 数据与备份：`~/.dreamskin/data/`
- WorkBuddy 数据与备份：`~/.dreamskin/data/dreamskin.workbuddy/`

仓库内 JSON CLI / Tool 的默认主题是 `<repo>/themes`，事务数据是
`<repo>/.trae-dream-skin`；可通过 `TRAE_DREAM_SKIN_THEMES_ROOT` 和
`TRAE_DREAM_SKIN_TOOL_HOME` 覆盖。Studio 会把自己的用户主题根显式传给隐藏兼容子进程，
不会误写仓库模板。直接调试 WorkBuddy 脚本时还可用
`WORKBUDDY_DREAM_SKIN_THEMES_ROOT` 和 `WORKBUDDY_DREAM_SKIN_HOME` 覆盖主题与会话状态根。

Electron 使用 `app.getPath("userData")/dreamskin` 作为可写根。macOS 正式包通常是：

```text
~/Library/Application Support/DreamSkin Studio/dreamskin/
  themes/dreamskin.trae/
  themes/dreamskin.workbuddy/
  state/dreamskin.trae/library.json
  state/dreamskin.workbuddy/library.json
  state/dreamskin.workbuddy/runtime/
  backups/dreamskin.trae/
  backups/dreamskin.workbuddy/
  runtime/dreamskin.trae/
  runtime/dreamskin.workbuddy/
  logs/
```

通过桌面包应用 WorkBuddy 时，会话状态使用上面的
`state/dreamskin.workbuddy/runtime/`；直接运行仓库脚本时默认使用
`~/Library/Application Support/WorkBuddyDreamSkin`。Trae 注入会话的默认进程状态独立
保存在 `~/Library/Application Support/TraeDreamSkin`。打包内只读资源位于
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
自包含的 `codex-acp` 单文件适配器、Studio 静态文件、Trae 与 WorkBuddy 插件数据及各自
最小 runtime，并为全部必需文件生成 `resource-manifest.v1.json`。两个
`runtime/dreamskin.<target>/` 都有独立的 `runtime-manifest.v1.json`。正式包把资源清单视为
exact inventory：除清单、清单声明的文件和必要父目录外，额外文件、symlink 或特殊节点
都会使启动失败；任一资源清单、应用或已安装 runtime 版本不一致时同样 fail closed。

## 内置主题

Trae：

- `neon-portal`：深色青绿、荧光绿与玫红
- `ember-glass`：石墨、珊瑚、金色与青色
- `paper-aurora`：浅色纸面、莓红、青绿与黄铜
- `sunlit-spark`：明亮全幅插画与半透明浅色界面
- `violet-rift`：暗色风暴角色场景与克制玻璃材质
- `spark-atelier`：基于 Sunlit artwork 的实验性组件方案

WorkBuddy：

- `harbor-focus`：雾蓝海港与海玻璃色的安静工作空间
- `orchid-night`：深靛玻璃、兰花紫与青色边光的夜间工作台
- `paper-garden`：压花植物、纤维纸与墨蓝线条的明亮纸艺工作台

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
- CDP 仅绑定 `127.0.0.1`，并按目标校验应用签名、PID、启动时间、listener 和 browser identity。

回环地址只阻止远程网络直接连接，不是本机进程之间的权限边界；同一台 Mac 上的其他进程
仍可尝试访问开放的 CDP 端口，而 CDP 能在目标 renderer 中执行 JavaScript。皮肤会话开启
期间不要运行不可信本地软件，也不要转发端口；不使用时通过 Studio 恢复或运行目标平台的
stop 脚本。成功恢复会关闭 DreamSkin 拥有的 CDP listener。

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
本项目是非官方工具，不代表 Trae、WorkBuddy、ByteDance、OpenAI 或相关产品方。
