<p align="center">
  <img src="./desktop/assets/icon.png" width="112" alt="DreamSkin Studio 应用图标">
</p>

<h1 align="center">DreamSkin Studio</h1>

<p align="center"><strong>让本地 Agent 的工作空间，真正长成你喜欢的样子。</strong></p>

<p align="center">
  DreamSkin Studio 是 Agent Dream Skin 的桌面主题工作室。<br>
  挑选模板、添加到“我的主题”，再用自然语言和本地 CLI Agent 一起修改、预览和应用。
</p>

<p align="center">
  <img alt="macOS Apple silicon" src="https://img.shields.io/badge/macOS-Apple%20silicon-111111?logo=apple&logoColor=white">
  <img alt="支持 Trae 与 WorkBuddy" src="https://img.shields.io/badge/Targets-Trae%20%2B%20WorkBuddy-2F7D72">
  <img alt="本地优先" src="https://img.shields.io/badge/Experience-Local--first-D95D4A">
  <img alt="MIT License" src="https://img.shields.io/badge/License-MIT-3A73C1">
</p>

![DreamSkin Studio 主题中心](./docs/images/studio-theme-center.jpg)

## 不只是换一张背景

DreamSkin 改变的是一整套界面语言。背景、色彩、材质、导航、对话、输入区、按钮、
卡片、通知和浮层会作为同一个主题一起变化。Studio 把目标应用的重要页面与组件状态
集中展示，让你在真正应用之前就能看清整体效果。

| 整套界面一起设计 | 直接说出你想要的感觉 | 想试就试，随时回来 |
| --- | --- | --- |
| 首页、对话页与组件状态使用统一的视觉语言，而不是各改各的。 | 连接本地 Codex CLI，继续调整模板，或从一句话生成空白主题。 | 预览、应用、验证与恢复都是明确操作，不把一次尝试变成永久修改。 |

## 两种工作空间，两套完整体验

<table>
  <tr>
    <td width="50%"><img src="./docs/images/studio-trae-editor.jpg" alt="DreamSkin Studio 中的 Trae Spark Atelier 主题编辑器"></td>
    <td width="50%"><img src="./docs/images/studio-workbuddy-editor.jpg" alt="DreamSkin Studio 中的 WorkBuddy Harbor Focus 主题编辑器"></td>
  </tr>
  <tr>
    <td valign="top">
      <strong>Trae：把编码环境变成创作空间</strong><br><br>
      覆盖 Work、Code、Design、对话页与 20 个常用组件。可以从 Sunlit Spark 的明亮
      插画感出发，也可以选择 Violet Rift 的深色沉浸风格，再让 Agent 按你的工作习惯
      继续收敛。
    </td>
    <td valign="top">
      <strong>WorkBuddy：让日常工作台拥有自己的气质</strong><br><br>
      覆盖首页、对话、结果与产物、专家与技能、自动化、项目与空间、设置、浮层与状态
      共 8 个场景、32 个组件。Harbor Focus 适合安静专注，Orchid Night 适合夜间工作，
      Paper Garden 则保留明亮的纸艺质感。
    </td>
  </tr>
</table>

## 从灵感到应用

1. 在“主题中心”按目标应用与风格浏览模板。
2. 点击“添加到我的主题”，或者为指定应用新建空白主题。
3. 连接本地 Codex CLI，用自然语言描述想要的氛围与细节。
4. 在右侧切换页面和组件，逐项检查按钮、输入框、通知、浮层等实际效果。
5. 确认后显式应用并验证；需要时一键恢复原生界面。

模板始终保留原版。添加到“我的主题”后，你得到的是一份可以独立修改、复制和继续创作
的副本。

## 没有合适模板？从一句话开始

新建空白主题后，不需要先理解复杂配置。你可以直接对 Agent 说：

> 做一套清爽的冬日主题。背景有轻微雪景，面板保持高可读性，主要操作使用冷绿色，
> 但警告状态仍然清晰。

也可以基于现有模板继续调整：

> 把这个主题改得更克制一些。保留插画背景，主色换成雾蓝，并提高代码区和输入框的
> 对比度。

> 以 Paper Garden 为基础做一个晚间阅读版本。保留植物纸艺细节，让通知和主要按钮
> 更醒目。

Agent 只会修改当前打开的主题；真正应用到目标软件之前，控制权始终在你手中。

## 9 套内置主题

| 目标应用 | 主题 | 视觉方向 |
| --- | --- | --- |
| Trae | **Sunlit Spark** | 明亮插画与轻盈面板 |
| Trae | **Violet Rift** | 深色角色场景与克制玻璃感 |
| Trae | **Paper Aurora** | 纸面质感与柔和极光配色 |
| Trae | **Neon Portal** | 青绿、荧光绿与玫红的深色空间 |
| Trae | **Ember Glass** | 石墨、珊瑚、金色与青色 |
| Trae | **Spark Atelier** | 更具手作感的实验性组件语言 |
| WorkBuddy | **Harbor Focus** | 雾蓝海港，安静专注 |
| WorkBuddy | **Orchid Night** | 深靛玻璃，适合夜间工作 |
| WorkBuddy | **Paper Garden** | 压花植物与明亮纸艺 |

