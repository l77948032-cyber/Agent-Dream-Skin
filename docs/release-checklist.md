# DreamSkin Studio 发布检查清单

本清单面向 `0.4.0` 及后续 macOS arm64 交付，并明确区分两条发布路径：手工创建、明确标注
为未签名测试包的公开 prerelease，以及通过 `v*` tag 自动创建的 Developer ID 签名稳定版。
任一路径完成对应门禁前，都不应把本地构建描述为已经可下载的版本。

## 1. 当前发布边界

- [x] Electron macOS arm64 `.app` 可以生成。
- [x] 当前本地 `.app` 是 thin arm64，ad-hoc `codesign --verify --deep --strict` 通过。
- [x] Electron fuses、Info.plist 收敛、资源清单和版本化 runtime 有自动化测试。
- [x] Trae 与 WorkBuddy 的本地主题库、完整预览、应用/验证与恢复链路已有实机基线。
- [ ] 当前仓库没有 Developer ID Application 私钥或 Apple 公证凭据，因此不能发布免警告稳定版。
- [ ] ad-hoc 产物没有 TeamIdentifier 或 Apple notarization，只能作为明确标注的未签名测试版；
  公开 prerelease 必须附带校验和、Gatekeeper 说明，并且不能进入 stable/latest 更新通道。
- [ ] Windows Electron/NSIS 安装包没有完成真实 Windows 机器验收，不在本轮正式发布范围内。
- [ ] macOS x64 / universal 没有构建和验收，不在本轮正式发布范围内。

`LSMinimumSystemVersion=12.0` 是打包配置，不等于已完成 macOS 12 到最新版本的全矩阵测试。

## 2. 发布前准备

- [ ] 使用 Apple silicon Mac。
- [ ] Node.js 版本满足 `>= 22.12`。
- [ ] Xcode Command Line Tools、`codesign` 和 `security` 可用；签名稳定版还要求
  `xcrun notarytool` 与 `xcrun stapler` 可用。
- [ ] `package-lock.json` 与 `package.json` 同步，使用 `npm ci` 安装根依赖。
- [ ] `studio/package-lock.json` 与 `studio/package.json` 同步，Studio 依赖已安装。
- [ ] `package.json`、`studio/package.json`、`plugins/trae/plugin.json`、`plugins/workbuddy/plugin.json` 的版本一致。
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
- [ ] `dreamskin` CLI JSON v1 契约、目标隔离、revision 冲突和输入上限测试通过。
- [ ] 打包态 Studio smoke 与安装包内 CLI smoke 均通过，不能只验证其中一种入口。

```bash
npm test
npm run check
npm run studio:build
```

发布验收不依赖任何外部 Agent。CLI smoke 必须直接调用随包 `dreamskin`，在隔离主题库中完成
`targets`、`read`、`create`、`update` 与 `validate`，并确认每次调用只输出一个 JSON envelope。

## 4. 只读资源门禁

生成资源：

```bash
npm run desktop:resources
```

- [ ] `build/desktop-resources/resource-manifest.v1.json` 存在且 version 正确。
- [ ] manifest entries 稳定排序，并包含所有必要文件的 SHA-256 与 bytes。
- [ ] 清单是 exact inventory：只出现清单、声明文件和必要父目录，没有额外文件、symlink 或特殊节点。
- [ ] `runtime/dreamskin.trae/runtime-manifest.v1.json` 可被 VersionedRuntimeInstaller 校验。
- [ ] `runtime/dreamskin.workbuddy/runtime-manifest.v1.json` 可被 VersionedRuntimeInstaller 校验。
- [ ] resource manifest version、应用版本和两个已安装 runtime version 精确一致。
- [ ] `plugins/trae/plugin.json`、catalog、assets、schema、registry 和 runtime mapping 齐全。
- [ ] `plugins/workbuddy/plugin.json`、catalog、assets、schema、32 组件 registry、9 scene manifest 和 runtime mapping 齐全。
- [ ] 两个第一方 catalog 合计恰好包含 20 套模板，每套主题声明的图片均存在、可解码且没有复用占位图。
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
- [ ] 资源清单和两个 runtime 清单位于 `Contents/Resources/dreamskin`。
- [ ] 首次启动会将 Trae 与 WorkBuddy runtime `0.4.0` 分别安装到 userData 的版本目录。
- [ ] preload、资源校验、双 target Studio bootstrap、20 套模板、主题预览和优雅退出 smoke 通过。
- [ ] 随包 CLI 能在隔离 userData 中查询双 target，创建、读取、更新并验证主题。
- [ ] Studio 能发现 CLI 写入的新主题和 revision，并刷新当前预览，不需要重启应用。

