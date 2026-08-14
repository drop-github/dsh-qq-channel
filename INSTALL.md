# dsh-qq-channel 安装教程

把 QQ 官方机器人接进 DeepSeek Harness（DSH），用手机 QQ 遥控你电脑上的 AI。全程约 15 分钟。

## 一、前置条件

- 电脑上已装好 **DSH**，能正常启动 `dsh web`（Web GUI 默认 http://127.0.0.1:3080）
- Node.js 20+（DSH 依赖，一般已装）
- 一个 QQ 号（机器人用，私域模式免上架，个人可申请）

## 二、QQ 侧：创建机器人（一次性，约 10 分钟）

1. 打开 https://q.qq.com ，QQ 扫码登录，进入「开发者 → 机器人管理」
2. 创建机器人（选**私域机器人**，个人可申请、免上架）
3. 在开发设置里记录三样东西：
   - **AppID**（机器人 AppID，一串数字）
   - **AppSecret**（机器人密钥，注意保密）
   - **Token**（可选，控制台「机器人 Token」）
4. 用你的 QQ 把机器人**加为好友**（私聊模式），或**拉进群**（群聊模式）

## 三、安装插件

```bash
# GitHub 安装（推荐，零门槛）
dsh plugin --profile web add github:drop-github/dsh-qq-channel
```

npm 通道发布后也可以：

```bash
dsh plugin --profile web add dsh-qq-channel
```

## 四、配置

打开 DSH Web（http://127.0.0.1:3080）→ **设置 → 插件 → qq-channel** 卡片：

| 字段 | 说明 |
| --- | --- |
| enabled | 总开关（默认开） |
| appId | 机器人 AppID（数字或字符串都行） |
| clientSecret | 机器人 AppSecret（自动脱敏显示） |
| token | 可选，机器人 Token |
| sessionId | 留空 = 自动用最近活跃会话；填 id = 固定会话 |
| allowedUsers | 私聊白名单（用户 openid），留空 = 全部放行 |
| allowedGroups | 群白名单（群 openid），留空 = 所有群 |
| groupMembers | 群成员白名单（member_openid），防会话爆炸 |
| ack | 收到消息先回「已收到 ✅」（默认开） |
| markdown | 回复用 QQ Markdown 渲染（默认开） |
| perSourceSessions | 每个人/来源一个独立会话 |
| keyboardApprovals | 审批变成 QQ 键盘按钮，直接点按 |
| maxChunk / maxReplyChunks | 长回复分块阈值 / 最多块数 |

### 怎么拿到自己的 openid？

1. 先把 `allowedUsers` 留空（全部放行），保存
2. 手机 QQ 私聊机器人，随便发句话
3. 打开日志 `C:\Users\<你>\.dsh\storages\qq-channel.log`（macOS/Linux 为 `~/.dsh/storages/qq-channel.log`），找到 `QQ message C2C_MESSAGE_CREATE ... by <openid>`，`by` 后面的就是你的 openid
4. 填进 `allowedUsers`，保存（配置热重载，立即生效）

## 五、重启生效

插件**首次安装后**重启一次 `dsh web`（关掉再启动，或用你自己的重启脚本）。之后改任何配置都是热重载，不需要再重启。

## 六、验证

手机 QQ 私聊机器人发「你好」：

- ack 开启时，立刻收到「已收到 ✅ 正在处理…」
- 几秒后收到 AI 正文回复（Markdown 渲染）

## 七、常见问题

| 现象 | 排查 |
| --- | --- |
| 设置里看不到 qq-channel 卡片 | 插件没装上：`dsh plugin --profile web ls` 确认，并重启 dsh web |
| 发消息完全没反应 | ① 看日志有没有收到消息（没有 = 白名单挡了 / 机器人没加成好友）；② 首次安装没重启 |
| 提示 Model does not support image input | 当前模型无视觉。图片已存进收件箱（`storages/qq-channel-inbox/`），换带视觉的模型或让 AI 走 OCR 兜底 |
| 发的文件收不到 | AI→你：把文件放进 `storages/qq-channel-outbox/`；你→AI：QQ 官方接口是否推送附件以平台为准（实测图片/PDF/Word 可到收件箱） |
| 群聊里只有 @ 才理我 | 默认只处理 GROUP_AT_MESSAGE_CREATE；全量群消息需机器人配置 + groupMembers 白名单 |
| 日志在哪 | `~/.dsh/storages/qq-channel.log`（诊断第一入口） |

## 八、进阶玩法

- **审批在 QQ 上点按钮**：打开 `keyboardApprovals`，AI 需要批准的操作会在 QQ 弹出按钮卡片，点按或回数字即可
- **AI 给你发文件**：把文件放进 `~/.dsh/storages/qq-channel-outbox/`，插件每 5 秒扫描一次，自动分片上传发到 owner 私聊（成功移入 `sent/`，失败进 `failed/`）
- **多人群聊按人隔离**：`perSourceSessions` + `groupMembers` 白名单，每个群成员独立会话，互不串台
- **忙时合并**：会话处理中连发的消息自动排队，上一轮结束后合并成一轮一并回答，不会丢消息
