# DreamSkin Studio 发布检查清单

本清单面向 `0.2.x` 的 macOS arm64 交付。勾选完成前，不应把本地构建描述为正式可下载版本。

## 1. 当前发布边界

- [x] Electron macOS arm64 `.app` 可以生成。
- [x] 当前本地 `.app` 是 thin arm64，ad-hoc `codesign --verify --deep --strict` 通过。
- [x] Electron fuses、Info.plist 收敛、资源清单和版本化 runtime 有自动化测试。
- [ ] 当前仓库没有 Developer ID Application 私钥或 Apple 公证凭据。
- [ ] 当前 ad-hoc 产物没有 TeamIdentifier，也没有完成 Apple notarization，不能直接公开分发。
- [ ] Windows Electron/NSIS 安装包没有完成真实 Windows 机器验收，不在本轮正式发布范围内。
- [ ] macOS x64 / universal 没有构建和验收，不在本轮正式发布范围内。

`LSMinimumSystemVersion=12.0` 是打包配置，不等于已完成 macOS 12 到最新版本的全矩阵测试。

## 2. 发布前准备

- [ ] 使用 Apple silicon Mac。
- [ ] Node.js 版本满足 `>= 22.12`。
- [ ] Xcode Command Line Tools、`codesign`、`security`、`xcrun notarytool` 和 `xcrun stapler` 可用。
- [ ] `package-lock.json` 与 `package.json` 同步，使用 `npm ci` 安装根依赖。
- [ ] `studio/package-lock.json` 与 `studio/package.json` 同步，Studio 依赖已安装。
- [ ] `package.json`、`studio/package.json`、`plugins/trae/plugin.json` 的版本一致。
- [ ] `NOTICE.md`、`THIRD_PARTY_NOTICES.md`、主题素材摘要和许可证已复核。
- [ ] 工作区没有意外的凭据、`.env`、私钥、个人路径或调试产物进入打包白名单。

```bash
node --version
npm ci
npm --prefix studio ci
```

不要把 `.p12`、`.p8`、app-specific password 或 CI secret 写入仓库、构建日志和
`resource-manifest.v1.json`。

## 3. 自动化门禁

- [ ] 全量测试通过。
- [ ] 语法检查通过。
- [ ] Studio production build 通过。
- [ ] 真实 Codex ACP E2E 在发布机或受控 CI 上通过。
- [ ] 打包态 `--skip-agent` smoke 和打包态真实 Agent 验收均通过，不能互相替代。

```bash
npm test
npm run check
npm run studio:build
RUN_REAL_AGENT_E2E=1 node --test tests/real-agent-e2e.test.mjs
```

真实 Agent 测试会调用本机 Codex CLI，必须使用专门测试主题，并确认测试结束后没有残留
ACP/MCP 子进程。

## 4. 只读资源门禁

生成资源：

```bash
npm run desktop:resources
```

- [ ] `build/desktop-resources/resource-manifest.v1.json` 存在且 version 正确。
- [ ] manifest entries 稳定排序，并包含所有必要文件的 SHA-256 与 bytes。
- [ ] 清单是 exact inventory：只出现清单、声明文件和必要父目录，没有额外文件、symlink 或特殊节点。
- [ ] `runtime/dreamskin.trae/runtime-manifest.v1.json` 可被 VersionedRuntimeInstaller 校验。
- [ ] resource manifest version、应用版本和已安装 runtime version 精确一致。
- [ ] `plugins/trae/plugin.json`、catalog、assets、schema、registry 和 runtime mapping 齐全。
- [ ] `acp/codex-acp.mjs` 存在。
- [ ] `legal/` 包含产品和随包第三方许可。
- [ ] 输出中没有 `node_modules/`、`@openai/codex` 平台二进制、`.env`、source map 或未声明源码树。
- [ ] 对任意受保护文件做一次临时篡改时，资源校验会失败；随后重新运行资源构建恢复。

资源构建使用 staging 和原子替换，拒绝 symlink、路径穿越、未知 Studio 文件类型、
版本不一致和超限文件。正式包不会把目录项当作其全部后代的授权；缺少、篡改或增加
inventory，或资源/app/runtime 版本漂移，都会 fail closed 并中止启动。

## 5. 本地 unpacked 验收

先生成不用于公开分发的本地应用：

```bash
npm run desktop:pack
npm run desktop:verify:packaged -- --skip-agent
npm run desktop:verify:packaged
```

默认输出：

```text
dist-desktop/mac-arm64/DreamSkin Studio.app
```

- [ ] 主可执行文件为 `arm64`。
- [ ] ad-hoc 或 Developer ID 签名结构完整。
- [ ] `Info.plist` 包含 `ElectronAsarIntegrity`。
- [ ] 没有宽泛 `NSAppTransportSecurity`、相机、麦克风、音频采集或蓝牙 usage description。
- [ ] 资源清单和 runtime 清单位于 `Contents/Resources/dreamskin`。
- [ ] 首次启动会将 runtime `0.2.0` 安装到 userData 的版本目录。
- [ ] `--skip-agent` 下的 preload、资源校验、Studio bootstrap、主题卡片和优雅退出 smoke 通过。
- [ ] 默认模式下的真实 Codex ACP 对话修改了隔离主题的 revision 和预期字段。