```bash
file "dist-desktop/mac-arm64/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio"
codesign --verify --deep --strict --verbose=2 "dist-desktop/mac-arm64/DreamSkin Studio.app"
codesign -dv --verbose=4 "dist-desktop/mac-arm64/DreamSkin Studio.app" 2>&1
plutil -p "dist-desktop/mac-arm64/DreamSkin Studio.app/Contents/Info.plist"
npx electron-fuses read --app "dist-desktop/mac-arm64/DreamSkin Studio.app"
```

`desktop:verify:packaged` 使用隔离的临时 userData，不读取或修改用户真实主题。它同时验证
Studio 本地主题库和随包 CLI，要求 CLI 实际推进主题 revision，随后确认 Studio 读取到同一
结果；测试结束后删除临时数据。

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

`RunAsNode` 必须保持开启，因为 Studio 安装的 `dreamskin` launcher 会受控调用应用包内 CLI。
launcher 只进入固定的 `bin/dreamskin.mjs`，不接受替换入口。不要为了关闭 fuse 而复制完整
Node runtime；若执行模型改变，应先重新做威胁建模和端到端测试。

### 5.1 ad-hoc 测试安装包验收

需要把构建交给测试人员安装时，不要只发送 unpacked `.app`。运行：

```bash
npm run desktop:installer:mac
npm run desktop:verify:installer
```

该流程生成 macOS arm64 DMG 与 ZIP，并允许应用使用 ad-hoc 签名。安装包验证必须至少覆盖：

- [ ] `.app`、DMG、ZIP 都存在且非空；
- [ ] `.app` 的 ad-hoc 或 Developer ID 代码签名结构通过严格校验；
- [ ] DMG 容器可以校验、挂载并包含 `DreamSkin Studio.app`；
- [ ] DMG 中的 `Applications` 入口正确指向 `/Applications`；
- [ ] ZIP 完整性测试通过；
- [ ] DMG 和 ZIP 的 SHA-256 已输出并随测试包保存；
- [ ] `dist-desktop/packaged-smoke.png` 展示的确是当前打包版本。

这类构建可以用于本机、受控测试，也可以在完成本清单对应门禁后，手工创建明确标注的公开
未签名 prerelease。它没有 Developer ID 与公证票据，从浏览器下载后可能被 Gatekeeper 拦截；
不得命名为正式版、不得标记为 stable/latest，也不得启用应用内自动更新。公开 prerelease 必须
同时提供 DMG、ZIP、`SHA256SUMS.txt`、首次打开说明和未公证风险提示。

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

`build.dmg.sign=true` 会让 electron-builder 在临时签名 keychain 仍然可用时，用同一套
Developer ID Application identity 签署最终 DMG。后续公证步骤只验证既有签名，不会猜测或
重新导入另一张证书。

### 6.3 GitHub Actions 证书 secret

仓库的 `macos-release` Environment 必须配置以下 secret：

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | electron-builder 可读取的 Developer ID Application PKCS#12；使用其支持的 base64 形式或受保护下载地址 |
| `CSC_KEY_PASSWORD` | PKCS#12 密码 |

建议为 `macos-release` Environment 开启 required reviewers，并只允许受保护的 `v*` tag
部署。证书只通过签名步骤的环境变量交给 electron-builder，不要先写入仓库工作区，也不要在 shell
中打印或解码到日志。手动测试包 job 不声明这个 Environment，也不会获得这些 secret。

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

### 7.4 GitHub Actions 公证 secret

当前 `.github/workflows/release-macos.yml` 使用 Apple ID 方式，`macos-release`
Environment 还必须配置：

| Secret | 内容 |
| --- | --- |
| `APPLE_ID` | Apple Developer Program 团队成员的 Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | 为发行流程单独创建的 app-specific password |
| `APPLE_TEAM_ID` | 与 Developer ID Application 证书一致的 Team ID |

`GITHUB_TOKEN` 由 Actions 自动提供，只在签名 job 中授予 `contents: write`，用于创建当前 tag
对应的 Release。不要添加个人 PAT，也不要给验证 job 或 unsigned job 写权限。

