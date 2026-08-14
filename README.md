# dsh-qq-channel

DeepSeek Harness 的 **QQ 官方机器人通道插件**：装进 web profile 后，用手机 QQ（私聊或群 @机器人）就能驱动你的 DSH 会话，回复以 **QQ Markdown** 渲染，**审批/提问可以直接在 QQ 上确认**。

## 特性

- 私聊（C2C）+ 群 @消息 → 驱动 DSH 会话（复用 host 的 `/api/session.prompt`，回环直连）
- 回复自动转 QQ Markdown（`msg_type 2`）：标题/加粗/列表/引用渲染，代码块与表格转引用样式
- 长回复按块分切、同 msg_id 递增 msg_seq、msg_id 去重自动降级、Markdown 被拒自动降级纯文本
- **审批在 QQ 上确认**：收到「🔐 需要审批 #N」后回复 `同意` / `拒绝`（可带编号），经 `/api/respond` 回传
- **提问在 QQ 上选择**：回复数字（如 `1`）选定选项
- 断线重连、心跳保活、消息事件去重、回复目标落盘（`$DSH_HOME/storages/qq-channel-turn-ctx.json`，10 分钟过期）
- 配置全部走 **settings 命名空间**：DSH Web 的「设置 → 插件」卡片直接填写（密钥字段自动脱敏），改完即热重载

## 安装

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