```bash
file "dist-desktop/mac-arm64/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio"
codesign --verify --deep --strict --verbose=2 "dist-desktop/mac-arm64/DreamSkin Studio.app"
codesign -dv --verbose=4 "dist-desktop/mac-arm64/DreamSkin Studio.app" 2>&1
plutil -p "dist-desktop/mac-arm64/DreamSkin Studio.app/Contents/Info.plist"
npx electron-fuses read --app "dist-desktop/mac-arm64/DreamSkin Studio.app"
```

不带 `--skip-agent` 的命令执行包含真实 Codex ACP 对话的打包态验收：

```bash
npm run desktop:verify:packaged
```

该命令创建隔离的临时 userData 和空白主题，要求 Agent 实际修改主题 revision；测试结束后会关闭
ACP/MCP 子进程并删除临时数据。

两种模式都属于发布门禁：`--skip-agent` 隔离验证打包资源、UI 与退出链路，默认模式验证
随包 ACP adapter、本地 Codex CLI、隐藏 stdio Tool 和 repository reconcile 的完整链路。

预期 fuse：

| Fuse | 预期 |
| --- | --- |
| `RunAsNode` | Enabled |
| `EnableCookieEncryption` | Enabled |
| `EnableNodeOptionsEnvironmentVariable` | Disabled |
| `EnableNodeCliInspectArguments` | Disabled |
| `EnableEmbeddedAsarIntegrityValidation` | Enabled |
| `OnlyLoadAppFromAsar` | Enabled |
| `LoadBrowserProcessSpecificV8Snapshot` | Disabled |
| `GrantFileProtocolExtraPrivileges` | Disabled |
| `WasmTrapHandlers` | Disabled |

`RunAsNode` 必须保持开启，因为正式包使用 Electron executable 受控启动打包内的 ACP adapter
和隐藏 MCP stdio child。不要为了关闭它而改成复制完整 Node runtime；若执行模型改变，应先
重新做威胁建模和端到端测试。

## 6. Developer ID 签名凭据

正式分发需要 Apple Developer Program 团队中的 **Developer ID Application** 证书及私钥。
可选择以下一种方式：

### 6.1 已导入 keychain

将证书和私钥导入发布机 keychain，确认 electron-builder 能自动发现：

```bash
security find-identity -v -p codesigning
```

输出必须包含有效的 `Developer ID Application: ... (TEAMID)`，不能只依赖 ad-hoc identity。

### 6.2 CI 使用 PKCS#12

```bash
export CSC_LINK="/absolute/secure/path/DeveloperIDApplication.p12"
export CSC_KEY_PASSWORD="<secret>"
```

`CSC_LINK` 也可以由 CI 按 electron-builder 支持的安全格式注入。证书密码只能来自 secret
store。

`desktop:release:mac` 使用 `forceCodeSigning=true`；找不到有效签名 identity 时必须失败，
不能降级发布 ad-hoc 应用。

## 7. Apple 公证凭据

选择且只选择下列一种模式。

### 7.1 App Store Connect API key（推荐）

```bash
export APPLE_API_KEY="/absolute/secure/path/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 7.2 Apple ID app-specific password

```bash
export APPLE_ID="release@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID1234"
```

### 7.3 notarytool keychain profile

先在发布机安全存储凭据：

```bash
xcrun notarytool store-credentials "dreamskin-notary" \
  --apple-id "release@example.com" \
  --team-id "TEAMID1234" \
  --password "xxxx-xxxx-xxxx-xxxx"