## 8. macOS arm64 发布路径

### 8.1 Developer ID 签名稳定版构建

凭据准备完成后运行：

```bash
npm run desktop:release:mac
```

该命令会：

1. 重新构建 Studio、两个第一方 plugin 和白名单 runtime 资源；
2. 生成 macOS arm64 app；
3. 在 `afterPack` 中修改 fuses 并收敛 Info.plist；
4. 使用 Developer ID Application 完成 hardened runtime 签名；
5. 提交 app 到 Apple notary service，并把公证票据 staple 到 app；
6. 生成 `DreamSkin-Studio-<version>-mac-arm64.dmg` 和 ZIP，并用 Developer ID 签署最终 DMG；
7. 单独提交最终 DMG，等待 `notarytool` 返回 `Accepted`，再把票据 staple 到 DMG；
8. 重新生成 DMG blockmap，并同步 `latest-mac.yml` 中的最终大小与 SHA-512；
9. 对 unpacked `.app` 执行打包态 UI、资源和优雅退出 smoke，再严格验证 app、ZIP 和 DMG。

- [ ] 构建日志明确显示使用 Developer ID，而不是 skipped/ad-hoc。
- [ ] app 公证成功，最终 DMG 的独立提交也返回 `Accepted` 和 submission ID。
- [ ] 最终 DMG 的 `stapler validate` 与 `spctl --assess --type open --context context:primary-signature` 均通过。
- [ ] DMG 和 ZIP 名称、版本、架构符合预期。
- [ ] `latest-mac.yml` 精确描述当前稳定版本，并同时列出 ZIP 与 DMG；两份 blockmap 均存在。
- [ ] 构建日志和 artifact 中不包含凭据。

### 8.2 GitHub Actions 手动测试 artifact

在 GitHub 的 **Actions -> macOS Release -> Run workflow** 手动启动时，流水线只执行
`unsigned-installer`：

1. 使用 lockfile 安装根项目和 Studio 依赖；
2. 执行语法检查、全量测试和 Studio production build；
3. 以关闭签名身份自动发现的方式构建 ad-hoc arm64 DMG/ZIP；
4. 运行安装包结构校验、打包态 Studio smoke 和随包 CLI smoke，保存截图；
5. 生成 `SHA256SUMS.txt`；
6. 上传保留 14 天的 `dreamskin-macos-arm64-unsigned-<run number>` Actions artifact。

手动运行不会读取 Apple secret，也不会创建 GitHub Release。下载该 artifact 的人应明确知道
它是测试构建。

### 8.3 手工创建公开未签名 prerelease

`0.4.0` 的公开测试版使用固定 tag `test-v0.4.0-macos-arm64`。该 tag 不匹配工作流的 `v*`
触发条件，因此不会进入签名稳定版 job，也不会写入 stable/latest 更新通道。执行前必须确认：

- [ ] 第 1-5 节适用于 ad-hoc 包的测试和安装验收均已通过；
- [ ] tag 指向已经推送、工作区干净且完成复核的 commit；
- [ ] DMG、ZIP 与 `SHA256SUMS.txt` 均为同一次 `0.4.0` 构建生成；
- [ ] Release 标记为 prerelease，标题和说明明确写出“未签名测试版”；
- [ ] Release notes 包含 SHA-256 校验、右键打开、隐私与安全性“仍要打开”说明；
- [ ] 没有上传旧版本 artifact、`latest-mac.yml` 或任何凭据。

从已完成验收的干净 commit 执行以下完整流程：

```bash
npm run desktop:installer:mac

(
  cd dist-desktop
  shasum -a 256 -- \
    DreamSkin-Studio-0.4.0-mac-arm64.dmg \
    DreamSkin-Studio-0.4.0-mac-arm64.zip > SHA256SUMS.txt
)

git tag -a test-v0.4.0-macos-arm64 \
  -m "DreamSkin Studio 0.4.0 macOS arm64 unsigned test"
git push origin test-v0.4.0-macos-arm64

gh release create test-v0.4.0-macos-arm64 \
  dist-desktop/DreamSkin-Studio-0.4.0-mac-arm64.dmg \
  dist-desktop/DreamSkin-Studio-0.4.0-mac-arm64.zip \
  dist-desktop/SHA256SUMS.txt \
  --repo l77948032-cyber/Agent-Dream-Skin \
  --verify-tag \
  --prerelease \
  --title "DreamSkin Studio 0.4.0 未签名测试版" \
  --notes-file docs/releases/v0.4.0.md
```

