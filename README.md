# dsh-qq-channel

DeepSeek Harness 的 **QQ 官方机器人通道插件**：装进 web profile 后，用手机 QQ（私聊或群 @机器人）就能驱动你的 DSH 会话，回复以 **QQ Markdown** 渲染，**审批/提问可以直接在 QQ 上确认**。

## 特性

- 私聊（C2C）+ 群 @消息 → 驱动 DSH 会话（回环直连 host API，**自动适配 DSH 新旧两代 RPC 协议**，见下节）
- 回复自动转 QQ Markdown（`msg_type 2`）：标题/加粗/列表/引用渲染，代码块与表格转引用样式
- 长回复按块分切、同 msg_id 递增 msg_seq、msg_id 去重自动降级、Markdown 被拒自动降级纯文本
- **审批在 QQ 上确认**：收到「🔐 需要审批 #N」后回复 `同意` / `拒绝`（可带编号）——旧版协议经 `/api/respond` 回传；新协议下见「版本兼容性」的说明
- **提问在 QQ 上选择**：回复数字（如 `1`）选定选项
- **忙时合并**（Hermes 语义）：会话忙时连发的消息并入等待队列，上一轮结束后合并成一轮一并回答，不丢不串
- **收件箱（用户 → bot 文件）**：你发来的图片/PDF/Word 等附件自动下载到 `$DSH_HOME/storages/qq-channel-inbox/`；模型无视觉能力时自动降级为纯文本并附上收件箱路径，agent 可走 OCR/元数据/文件解析兜底
- 断线重连、心跳保活、消息事件去重、回复目标落盘（`$DSH_HOME/storages/qq-channel-turn-ctx.json`，10 分钟过期）
- 配置全部走 **settings 命名空间**：DSH Web 的「设置 → 插件」卡片直接填写（密钥字段自动脱敏），改完即热重载

## 版本兼容性

插件启动时会**自动探测** host 的 RPC 协议版本并选择对应通道，无需配置：

| host 版本 | RPC 协议 | 会话事件来源 | 审批/提问 |
| --- | --- | --- | --- |
| DSH ≤ 0.1.1 | `POST /api/session.list`，payload 直传 | WebSocket `/api/events.mux` | ✅ 经 `/api/respond` 在 QQ 内确认 |
| DSH ≥ 0.1.5 | typert 网关：`POST /api/session/list`，payload 包 `{args:{…}}` | `session/page` 轮询（≈1.5s 延迟） | ✅ 经 `$events` 流 + `POST /api/$events/result` 在 QQ 内确认 |

新版 DSH 的三点变化及其应对：

- **`/api` 增加了 browserAuth 鉴权**（无 cookie 一律 401）：插件在 host 进程内通过 `connection.authenticatedUrl()` 取 launch token，换取 Host 绑定的 cookie，401 时自动重认证。
- **`events.mux` 已移除，流式方法（`session/follow`、`session/control`）必须走 `/api/remote.mux` 流载体**：会话事件改用 `session/page` 轮询拉取（含基线防重放、游标自动学习、多会话覆盖），代价是回复推送约 1.5 秒延迟。
- **审批/提问改走 Gateway 内部流 `$events`**（普通 HTTP 调不了流式方法）：插件经 `remote.mux` 开 `$events` 流接收审批/提问请求，结果经 `POST /api/$events/result` 回传。事件名也从 `approval/requested` → `approval/request`、`question/requested` → `user-questions/request`（插件内部已映射，QQ 侧的键盘按钮与编号回复体验不变）。

> 端到端实测（v1.1.0）：越权操作 → 沙箱拒绝 → 提权重试 → host 产生审批 → `$events` 流 → QQ 收到「🔐 需要审批」→ 点「同意」→ 结果回传 → 命令执行，全链路约 5 秒。

> 兼容性目标：新老 host 上都能正常工作。若 host 升级后插件异常，先看 `$DSH_HOME/storages/qq-channel.log`：里面会打印协议探测、鉴权、事件流模式等关键节点。


## 安装

> 详细图文流程见 [INSTALL.md](./INSTALL.md)（含 QQ 侧申请、openid 获取、常见问题排查）。