export APPLE_KEYCHAIN_PROFILE="dreamskin-notary"
```

使用自定义 keychain 时再设置 `APPLE_KEYCHAIN`。不要同时设置多套不完整凭据；
electron-builder 会把半套环境变量视为配置错误。

## 8. 正式 macOS arm64 构建

凭据准备完成后运行：

```bash
npm run desktop:release:mac
```

该命令会：

1. 重新构建 Studio 和白名单资源；
2. 生成 macOS arm64 app；
3. 在 `afterPack` 中修改 fuses 并收敛 Info.plist；
4. 使用 Developer ID Application 完成 hardened runtime 签名；
5. 通过 Apple notary service 公证；
6. 生成 `DreamSkin-Studio-<version>-mac-arm64.dmg` 和 ZIP。
7. 对 unpacked `.app` 执行打包态 UI、资源和优雅退出 smoke，再验证正式签名、公证与 artifact。

- [ ] 构建日志明确显示使用 Developer ID，而不是 skipped/ad-hoc。
- [ ] 构建日志显示 `notarization successful`。
- [ ] DMG 和 ZIP 名称、版本、架构符合预期。
- [ ] 构建日志和 artifact 中不包含凭据。

## 9. 正式 artifact 验证

对 DMG：

```bash
hdiutil verify "dist-desktop/DreamSkin-Studio-0.2.0-mac-arm64.dmg"
```

挂载 DMG 后，对其中的 app 执行：

```bash
codesign --verify --deep --strict --verbose=2 "/Volumes/DreamSkin Studio/DreamSkin Studio.app"
codesign -dv --verbose=4 "/Volumes/DreamSkin Studio/DreamSkin Studio.app" 2>&1
spctl --assess --type execute --verbose=4 "/Volumes/DreamSkin Studio/DreamSkin Studio.app"
xcrun stapler validate "/Volumes/DreamSkin Studio/DreamSkin Studio.app"
npx electron-fuses read --app "/Volumes/DreamSkin Studio/DreamSkin Studio.app"
```

- [ ] `codesign -dv` 显示正确 TeamIdentifier 和 Developer ID authority。
- [ ] `codesign --verify` 通过。
- [ ] `spctl` 返回 accepted，来源是 Developer ID / notarized Developer ID。
- [ ] `stapler validate` 通过，可在离线 Gatekeeper 场景验证 ticket。
- [ ] fuse 值与第 5 节一致。
- [ ] ZIP 解压后的 app 做同样验证。
- [ ] 在一台没有开发 keychain 和源码目录的干净 Apple silicon Mac 上验收。

## 10. 功能验收

在干净测试账号完成：

- [ ] Studio 首屏能加载主题中心，模板图片无缺失。
- [ ] “添加到我的主题”不会修改内置 catalog。
- [ ] 可以新建空白主题。
- [ ] 空白主题以 `neutral` treatment 开始，不带任一 catalog 模板的专属装饰。
- [ ] 可以复制主题。
- [ ] 添加或复制后的本地 theme id 改变，但 `appearance.treatment` 保持，完整组件视觉不丢失。
- [ ] `backgroundOverlay` 与 `backgroundBlendMode` 在 Studio 预览和 Trae runtime 中表现一致。
- [ ] 删除需要 revision，且不能删除当前应用主题。
- [ ] 手工编辑后 revision 增加，重启应用仍保留。
- [ ] 能发现本地 Codex CLI；若不在标准路径，`DREAMSKIN_CODEX_PATH` 生效。
- [ ] Codex ACP 对话只修改选定主题，并能通过 validate。
- [ ] Work、Code、Design、对话页和组件状态预览正常。
- [ ] 应用主题前会校验，Trae 只开放 loopback CDP。
- [ ] verify 返回正确的 owned process、browser identity 和主题状态。
- [ ] restore 后注入样式、watcher 和 CDP listener 均清理，Trae 正常模式重启。
- [ ] 退出 Studio 时没有残留 ACP/MCP child。
- [ ] 第二次启动使用同一 userData，不会重复破坏 runtime version 状态。

Trae runtime 实机基线仍是 Trae `0.1.36`。若 Trae 版本、签名团队、renderer URL 或 DOM
fingerprint 变化，必须重新执行完整 apply/verify/restore 验收。

## 11. 发布记录

- [ ] 记录 git commit、Node/npm/Electron/electron-builder 版本。
- [ ] 记录测试结果和真实 Agent E2E 结果。
- [ ] 记录 artifact 文件名、大小和 SHA-256。
- [ ] 记录 Developer ID TeamIdentifier 和 notarization submission id，但不记录秘密。
- [ ] 记录实测 macOS 版本、Mac 型号、Trae 版本和 Codex CLI 版本。
- [ ] 更新 release notes，明确“macOS arm64”与已知限制。
- [ ] 保留上一版本 artifact 和 runtime rollback 测试记录。

```bash
shasum -a 256 dist-desktop/DreamSkin-Studio-0.2.0-mac-arm64.dmg
shasum -a 256 dist-desktop/DreamSkin-Studio-0.2.0-mac-arm64.zip
```

## 12. 必须停止发布的情况

出现任一情况立即停止：

- 任一自动化测试失败；
- resource/runtime manifest 校验失败、版本漂移或 exact inventory 中出现未声明文件；
- fuses 与预期不一致；
- 签名降级为 ad-hoc、TeamIdentifier 错误或 hardened runtime 缺失；
- notarization、stapling 或 Gatekeeper assessment 失败；
- Agent 能越过当前 theme/revision scope；
- Studio 可被非受信 sender 调用，或 renderer 获得 Node 权限；
- restore 不能可靠关闭 owned CDP 会话；
- artifact 意外包含凭据、完整 `node_modules`、Codex 平台二进制或个人数据。

## 13. Windows 说明

`package.json` 中的 Windows NSIS 配置和 PowerShell runtime 脚本不是“已发布 Windows
版本”的证据。在正式标记 Windows 支持前，必须在真实 Windows 机器另建检查清单，至少
覆盖签名发布者、安装/卸载、路径带空格、UAC、Trae 发现、ACP child、CDP ownership、
apply/verify/restore 和干净机安装。当前 release notes 必须明确 Windows 桌面包未验证。