发布后立即核对 Release 状态与资产，三个文件必须存在且非空，`isPrerelease` 必须为 `true`：

```bash
gh release view test-v0.4.0-macos-arm64 \
  --repo l77948032-cyber/Agent-Dream-Skin \
  --json url,isDraft,isPrerelease,assets
```

公开测试版发现问题时，应删除该 prerelease、修复并使用新的测试 tag，不能移动或复用已经被
用户下载过的 tag。该手工流程不能替代下一节的 Developer ID 签名、公证与稳定版门禁。

### 8.4 `v*` tag 正式发布

推送 `v*` tag 时才会执行 `signed-release`。当前自动更新契约只发布稳定版本，更新元数据固定为
`latest-mac.yml`；带 `-alpha`、`-beta`、`-rc` 等 prerelease 标识的版本会被流水线明确拒绝，
不能借用 stable channel 发布。发布前：

- [ ] `package.json` 中的版本与 tag 精确一致，例如 `0.4.0` 对应 `v0.4.0`；
- [ ] tag 指向已完成代码审查和第 1-12 节检查的 commit；
- [ ] `macos-release` Environment 的保护规则与五个 secret 均有效；
- [ ] GitHub Actions 的 workflow permissions 允许该 job 写入 Releases。

```bash
git tag -a v0.4.0 -m "DreamSkin Studio v0.4.0"
git push origin v0.4.0
```

签名 job 会运行 `npm run desktop:release:mac`，因此找不到 Developer ID、签名降级、公证失败、
Gatekeeper/stapler 校验失败或打包态 smoke 失败都会在发布前终止。随后它再次校验 DMG/ZIP
安装结构、生成 smoke 截图与 `SHA256SUMS.txt`，先保存 Actions artifact，最后才通过 GitHub
CLI 创建 Release 并上传 DMG、ZIP、校验和与截图。任何前置步骤失败都不会创建 Release。

若 job 在创建草稿后失败，同一 tag 重跑时会先删除旧草稿并从已经重新验证的本地资产完整重建；
若该 tag 已经公开，流水线会拒绝覆盖。公开版本出现问题时应修正原因并发布新的版本 tag，不要复用
已经公开的版本号，也不要用未验证的本地文件手工补齐一个看似成功的正式 Release。

## 9. 正式 artifact 验证

对 DMG：