```bash
# 从 GitHub 安装（推荐，零门槛）
dsh plugin --profile web add github:drop-github/dsh-qq-channel
# 或从本地目录安装：
dsh plugin --profile web add "file:/path/to/dsh-qq-channel"
```

重启 `dsh web` 生效（插件随 profile 层栈自动挂载）。

仓库：https://github.com/drop-github/dsh-qq-channel （欢迎 issue/PR）

## 配置

打开 DSH Web → **设置 → 插件 → qq-channel** 卡片：

| 字段 | 说明 |
| --- | --- |
| enabled | 总开关 |
| appId / clientSecret | 必填，q.qq.com 机器人开发设置里获取 |
| token | 可选，控制台「机器人 Token」 |
| sessionId | 留空 = 自动选最近活跃会话；填 id = 固定会话 |
| allowedGroups / allowedUsers | 白名单（openid），留空 = 全部放行 |
| ack | 收到消息先回「已收到 ✅」 |
| markdown | 回复用 QQ Markdown |
| maxChunk / maxReplyChunks | 分块阈值与上限 |

> QQ 侧准备：q.qq.com 创建机器人（私域模式免上架）→ 拉进你的群或直接私聊。群聊能力以平台当前规则为准。

## 使用

- 私聊机器人或群里 @机器人，正常聊天；
- AI 需要批准时回复 `同意` / `拒绝`（多条审批用 `同意2`）；
- AI 用提问卡片时回复数字选项。

## 开发

```bash
node --check lib/index.js     # 语法检查
dsh plugin --profile web add "file:$(pwd)"   # 本地联调安装
```

## 发布（npm）

```bash
npm login
npm publish --access public
# 社区安装：
dsh plugin --profile web add dsh-qq-channel
```

## License

MIT

## 已知边界

- **轮次认领机制**：回复只在"该轮次由 QQ 消息触发"时回发（turn/start 时认领队头目标）。如果同一会话同时被 GUI 和 QQ 驱动，回复归属由轮次顺序决定——先开始的轮次认领先到的 QQ 目标，不会串发；非 QQ 触发的轮次一律不回发。
- **提问应答**：裸数字 `1` 指向最新提问；`#2 1` 指向第 2 个提问选 1；提问与审批都只能由**触发它的那个来源**应答（群成员/私聊用户/主会话由 owner 私聊），防串扰。

## 收文件（收件箱）

你从 QQ 发给机器人的附件，插件自动下载到 **`$DSH_HOME/storages/qq-channel-inbox/`** 并转交会话：

- 图片（jpg/png/gif/webp ≤8MB）：以 image 内容块发给模型；模型不支持看图时自动降级为纯文本重试，附收件箱路径
- 其他附件（PDF/Word 等，≤20MB，QQ 官方接口若推送）：存盘后以文本注明路径
- agent 侧配合 OCR/文件解析即可读取内容（详见仓库配套工具）

## 发文件/图片到 QQ（发件箱）

把任意文件放进 **`$DSH_HOME/storages/qq-channel-outbox/`**（即 `C:\Users\<你>\.dsh\storages\qq-channel-outbox`），插件每 5 秒扫描一次，自动分片上传并发送到 owner 私聊：
- 图片（jpg/png/gif/webp）、mp4、silk 按媒体类型发送，其余按文件（file_type 4）；
- 成功 → 移入 `sent/`；失败 → 移入 `failed/`（日志区分 40093002 日限额 / 40093001 可重试）。

## 维护注意（踩过的坑）

- **改 `package.json` / 任何 `.json` 时严禁写入 UTF-8 BOM**：DSH 启动时会 `JSON.parse` 该文件，带 BOM 会直接抛错并让 profile 加载失败 → **整个 DSH 起不来**（`dsh-stderr.log` 里表现为 `Unexpected token '﻿'`）。
  - Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` **会写 BOM**，禁止用于本仓库的 JSON/YAML；
  - 请改用 `-Encoding utf8NoBOM`（PowerShell 7+）、`[IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding $false))`，或直接用编辑器/agent 的写文件工具（默认无 BOM）。
  - 自检：`[IO.File]::ReadAllBytes($p)[0..2]` 不应为 `EF BB BF`。
- **审批/提问消息发出后需要 `message_id`**：用户答复时要撤回原消息（否则另一个按钮仍可点），发送路径通过 `sendText(..., { onSent })` 回调回收 id。
