# DreamSkin Agent Tool v1

## 产品边界

`dreamskin` 是 DreamSkin 面向本地编程 Agent 的稳定命令行入口。它让已经在用户电脑上运行
的 Agent 查询目标应用、读取本地主题、创建或修改主题，并在交还用户前完成验证。

DreamSkin Studio 是另一种入口：它像 Obsidian 桌面端管理本地资料库一样，负责管理“我的
主题”、浏览模板、展示完整 UI 预览，并承载应用与恢复操作。Studio 不内置 Agent、不建立
Agent 会话，也不会启动 Agent 进程。

两个入口读取同一份本地主题数据，因此 Agent 通过 CLI 完成的修改会被 Studio 自动发现。
CLI 不提供运行时应用、恢复、删除或任意 CSS 执行能力；这些高影响操作不会交给 Agent。

当前第一方目标是：

- `dreamskin.trae`
- `dreamskin.workbuddy`

## 安装与发现

macOS 桌面安装包在 Studio 设置中提供 CLI 安装与卸载。安装成功后，新的终端会话中应能
直接执行：

```bash
dreamskin --version
dreamskin targets
```

安装包内的 CLI 使用 DreamSkin Studio 自带的运行环境，不要求用户另外安装 Node.js，也
不需要启动常驻服务。若 Studio 提示安装目录尚未加入 `PATH`，应先按界面显示的目录更新
终端环境，再让 Agent 调用命令。

从源码开发时可以直接运行：

```bash
node ./bin/dreamskin.mjs targets
```

## 命令契约

```text
dreamskin targets
dreamskin theme inspect --plugin <pluginId>
dreamskin theme list --plugin <pluginId>
dreamskin theme read <themeId> --plugin <pluginId>
dreamskin theme create <themeId> --plugin <pluginId> --input <json|@file|-> [--source <templateId>] [--dry-run]
dreamskin theme update <themeId> --plugin <pluginId> --expected-revision <sha256> --input <json|@file|-> [--dry-run]
dreamskin theme asset import <themeId> --plugin <pluginId> --expected-revision <sha256> --file <png|jpg|jpeg|webp> [--dry-run]
dreamskin theme validate <themeId> --plugin <pluginId>
dreamskin theme validate --plugin <pluginId> --input <json|@file|->
```

| 命令 | 用途 | 是否写入主题库 |
| --- | --- | --- |
| `targets` | 返回可用目标与 plugin id。 | 否 |
| `theme inspect` | 返回目标能力、schema、空白源和模板摘要。 | 否 |
| `theme list` | 列出目标下的本地主题及 revision。 | 否 |
| `theme read` | 读取指定主题的结构化内容与当前 revision。 | 否 |
| `theme create` | 从空白源或指定模板创建主题；`--dry-run` 只检查结果。 | 是（`--dry-run` 时否） |
| `theme update` | 在 revision 未变化时应用结构化 patch；`--dry-run` 只检查结果。 | 是（`--dry-run` 时否） |
| `theme asset import` | 校验并复制一张背景图到指定主题；`--dry-run` 只检查结果。 | 是（`--dry-run` 时否） |
| `theme validate` | 验证主题库中的主题，或验证一份尚未写入的 JSON。 | 否 |

每条 `theme` 命令都必须显式传入 `--plugin`，不存在默认目标。调用方应先运行
`dreamskin targets`，只使用返回结果中的 plugin id。

`--input` 接受三种来源：

- 直接传入 JSON 对象文本；
- `@/absolute/path/theme.json` 读取文件；
- `-` 从标准输入读取。

输入必须是 JSON 对象，大小上限为 1 MiB。CLI 拒绝未知参数、重复参数和不属于当前命令的
参数，避免 Agent 的拼写错误被悄悄忽略。

## 推荐 Agent 工作流

1. 运行 `dreamskin targets`，选择用户指定的目标。
2. 运行 `theme inspect`，理解目标的 schema、组件能力和可用模板。
3. 运行 `theme list`，定位用户指定的主题；不要猜测 theme id。
4. 运行 `theme read`，取得完整主题和 revision。
5. 先用 `theme update ... --dry-run` 检查 patch。
6. 使用第 4 步返回的 revision 执行正式 `theme update`。
7. 运行 `theme validate <themeId>`，将结果交还用户。
8. 告知用户在 Studio 中查看预览并自行决定是否应用。

创建新主题时，将第 4 至第 6 步替换为 `theme create`。如果用户指定模板，先从
`theme inspect` 返回的模板列表取得真实 source id，再通过 `--source` 传入。若用户要求从
零开始，则省略 `--source`，也可以显式传入 `--source blank`。模板创建会继承源模板的完整
颜色、状态、视觉规则和背景，只用 `--input` 中的字段覆盖它；来源信息会随主题持久保存。
已存在的 theme id 会返回 `THEME_ALREADY_EXISTS`，Agent 应另选 id，而不是覆盖已有主题。

需要生成或替换背景时，先读取主题取得最新 revision，再运行：

```bash
dreamskin theme asset import <themeId> --plugin <pluginId> \
  --expected-revision <revision> --file /absolute/path/background.png --dry-run
```

确认后去掉 `--dry-run`。该命令只接受 PNG、JPEG 或 WebP 普通文件，拒绝符号链接，限制为
16 MiB，并校验扩展名与文件签名。图片会复制进 DreamSkin 管理的主题目录。导入会产生新
revision，后续结构化更新必须重新读取。

更新必须携带读取结果中的 `--expected-revision`。如果返回 `REVISION_CONFLICT`，Agent 应重新
读取主题，基于新内容重做 patch，而不是重试旧 revision。

## JSON 输出

每次调用只向 stdout 写入一个 JSON v1 envelope。成功退出码为 `0`，失败退出码为 `1`。

成功示例：

```json
{
  "protocolVersion": 1,
  "ok": true,
  "operation": "theme.read",
  "scope": {
    "pluginId": "dreamskin.trae",
    "themeId": "example-theme"
  },
  "result": {}
}
```

失败示例：

```json
{
  "protocolVersion": 1,
  "ok": false,
  "operation": "theme.update",
  "scope": {
    "pluginId": "dreamskin.trae",
    "themeId": "example-theme"
  },
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The theme changed since it was read.",
    "details": {
      "expectedRevision": "old",
      "actualRevision": "new"
    }
  }
}
```

Agent 应依据 `ok`、退出码和稳定的 `error.code` 分支，不应解析自然语言错误文本。错误 envelope
不包含堆栈或内部 cause。

## 数据与并发安全

- Trae 与 WorkBuddy 使用彼此隔离的主题、锁和备份目录。
- `create` 与 `update` 会先构建并验证完整结果，再原子替换主题。
- `update` 必须通过 optimistic revision 检查，防止覆盖 Studio 或另一 Agent 的新修改。
- theme id 不能越出主题目录；背景路径只在显式 `theme asset import` 中读取并复制入库。
- 图片必须是非符号链接普通文件，并有格式、大小与签名校验；结构化颜色拒绝可执行 CSS 值。
- v1 不接受原始 CSS，也不开放目标应用的命令执行接口。
- `--plugin` 和 theme id 会出现在输出 scope 中，便于调用方确认修改边界。

## Studio 交接原则

CLI 写入成功不代表主题已经应用。Agent 完成 create/update/validate 后应停止，并提醒用户回到
Studio 检查首页、对话页和组件状态。只有用户在 Studio 中明确点击应用，主题才会进入目标
应用；恢复原生界面也遵循相同的用户确认边界。

关闭 Studio 不会回滚已经应用的主题。用户需要恢复时，应重新打开 Studio 并执行恢复操作。