每套模板都可以添加到“我的主题”、复制并继续修改。主题中心也为未来更多桌面 Agent 应用
和社区模板预留了位置。

## 在本机运行

DreamSkin Studio 是本地桌面应用，目前不提供云端演示。主题、预览和 Agent 对话都在你
自己的电脑上运行；GitHub 页面本身不会启动 Studio。

当前推荐环境：

- macOS 12 或更高版本，Apple silicon。
- Node.js `>= 22.12`。
- 已安装 Trae 或 WorkBuddy。
- 如需对话修改主题，本机还需要可用的 Codex CLI。

```bash
git clone https://github.com/l77948032-cyber/Agent-Dream-Skin.git
cd Agent-Dream-Skin
npm install
npm --prefix studio install
npm run desktop:dev
```

最后一条命令会在当前电脑上打开 DreamSkin Studio。首次启动需要完成本地构建，可能需要
稍等片刻。

## 当前支持

| 应用 | 当前体验 |
| --- | --- |
| **Trae** | macOS 实机验证，覆盖 Work、Code、Design、对话页与 20 个组件；当前重点验证版本为 TRAE SOLO CN `0.1.36`。 |
| **WorkBuddy** | macOS WorkBuddy `5.2.6` 实机验证，覆盖 8 个完整场景与 32 个组件。 |
| **Windows** | 相关运行与打包工作仍在验证阶段，暂不建议作为稳定体验环境。 |

### 使用前请知道

- 当前项目属于开发者预览，优先推荐在 macOS Apple silicon 上体验。
- 目标应用升级后，界面变化可能需要 DreamSkin 更新适配。
- 关闭 Studio 不等于恢复原生主题；需要清理时，请在设置中使用“恢复原生界面”。
- DreamSkin 不会让 Agent 自动应用主题，应用与恢复始终需要用户明确操作。
- 本地构建未包含公开发行所需的 Apple Developer ID 签名与公证。

## 常见问题

<details>
<summary><strong>需要单独启动主题服务吗？</strong></summary>
<br>
不需要。启动 DreamSkin Studio，连接本机可用的 Codex CLI，就可以开始浏览和修改主题。
</details>

<details>
<summary><strong>添加模板会覆盖原版吗？</strong></summary>
<br>
不会。模板会作为独立副本加入“我的主题”，之后的修改只属于这份副本。
</details>

<details>
<summary><strong>可以完全从零开始吗？</strong></summary>
<br>
可以。选择目标应用后新建空白主题，再通过对话逐步生成和调整。
</details>

<details>
<summary><strong>不喜欢已经应用的效果怎么办？</strong></summary>
<br>
在 Studio 设置中选择对应应用并点击“恢复原生界面”。DreamSkin 会清理自己开启的主题
会话，让目标应用回到普通状态。
</details>

<details>
<summary><strong>关闭 Studio 后主题还在吗？</strong></summary>
<br>
已经应用到 WorkBuddy 的主题不会因为 Studio 窗口关闭而立刻消失。需要结束主题时，请主动
使用“恢复原生界面”；如果 WorkBuddy 本身退出，再次应用即可安全重建主题会话。
</details>

## 接下来

- 适配更多桌面 Agent 应用。
- 支持社区主题的导入、分享与版本管理。
- 增加更多官方模板和主题案例。
- 完成 Windows 实机验收。
- 推进 macOS 正式签名与可下载发行版。

## 反馈与贡献

不需要上传代码也可以参与。发现问题、想到新的主题方向，或者希望 DreamSkin 支持其他
桌面 Agent 应用，都可以通过 [Issue](https://github.com/l77948032-cyber/Agent-Dream-Skin/issues)
告诉我们。反馈兼容性问题时，建议附上目标应用版本、系统版本、复现步骤和截图。

如果你希望贡献代码或主题，可以先 Fork 本项目，在自己的仓库中完成修改，再提交 Pull
Request。Pull Request 是一份“建议合并”的申请，不会直接改动本仓库；是否合并始终由
项目维护者审核决定。除非被明确添加为协作者，其他人没有直接写入本仓库的权限。

只想下载、运行和创作自己的主题，不需要提交 Issue 或 Pull Request。

## 许可与说明

- [素材与来源说明](./NOTICE.md)
- [第三方许可](./THIRD_PARTY_NOTICES.md)

本项目采用 [MIT License](./LICENSE)。外部注入思路参考了
[Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin)。

Agent Dream Skin 是非官方社区项目，不代表 Trae、WorkBuddy、ByteDance、OpenAI 或相关
产品方。