```bash
hdiutil verify "dist-desktop/DreamSkin-Studio-0.4.0-mac-arm64.dmg"
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
- [ ] Trae / WorkBuddy 分类切换正确，主题中心合计显示 20 套模板且目标归属正确。
- [ ] “添加到我的主题”不会修改内置 catalog。
- [ ] 可以为 Trae 或 WorkBuddy 新建空白主题，创建结果只进入所选 plugin 的主题库。
- [ ] 空白主题以 `neutral` treatment 开始，不带任一 catalog 模板的专属装饰。
- [ ] 可以复制主题。
- [ ] 添加或复制后的本地 theme id 改变，但 `appearance.treatment` 保持，完整组件视觉不丢失。
- [ ] `backgroundOverlay` 与 `backgroundBlendMode` 在 Studio 预览和所选 target runtime 中表现一致。
- [ ] 删除需要 revision，且不能删除当前应用主题。
- [ ] 手工编辑后 revision 增加，重启应用仍保留。
- [ ] 设置页能显示 `dreamskin` CLI 的支持状态、目标安装路径和 `PATH` 可用性。
- [ ] 可以一键安装和卸载 Studio 管理的 CLI；不会覆盖同名的非 DreamSkin 文件。
- [ ] `dreamskin targets` 返回 Trae 与 WorkBuddy，所有 theme 命令都要求显式 `--plugin`。
- [ ] CLI create/update 只修改选定 plugin 和 theme；update 必须匹配 expected revision，并能通过 validate。
- [ ] CLI 修改当前主题后，Studio 自动刷新 revision 和预览；Studio 内没有 Agent 连接或对话入口。
- [ ] Trae 的 Work、Code、Design、对话页和 20 个组件状态预览正常。
- [ ] WorkBuddy 的首页、助理、对话、结果与产物、专家与技能、自动化、项目、设置、浮层与状态 9 个场景和 32 个组件预览正常。
- [ ] 应用主题前会校验，Trae 与 WorkBuddy 都只开放 loopback CDP。
- [ ] 安全说明明确回环不是认证：端口开启期间，同机其他进程仍可尝试访问 CDP。
- [ ] verify 返回正确的 owned process、browser identity 和主题状态。
- [ ] Trae restore 后注入样式、watcher 和 CDP listener 均清理，Trae 正常模式重启。
- [ ] Trae 的 owned app、watcher、listener 或进程身份失效时状态为 `degraded`，不能误报 active。
- [ ] WorkBuddy 应用后关闭 Studio，独立托管会话和当前皮肤仍保持 active。
- [ ] 用户退出 WorkBuddy 后状态为 `degraded`，不能误报 active，也不宣传或依赖自动复活。
- [ ] degraded 状态再次应用能安全重建 owned WorkBuddy app/watcher/CDP 会话。
- [ ] WorkBuddy restore 后两个 owned `launchd` job、注入和 CDP listener 均清理，WorkBuddy 以普通模式重启。
- [ ] CLI 每次调用结束后退出，不产生常驻子进程或后台服务。
- [ ] 上一项不把用户明确应用后仍在运行的 WorkBuddy owned runtime job 误判为 CLI 泄漏。
- [ ] 第二次启动使用同一 userData，不会重复破坏 runtime version 状态。

Trae runtime 实机基线是 Trae `0.1.36`。WorkBuddy runtime 实机基线是 WorkBuddy
`5.2.6`、Bundle ID `com.workbuddy.workbuddy`、Team ID `FN2V63AD2J`、selector profile
`5.2`。任一目标的版本、签名团队、renderer URL 或 DOM fingerprint 变化，都必须重新执行
完整 apply/verify/restore 验收。

## 11. 发布记录

- [ ] 记录 git commit、Node/npm/Electron/electron-builder 版本。
- [ ] 记录测试结果、CLI JSON v1 smoke 和 Studio 自动刷新结果。
- [ ] 记录 artifact 文件名、大小和 SHA-256。
- [ ] 签名稳定版记录 Developer ID TeamIdentifier 和 notarization submission id，但不记录秘密；
  未签名 prerelease 则明确记录 ad-hoc 签名且没有公证票据。
- [ ] 记录实测 macOS 版本、Mac 型号、Trae 版本、WorkBuddy 版本和 DreamSkin CLI 版本。
- [ ] 更新 release notes，明确“macOS arm64”与已知限制。
- [ ] 保留上一版本 artifact 和 runtime rollback 测试记录。

```bash
shasum -a 256 dist-desktop/DreamSkin-Studio-0.4.0-mac-arm64.dmg
shasum -a 256 dist-desktop/DreamSkin-Studio-0.4.0-mac-arm64.zip
```

## 12. 必须停止发布的情况

出现任一情况立即停止：

- 任一自动化测试失败；
- resource/runtime manifest 校验失败、版本漂移或 exact inventory 中出现未声明文件；
- fuses 与预期不一致；
- 签名稳定版降级为 ad-hoc、TeamIdentifier 错误或 hardened runtime 缺失；
- 签名稳定版的 notarization、stapling 或 Gatekeeper assessment 失败；
- CLI 能越过显式 plugin/theme/revision scope，或允许 Agent 直接应用、恢复、删除主题；
- Studio 可被非受信 sender 调用，或 renderer 获得 Node 权限；
- 任一 target 的 restore 不能可靠关闭 owned CDP 会话；
- WorkBuddy app、watcher、listener 或 browser identity 已失效但 status 仍报告 active；
- artifact 意外包含凭据、完整 `node_modules`、Codex 平台二进制或个人数据。

## 13. Windows 说明

`package.json` 中的 Windows NSIS 配置和 PowerShell runtime 脚本不是“已发布 Windows
版本”的证据。在正式标记 Windows 支持前，必须在真实 Windows 机器另建检查清单，至少
覆盖签名发布者、安装/卸载、路径带空格、UAC、Trae 发现、CLI 安装与 `PATH`、CDP ownership、
apply/verify/restore 和干净机安装。WorkBuddy plugin 当前只声明 macOS，不应由 Windows
配置推导出 WorkBuddy Windows 支持。当前 release notes 必须明确 Windows 桌面包未验证。
