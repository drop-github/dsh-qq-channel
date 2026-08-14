// dsh-qq-channel: QQ 官方机器人通道插件（Cordis 插件）
// 安装：dsh plugin --profile web add dsh-qq-channel
// 配置：DSH Web 设置页「插件」卡片（命名空间 qq-channel），密钥字段自动脱敏
//
// 能力：
//   - 私聊/群 @消息 → 驱动 DSH 会话（POST /api/session.prompt）
//   - 回复以 QQ Markdown（msg_type 2）发送，自动分块、msg_seq、去重降级
//   - 审批/提问在 QQ 上直接确认（同意/拒绝/数字选项 → POST /api/respond）
//   - 断线重连、心跳、消息去重、回复目标落盘（$DSH_HOME/storages）
import z from '@deepseek-ai/schemastery';
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 运行版本标签：package.json version +（link/git 安装时）git commit 前 7 位——
// 重启后看启动日志即可确认加载的是哪个版本。
// import.meta.url 是 lib/index.js，剥两层才到包根目录。
const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function buildVersionTag() {
  let ver = '?';
  try {
    ver = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '?';
  } catch { /* ignore */ }
  let commit = '';
  try {
    const head = fs.readFileSync(path.join(PKG_DIR, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: (.+)$/);
    commit = (m ? fs.readFileSync(path.join(PKG_DIR, '.git', m[1]), 'utf8') : head).trim().slice(0, 7);
  } catch { /* 非 git 安装（npm 包）无 .git */ }
  return `v${ver}${commit ? '+' + commit : ''}`;
}
const VERSION_TAG = buildVersionTag();

export const name = 'qq-channel';

export const Config = z.object({
  enabled: z.boolean().default(true),
  // appId 在 YAML 里常被写成裸数字（如 1905422590），settings 校验类型不符会整体注册失败——
  // 因此接受 string|number 并统一转成字符串。
  appId: z.transform(z.union([z.string(), z.number()]), (v) => String(v)).default(''),
  clientSecret: z.string().role('secret').default(''),
  token: z.string().role('secret').default(''),
  tokenUrl: z.string().default('https://bots.qq.com/app/getAppAccessToken'),
  gatewayUrl: z.string().default('wss://api.sgroup.qq.com/websocket'),
  apiBase: z.string().default('https://api.sgroup.qq.com'),
  sessionId: z.string().default(''),
  allowedGroups: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  // P2-2：群成员白名单（member_openid）。非空时，全量群消息只处理白名单成员的发言，
  // 防止 per-source 模式为群里每个发言者建会话（会话爆炸）。
  groupMembers: z.array(z.string()).default([]),
  ack: z.boolean().default(true),
  markdown: z.boolean().default(true),
  perSourceSessions: z.boolean().default(false),
  keyboardApprovals: z.boolean().default(false),
  maxChunk: z.number().default(2000),
  maxReplyChunks: z.number().default(4),
});

export const inject = [];

// 诊断日志：优先 DSH_HOME，否则兜底 ~/.dsh（宿主可能未传 DSH_HOME 环境变量）
import os from 'node:os';
const LOG_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'storages');
function fileLog(msg) {
  try {
    fs.mkdirSync(LOG_ROOT, { recursive: true });
    fs.appendFileSync(path.join(LOG_ROOT, 'qq-channel.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

export function apply(ctx, config) {
  let stopped = false;
  let dispose = () => {};
  let current = { ...config };
  const logger = ctx.logger;

  const stop = () => {
    dispose();
    dispose = () => {};
  };
  const start = () => {
    stop();
    dispose = runChannel(ctx, { ...current }, logger);
  };

  // 设置命名空间注册失败（如历史存储段与 schema 不符）不应静默杀死插件：
  // 记日志并退回行配置默认值，通道照常可跑。
  try {
    installSettingsSection(ctx, name, Config, config, {
      setSource: (fn) => {
        current = fn();
      },
      onChange: () => {
        if (stopped) return;
        logger.info('qq-channel: config changed, restarting channel');
        start();
      },
    });
  } catch (err) {
    fileLog(`settings section rejected: ${err?.message ?? err}; falling back to row config`);
    logger.warn(`qq-channel: settings section rejected (${err?.message ?? err}); using row config defaults`);
    current = { ...config };
  }

  try {
    if (config.enabled) start();
    else logger.info('qq-channel: disabled (enabled: false)');
  } catch (err) {
    fileLog(`apply/start failed: ${err?.stack ?? err}`);
    logger.error(`qq-channel: start failed: ${err?.stack ?? err}`);
  }

  ctx.effect(() => () => {
    stopped = true;
    stop();
  });
}

// ---------------- 通道主体（与独立桥接同源的逻辑，适配插件生命周期） ----------------
function runChannel(ctx, config, logger) {
  const disposed = { flag: false };
  // 文件日志：统一走 LOG_ROOT（含 DSH_HOME 兜底），宿主控制台不可见时用它诊断
  const log = (msg) => {
    logger.info(`qq-channel: ${msg}`);
    fileLog(msg);
  };

  if (!config.appId || !config.clientSecret) {
    log('未配置 appId/clientSecret —— 请在设置页填写后重启通道');
    return () => {};
  }

  const port = ctx.get('webServer')?.port ?? 3080;
  const dshUrl = `http://127.0.0.1:${port}`;
  const eventsWsUrl = `ws://127.0.0.1:${port}/api/events.mux`;
  const TZ = 'Asia/Shanghai';
  const sockets = new Set();

  // ---- DSH RPC ----
  async function rpc(method, payload, signal) {
    const body = { type: 'client-request', rpcId: randomUUID(), method, payload };
    const res = await fetch(`${dshUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const full = await res.json();
    if (full?.result?.ok !== true) {
      const e = full?.result?.error;
      throw new Error(`rpc ${method} failed: ${e?.message ?? JSON.stringify(full)}`);
    }
    return full.result.value;
  }

  // ---- 会话状态 ----
  // 单会话模式：所有来源共用 targetSessionId（原有行为）
  // 按来源模式（perSourceSessions）：c2c:<openid> / grp:<群openid>:<member_openid> 各映射独立会话
  const TURN_CTX_FILE = path.join(LOG_ROOT, 'qq-channel-turn-ctx.json');
  const CTX_STALE_MS = 10 * 60 * 1000;
  function loadTurnCtxQueue() {
    try {
      const arr = JSON.parse(fs.readFileSync(TURN_CTX_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(arr)) return [];
      return arr.filter((c) => c && typeof c === 'object' && Date.now() - (c.at ?? 0) < CTX_STALE_MS);
    } catch {
      return [];
    }
  }
  function saveTurnCtxQueue(queue) {
    try {
      fs.mkdirSync(LOG_ROOT, { recursive: true });
      fs.writeFileSync(TURN_CTX_FILE, JSON.stringify(queue));
    } catch { /* ignore */ }
  }

  const SOURCES_FILE = path.join(LOG_ROOT, 'qq-channel-sources.json');
  function loadSourceMap() {
    try {
      const obj = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8').replace(/^\uFEFF/, ''));
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }
  function saveSourceMap() {
    try {
      fs.mkdirSync(LOG_ROOT, { recursive: true });
      fs.writeFileSync(SOURCES_FILE, JSON.stringify(Object.fromEntries(sourceToSession)));
    } catch { /* ignore */ }
  }

  // 多实例锁：防止两个 dsh web 实例的插件同时连接同一 QQ bot（互相踢下线、抢消息）
  // 语义：持有者进程存活即锁有效（PID 探测优先，不看时间窗口）；持有者每 30s 刷新 at。
  const LOCK_FILE = path.join(LOG_ROOT, 'qq-channel.lock');
  let lockHeartbeat = null;
  function acquireLock() {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8').replace(/^\uFEFF/, ''));
        if (cur?.pid && cur.pid !== process.pid) {
          try {
            process.kill(cur.pid, 0);   // 仅探测存活
            return false;               // 持有者进程仍存活 → 不抢
          } catch {
            /* pid 不存在 → 锁过期，继续抢占 */
          }
        }
      }
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
      lockHeartbeat = setInterval(() => {
        try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* ignore */ }
      }, 30000);
      return true;
    } catch {
      return true;   // 锁文件不可写时降级为无锁
    }
  }
  function releaseLock() {
    if (lockHeartbeat) { clearInterval(lockHeartbeat); lockHeartbeat = null; }
    try {
      const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (cur?.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
    } catch { /* ignore */ }
  }

  let targetSessionId = '';
  let turnBuffer = [];
  let inTurn = false;
  let turnCtxQueue = loadTurnCtxQueue();   // 单会话模式的全局回复目标队列
  // 按来源模式：来源 -> 会话映射（落盘），以及每会话独立的轮次状态
  const sourceToSession = new Map(Object.entries(loadSourceMap()));
  const sessionToSource = new Map([...sourceToSession].map(([k, v]) => [v, k]));
  const sessions = new Map();              // sessionId -> { turnBuffer, inTurn, turnCtxQueue }
  const sourceLastCtx = new Map();         // sourceKey -> 最近一次消息的回复目标
  const pendingApprovals = new Map();
  const approvalOrder = [];
  const pendingQuestions = new Map();
  const questionOrder = [];
  const usedPassiveMsgIds = new Set();
  const msgSeqByMsgId = new Map();
  // 入站去重：QQ 平台可能重投同一事件（msg_id 相同），300s 窗口防重复触发
  const seenMsgIds = new Set();
  let seenPruneAt = Date.now();
  function isDuplicate(msgId) {
    if (!msgId) return false;
    if (Date.now() - seenPruneAt > 300 * 1000 || seenMsgIds.size > 2000) {
      // P3：300s 窗口 + 2000 条上限；发送侧凭证随窗口一并清理（被动回复窗口同为 5 分钟）
      seenMsgIds.clear();
      usedPassiveMsgIds.clear();
      msgSeqByMsgId.clear();
      seenPruneAt = Date.now();
    }
    if (seenMsgIds.has(msgId)) return true;
    seenMsgIds.add(msgId);
    return false;
  }

  function sessionState(sid) {
    let s = sessions.get(sid);
    if (!s) {
      s = { turnBuffer: [], inTurn: false, claimedCtx: null, turnCtxQueue: [] };
      sessions.set(sid, s);
    }
    return s;
  }
  // 某会话的回复目标：按来源模式查来源的最近消息，单会话模式用全局 lastCtx；
  // 全部落空时（如主会话里 GUI 触发的提问/审批）回退到 owner 私聊，绝不静默丢弃。
  function sourceCtxFor(sid) {
    const key = sessionToSource.get(sid);
    if (key) {
      const c = sourceLastCtx.get(key);
      if (c) return c;
    }
    if (lastCtx) return lastCtx;
    if (config.allowedUsers.length > 0) {
      log('no source ctx for the session — routing notice to owner DM');
      return { userOpenId: config.allowedUsers[0] };
    }
    return {};
  }
  // 为来源解析/创建会话（按来源模式）；in-flight 单飞防并发建重复会话（R4）
  const sourceInFlight = new Map();
  async function sessionForSource(sourceKey) {
    const known = sourceToSession.get(sourceKey);
    if (known) return known;
    const inflight = sourceInFlight.get(sourceKey);
    if (inflight) return inflight;
    const p = (async () => {
      const created = await rpc('session.create', {});
      const sid = created.sessionId;
      sourceToSession.set(sourceKey, sid);
      sessionToSource.set(sid, sourceKey);
      saveSourceMap();
      log(`new session for source ${sourceKey}: ${sid}`);
      return sid;
    })().finally(() => sourceInFlight.delete(sourceKey));
    sourceInFlight.set(sourceKey, p);
    return p;
  }

  // ---- QQ 鉴权/网关 ----
  let accessToken = '';
  let accessTokenExpiry = 0;
  async function refreshToken() {
    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`getAppAccessToken HTTP ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error(`getAppAccessToken: ${JSON.stringify(data).slice(0, 120)}`);
    accessToken = data.access_token;
    accessTokenExpiry = Date.now() + (Number(data.expires_in) - 120) * 1000;
    log('QQ access token refreshed');
  }
  // token 单飞：并发调用共享同一个刷新 Promise，避免令牌过期瞬间打多个刷新请求
  let tokenFlight = null;
  async function ensureToken() {
    if (accessToken && Date.now() <= accessTokenExpiry) return;
    if (!tokenFlight) {
      tokenFlight = refreshToken().finally(() => { tokenFlight = null; });
    }
    return tokenFlight;
  }
  function identifyPayload() {
    return {
      op: 2,
      d: {
        token: config.token || `QQBot ${accessToken}`,
        intents: (1 << 25) | (1 << 26),   // 群+C2C 事件 | INTERACTION（键盘按钮）事件
        shard: [0, 1],
      },
    };
  }

  let gatewayWs = null;
  let lastSeq = null;
  let heartbeatTimer = null;
  let lastCtx = null;

  // ---- QQ Markdown ----
  function toQQMarkdown(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inFence = false;
    let prevWasText = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) { out.push('> ' + line); prevWasText = true; continue; }
      if (line.includes('|') && !/^\s*>\s?/.test(line) && line.trim() !== '') {
        const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        out.push('> ' + cells.join(' | '));
        prevWasText = true;
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push('#'.repeat(Math.min(3, h[1].length)) + ' ' + h[2].trim()); prevWasText = true; continue; }
      if (/^\s*(\*\*\*+|---+)\s*$/.test(line)) { out.push('***'); prevWasText = false; continue; }
      const li = line.match(/^([-*+]|\d+\.)\s+(.*)$/);
      if (li) { if (prevWasText) out.push(''); out.push(line); prevWasText = false; continue; }
      if (/^\s*>\s?/.test(line)) { out.push(line.trim()); prevWasText = true; continue; }
      out.push(line.replace(/`([^`]+)`/g, '$1'));
      prevWasText = line.trim() !== '';
    }
    const fixed = [];
    for (const l of out) {
      if (l === '' && fixed[fixed.length - 1] === '') continue;
      fixed.push(l);
    }
    return fixed.map((l) => (l === '' ? '\u200B' : l)).join('\n').trim();
  }

  function chunkMarkdown(text, max) {
    const blocks = [];
    let cur = [];
    const flush = () => { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } };
    for (const line of text.split('\n')) {
      if (cur.join('\n').length + line.length + 1 > max) flush();
      if (line.length > max) {
        flush();
        let rest = line;
        while (rest.length > max) { blocks.push(rest.slice(0, max)); rest = rest.slice(max); }
        if (rest) blocks.push(rest);
        continue;
      }
      cur.push(line);
    }
    flush();
    return blocks;
  }

  function chunkText(text) {
    const chunks = [];
    let rest = text;
    while (rest.length > 0) { chunks.push(rest.slice(0, config.maxChunk)); rest = rest.slice(config.maxChunk); }
    return chunks;
  }

  function nextMsgSeq(msgId) {
    const n = (msgSeqByMsgId.get(msgId) ?? 0) + 1;
    msgSeqByMsgId.set(msgId, n);
    return n;
  }

  async function sendText(text, c = {}, opts = {}) {
    const group = c.groupOpenId ?? lastCtx?.groupOpenId;
    const user = c.userOpenId ?? lastCtx?.userOpenId;
    const msgId = c.msgId;
    // 引用回复只在群聊使用（私聊一对一无需引用；R6：避免与 msg_id 并用冲突）
    const refMsgId = group ? (c.refMsgId ?? lastCtx?.refMsgId) : '';
    if (!group && !user) return false;
    const target = group
      ? `${config.apiBase}/v2/groups/${group}/messages`
      : `${config.apiBase}/v2/users/${user}/messages`;
    const asMarkdown = !!opts.asMarkdown;
    const chunks = (asMarkdown ? chunkMarkdown(toQQMarkdown(text), config.maxChunk) : chunkText(text))
      .slice(0, config.maxReplyChunks);
    let ok = true;
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i] + (chunks.length > 1 && i < chunks.length - 1 ? ' …' : '');
      let useMsgId = i === 0 && msgId && !usedPassiveMsgIds.has(msgId);
      try {
        await ensureToken();
        const bodyFor = (md, withId) => md
          ? {
              msg_type: 2,
              markdown: { content: part },
              ...(i === 0 && opts.keyboard ? { keyboard: opts.keyboard } : {}),
              ...(withId ? { msg_id: msgId, msg_seq: nextMsgSeq(msgId) } : {}),
              ...(i === 0 && refMsgId ? { message_reference: { message_id: refMsgId } } : {}),
            }
          : {
              content: part,
              msg_type: 0,
              ...(withId ? { msg_id: msgId } : {}),
              ...(i === 0 && refMsgId ? { message_reference: { message_id: refMsgId } } : {}),
            };
        // P1-1 三态重试：429 尊重 Retry-After；5xx 指数退避重试至多 3 次；4xx 不重试
        const postSend = async (bodyObj) => {
          let last = { status: 0, text: '' };
          for (let attempt = 0; attempt < 3; attempt++) {
            const res = await fetch(target, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `QQBot ${accessToken}` },
              body: JSON.stringify(bodyObj),
              signal: AbortSignal.timeout(15000),
            });
            if (res.ok) return res;
            last = { status: res.status, text: await res.text() };
            if (res.status === 429) {
              const ra = Number(res.headers.get('retry-after') ?? 0);
              const wait = Math.min(Math.max(ra, 1), 30) * 1000;
              log(`send 429, honoring retry-after ${wait}ms`);
              await sleep(wait);
              continue;
            }
            if (res.status >= 500) {
              await sleep(1000 * (attempt + 1));
              continue;
            }
            break;
          }
          return { ok: false, status: last.status, text: last.text };
        };
        let res = await postSend(bodyFor(asMarkdown, useMsgId));
        if (!res.ok) {
          const errText = res.text ?? '';
          const isDedup = errText.includes('40054005') || errText.includes('msgseq');
          if (useMsgId && isDedup) {
            log(`msg_id ${msgId} rejected (dedup), retrying as active message`);
            useMsgId = false;
            res = await postSend(bodyFor(asMarkdown, false));
          } else if (asMarkdown) {
            log(`markdown rejected (HTTP ${res.status}), falling back to plain text`);
            res = await postSend(bodyFor(false, false));
          }
        }
        if (!res.ok) {
          log(`send message failed: HTTP ${res.status} ${String(res.text ?? '').slice(0, 160)}`);
          ok = false;
          break;
        }
        if (useMsgId) usedPassiveMsgIds.add(msgId);
        log(`sent to ${group ?? user}${asMarkdown ? ' [md]' : ''}: ${part.slice(0, 60).replace(/\s+/g, ' ')}`);
        await sleep(400);
      } catch (err) {
        log(`send message error: ${err.message}`);
        ok = false;
        break;
      }
    }
    if (chunks.length > config.maxReplyChunks) sendText('（回复过长已截断）', { groupOpenId: group, userOpenId: user });
    return ok;
  }

  // ---- 审批 / 提问应答 ----
  async function respondRpc(rpcId, value) {
    try {
      const res = await fetch(`${dshUrl}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      log(`respond ${String(rpcId).slice(0, 8)}: HTTP ${res.status} ${text.slice(0, 100)}`);
      return res.ok;
    } catch (err) {
      log(`respond error: ${err.message}`);
      return false;
    }
  }

  // 审批键盘（QQ 内嵌键盘）：按钮 data = approve:<approvalId>:<outcome>（对齐 Hermes keyboards.py）
  function approvalKeyboard(approvalId) {
    const btn = (id, label, visited, style, decision) => ({
      id,
      render_data: { label, visited_label: visited, style },
      action: { type: 1, data: `approve:${approvalId}:${decision}`, permission: { type: 2 } },
    });
    return {
      content: {
        rows: [
          {
            buttons: [
              // 按钮 label 纯文字（emoji 疑似导致键盘不渲染）
              btn('ap-allow', '同意', '已同意', 1, 'allowed-once'),
              btn('ap-deny', '拒绝', '已拒绝', 0, 'rejected'),
            ],
          },
        ],
      },
    };
  }

  // 提问键盘：每个选项一个按钮（最多 4 个，label 限 10 字符用数字表示），
  // 按钮 data = question:<rpcId>:<index>（选项在协议里无 id，只能按位置索引）
  function questionKeyboard(rpcId, q) {
    const buttons = q.options.slice(0, 4).map((o, i) => ({
      id: `q-opt-${i + 1}`,
      render_data: { label: String(i + 1), visited_label: `已选${i + 1}`, style: i === 0 ? 1 : 0 },
      action: { type: 1, data: `question:${rpcId}:${i}`, permission: { type: 2 } },
    }));
    return { content: { rows: [{ buttons }] } };
  }

  // R1 鉴权：操作者必须与触发该审批/提问的来源一致（群=member openid，私聊=user openid；
  // 主会话（无来源）的审批只允许 owner 私聊操作）
  function operatorMatches(entry, d) {
    const member = d?.group_member_openid || '';
    const user = d?.user_openid || d?.data?.resolved?.user_id || '';
    const sourceKey = entry?.sourceKey ?? sessionToSource.get(entry?.sessionId) ?? '';
    if (sourceKey) {
      if (sourceKey.startsWith('grp:')) {
        const gid = sourceKey.split(':')[1];
        return !!member && sourceKey === `grp:${gid}:${member}`;
      }
      if (sourceKey.startsWith('c2c:')) {
        return !!user && sourceKey === `c2c:${user}`;
      }
      return false;
    }
    return !!user && config.allowedUsers.includes(user);
  }

  // INTERACTION_CREATE：先 ACK（PUT /interactions/{id}），校验操作者，再回传审批结果
  async function handleInteraction(d) {
    const iid = d?.id;
    if (!iid || isDuplicate(`int:${iid}`)) return;
    const resolved = d?.data?.resolved ?? {};
    const buttonData = String(resolved?.button_data ?? '');
    const operator = d?.group_member_openid || d?.user_openid || resolved?.user_id || '';
    try {
      await ensureToken();
      const ack = await fetch(`${config.apiBase}/interactions/${iid}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `QQBot ${accessToken}` },
        body: JSON.stringify({ code: 0 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!ack.ok) log(`interaction ACK failed: HTTP ${ack.status}`);
    } catch (err) {
      log(`interaction ACK error: ${err.message}`);
    }
    // 提问按钮：question:<rpcId>:<index>（协议里选项无 id，按位置索引；应答 selected 用选项 label）
    const mq = buttonData.match(/^question:(.+):(\d+)$/);
    if (mq) {
      const [, qRpcId, idxStr] = mq;
      const qEntry = pendingQuestions.get(qRpcId);
      if (!qEntry) {
        log(`question ${qRpcId.slice(0, 8)} not pending`);
        return;
      }
      if (!operatorMatches(qEntry, d)) {
        log(`interaction operator ${operator} rejected (R1)`);
        return;
      }
      const q = qEntry.questions?.[0];
      const idx = Number(idxStr);
      const opt = q?.options?.[idx];
      if (!q || !opt) {
        log(`option index ${idx} not found for question ${qRpcId.slice(0, 8)}`);
        return;
      }
      await respondRpc(qRpcId, { sessionId: qEntry.sessionId, answer: { answers: [{ id: q.id, selected: [opt.label] }] } });
      log(`keyboard question: ${qRpcId.slice(0, 8)} -> option ${idx + 1} ${opt.label} (operator ${operator})`);
      return;
    }
    const m = buttonData.match(/^approve:(.+):(allowed-once|rejected)$/);
    if (!m) {
      log(`unrecognized button_data: ${buttonData.slice(0, 80)}`);
      return;
    }
    const [, approvalId, decision] = m;
    let entry = null;
    let rpcId = null;
    for (const [rid, e] of pendingApprovals) {
      if (e.approvalId === approvalId) { entry = e; rpcId = rid; break; }
    }
    if (!entry) {
      log(`approval ${approvalId} not pending`);
      return;
    }
    // R1 操作者校验：必须与触发来源一致
    if (!operatorMatches(entry, d)) {
      log(`interaction operator ${operator} rejected for approval ${approvalId} (R1)`);
      return;
    }
    const outcome = decision === 'allowed-once' ? 'allowed-once' : 'rejected';
    await respondRpc(rpcId, { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome });
    log(`keyboard approval: ${approvalId} -> ${outcome} (operator ${operator})`);
  }

  // R1 文本应答鉴权：回答者来源解析出的会话必须等于条目所属会话；
  // 主会话（无来源）的审批/提问只允许 owner 私聊代答
  function textAnswerAllowed(entry, answerSourceKey) {
    if (!config.perSourceSessions) return true;   // 单会话模式：所有来源共用目标会话
    if (!entry.sourceKey) {
      return answerSourceKey === `c2c:${config.allowedUsers[0] ?? ''}`;
    }
    return sourceToSession.get(answerSourceKey) === entry.sessionId;
  }

  function tryAnswerPending(text, answerSourceKey) {
    const t = String(text).trim();
    let m = t.match(/^(同意|允许|批准|approve|拒绝|驳回|reject)(?:\s*#?\s*(\d{1,2}))?$/i);
    if (m) {
      if (approvalOrder.length === 0) return { reply: '⚠️ 当前没有待处理的审批。' };
      const allow = /^(同意|允许|批准|approve)$/i.test(m[1]);
      const n = m[2] ? Number(m[2]) : 1;
      if (n < 1 || n > approvalOrder.length) return { reply: `⚠️ 审批编号范围 1-${approvalOrder.length}。` };
      const rpcId = approvalOrder[n - 1];
      const entry = pendingApprovals.get(rpcId);
      if (!entry || !textAnswerAllowed(entry, answerSourceKey)) {
        return { reply: '⚠️ 这条审批不是你的会话触发的，不能代答。' };
      }
      respondRpc(rpcId, {
        sessionId: entry.sessionId,
        approvalId: entry.approvalId,
        outcome: allow ? 'allowed-once' : 'rejected',
      });
      return { reply: `已提交审批 #${n}：${allow ? '同意 ✅' : '拒绝 ❌'}` };
    }
    // 提问选择：裸数字=最新提问；`#N 数字`=第 N 个提问
    let qKey = null;
    let optNum = null;
    m = t.match(/^#(\d{1,2})\s+(\d{1,2})$/);
    if (m) {
      const n = Number(m[1]);
      if (n < 1 || n > questionOrder.length) return { reply: `⚠️ 提问编号范围 1-${questionOrder.length}。` };
      qKey = questionOrder[n - 1];
      optNum = Number(m[2]);
    } else {
      m = t.match(/^(\d{1,2})$/);
      if (m && questionOrder.length > 0) {
        qKey = questionOrder[questionOrder.length - 1];
        optNum = Number(m[1]);
      }
    }
    if (!qKey || !optNum) return null;
    const entry = pendingQuestions.get(qKey);
    if (!entry || entry.questions.length !== 1) return null;
    if (!textAnswerAllowed(entry, answerSourceKey)) {
      return { reply: '⚠️ 这条提问不是你的会话发出的，不能代选。' };
    }
    const q = entry.questions[0];
    const idx = optNum - 1;
    if (!Array.isArray(q?.options) || idx < 0 || idx >= q.options.length) {
      return { reply: `⚠️ 选项范围 1-${q?.options?.length ?? 0}。` };
    }
    respondRpc(qKey, {
      sessionId: entry.sessionId,
      answer: { answers: [{ id: q.id, selected: [q.options[idx].label] }] },
    });
    return { reply: `已选择 ${idx + 1}) ${q.options[idx].label} ✅` };
  }

  // ---- DSH 事件帧处理 ----
  function eventText(event) {
    const blocks = event?.data?.message?.content ?? [];
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }

  // 受管会话判定：per-source 模式 = 来源映射里有该会话（含预置的 owner 主会话）；
  // 单会话模式 = 目标会话。其他 AI 的会话不骚扰。
  function managedSession(sid) {
    if (!config.perSourceSessions) return sid === targetSessionId;
    return sessionToSource.has(sid);
  }

  function handleFrame(frame) {
    const p = frame?.payload;
    if (!p) return;
    if (p.type === 'approval/requested' || p.type === 'question/requested' || p.type === 'approval/resolved' || p.type === 'question/resolved') {
      if (!managedSession(p.sessionId)) {
        log(`ignored ${p.type} from unmanaged session ${String(p.sessionId).slice(0, 12)}`);
        return;
      }
      sessionState(p.sessionId);   // 确保轮次状态存在（如预置映射的 owner 主会话）
    }
    if (p.type === 'approval/requested') {
      if (pendingApprovals.has(frame.rpcId)) return;
      pendingApprovals.set(frame.rpcId, {
        sessionId: p.sessionId, approvalId: p.approvalId,
        toolName: p.toolName, reason: p.reason,
        sourceKey: sessionToSource.get(p.sessionId) ?? '',   // 触发来源（主会话审批为空串）
        at: Date.now(),
      });
      approvalOrder.push(frame.rpcId);
      const n = approvalOrder.length;
      const what = [p.toolName, p.reason].filter(Boolean).join('：');
      if (config.keyboardApprovals) {
        // 键盘按钮审批：markdown + 内嵌键盘（同意/拒绝按钮），按钮 data = approve:<approvalId>:<outcome>
        sendText(`🔐 需要审批 #${n}：${what}\n点击下方按钮，或回复「同意 / 拒绝」（可带编号，如：同意${n}）`, sourceCtxFor(p.sessionId), {
          asMarkdown: true,
          keyboard: approvalKeyboard(p.approvalId),
        });
      } else {
        sendText(`🔐 需要审批 #${n}：${what}\n回复「同意」批准 /「拒绝」驳回（可带编号，如：同意${n}）`, sourceCtxFor(p.sessionId));
      }
      return;
    }
    if (p.type === 'approval/resolved') {
      for (const [rpcId, e] of pendingApprovals) {
        if (e.approvalId === p.approvalId) {
          pendingApprovals.delete(rpcId);
          const i = approvalOrder.indexOf(rpcId);
          if (i !== -1) approvalOrder.splice(i, 1);
          break;
        }
      }
      const zh = p.outcome === 'allowed-once' ? '已批准 ✅' : p.outcome === 'rejected' ? '已拒绝 ❌' : p.outcome;
      sendText(`审批已处理：${zh}`, sourceCtxFor(p.sessionId));
      return;
    }
    if (p.type === 'question/resolved') {
      const key = p.questionRpcId;
      if (pendingQuestions.has(key)) {
        pendingQuestions.delete(key);
        const i = questionOrder.indexOf(key);
        if (i !== -1) questionOrder.splice(i, 1);
      }
      log(`question ${String(key).slice(0, 8)} resolved: ${p.outcome}`);
      return;
    }
    if (p.type === 'question/requested') {
      if (pendingQuestions.has(frame.rpcId)) return;
      pendingQuestions.set(frame.rpcId, {
        sessionId: p.sessionId,
        questions: p.questions,
        sourceKey: sessionToSource.get(p.sessionId) ?? '',   // R1 修复：提问条目同样记录来源
        at: Date.now(),
      });
      questionOrder.push(frame.rpcId);
      const q = p.questions?.[0];
      if (p.questions?.length === 1 && q?.options?.length) {
        const opts = q.options.map((o, i) => `${i + 1}) ${o.label ?? o.id}`).join('\n');
        if (config.keyboardApprovals && q.options.length <= 4) {
          sendText(`❓ 提问（#${questionOrder.length}）：${q.question ?? q.title ?? q.id}\n${opts}\n点击按钮或回复数字选择`, sourceCtxFor(p.sessionId), {
            asMarkdown: true,
            keyboard: questionKeyboard(frame.rpcId, q),
          });
        } else {
          sendText(`❓ 提问（#${questionOrder.length}）：${q.question ?? q.title ?? q.id}\n${opts}\n回复数字选择（如：1）`, sourceCtxFor(p.sessionId));
        }
      } else {
        sendText('❓ 会话有提问（多问题/自定义输入），请在电脑 GUI 处理。', sourceCtxFor(p.sessionId));
      }
      return;
    }
    if (p.type !== 'session/event') return;
    const st = sessions.get(p.sessionId);
    if (!st) return;
    const ev = p.event;
    if (!ev) return;
    if (ev.type === 'turn/start') {
      st.turnBuffer = [];
      st.inTurn = true;
      // R3：turn/start 时"认领"队头回复目标，turn/end 用认领的那个，避免多轮/并发错位
      st.claimedCtx = st.turnCtxQueue.shift() ?? null;
      if (st.claimedCtx && !config.perSourceSessions) {
        const i = turnCtxQueue.indexOf(st.claimedCtx);
        if (i !== -1) turnCtxQueue.splice(i, 1);
        saveTurnCtxQueue(turnCtxQueue);
      }
      return;
    }
    if (ev.type === 'turn/end') {
      st.inTurn = false;
      const reply = st.turnBuffer.join('').trim();
      st.turnBuffer = [];
      const c = st.claimedCtx;
      st.claimedCtx = null;
      if (!c) return;   // 非 QQ 触发的轮次，绝不回发
      if (reply) sendText(reply, c, { asMarkdown: config.markdown });
      return;
    }
    if (st.inTurn && ev.type === 'assistant/message') {
      const t = eventText(ev);
      if (t) st.turnBuffer.push(t);
    }
  }

  // ---- DSH 事件流（WebSocket 下行） ----
  async function startEventStream() {
    while (!disposed.flag) {
      try {
        await new Promise((resolve) => {
          const ws = new WebSocket(eventsWsUrl);
          sockets.add(ws);
          ws.onopen = () => log(`event stream connected (session: ${targetSessionId})`);
          ws.onmessage = (evt) => {
            let frame;
            try { frame = JSON.parse(String(evt.data)); } catch { return; }
            try {
              handleFrame(frame);
            } catch (err) {
              log(`handleFrame error: ${err?.stack ?? err}`);
            }
          };
          ws.onerror = () => {};
          ws.onclose = () => { sockets.delete(ws); resolve(); };
        });
      } catch (err) {
        log(`event stream error: ${err.message}`);
      }
      if (!disposed.flag) await sleep(5000);
    }
  }

  // ---- QQ 网关 ----
  // P2-2 群成员门控：groupMembers 非空时仅处理白名单成员的群发言（拒绝日志 1 分钟限流）
  let lastMemberRejectLog = 0;
  function memberAllowed(d) {
    if (config.groupMembers.length === 0) return true;
    const mid = d?.author?.member_openid ?? '';
    if (mid && config.groupMembers.includes(mid)) return true;
    if (Date.now() - lastMemberRejectLog > 60000) {
      lastMemberRejectLog = Date.now();
      log(`group member ${mid || 'unknown'} not in groupMembers — ignored (rate-limited log)`);
    }
    return false;
  }

  function handleQQDispatch(t, d) {
    let c = null;
    let text = '';
    const images = (Array.isArray(d?.attachments) ? d.attachments : []).filter((a) => /^image\//.test(a?.content_type ?? ''));
    const hasImages = images.length > 0;
    if (t === 'GROUP_AT_MESSAGE_CREATE') {
      const group = d?.group_openid;
      if (!group) return;
      if (config.allowedGroups.length > 0 && !config.allowedGroups.includes(group)) {
        log(`ignoring message from unlisted group ${group}`);
        return;
      }
      if (!memberAllowed(d)) return;
      c = { groupOpenId: group, msgId: d?.id };
      text = String(d?.content ?? '').replace(/^\s*@\S+\s*/u, '').trim();
    } else if (t === 'GROUP_MESSAGE_CREATE') {
      // 全量模式群消息（部分机器人配置为接收全部群消息而非仅 @）
      const group = d?.group_openid;
      if (!group) return;
      if (config.allowedGroups.length > 0 && !config.allowedGroups.includes(group)) {
        log(`ignoring message from unlisted group ${group}`);
        return;
      }
      if (!memberAllowed(d)) return;
      c = { groupOpenId: group, msgId: d?.id };
      text = String(d?.content ?? '').replace(/^\s*@\S+\s*/u, '').trim();
    } else if (t === 'C2C_MESSAGE_CREATE') {
      const user = d?.author?.user_openid;
      if (!user) return;
      if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(user)) {
        log(`ignoring message from unlisted user ${user}`);
        return;
      }
      c = { userOpenId: user, msgId: d?.id };
      text = String(d?.content ?? '').trim();
    } else if (t === 'INTERACTION_CREATE') {
      handleInteraction(d);
      return;
    } else if (t === 'READY') {
      gatewaySessionId = d?.session_id ?? gatewaySessionId;
      log(`QQ READY: bot=${d?.user?.username ?? '?'} (openid=${d?.user?.id ?? '?'}, session=${String(gatewaySessionId).slice(0, 12)})`);
      return;
    } else {
      // P2-3：只记事件名，不打印高频事件 payload（防日志爆炸）
      log(`unhandled QQ dispatch: ${t}`);
      return;
    }
    if (!text && !hasImages) return;
    // 来源标识：私聊=用户 openid；群聊=群 openid + 发消息的成员 openid（精确到"谁 @ 的"）
    const memberId = d?.author?.member_openid ?? d?.author?.id ?? 'unknown';
    const sourceKey = c.userOpenId ? `c2c:${c.userOpenId}` : `grp:${c.groupOpenId}:${memberId}`;
    // 引用回复目标：message_scene.ext 里的 msg_idx（QQ 官方"引用"机制）
    let refMsgId = '';
    if (Array.isArray(d?.message_scene?.ext)) {
      for (const item of d.message_scene.ext) {
        const m = String(item).match(/^msg_idx=(.+)$/);
        if (m) { refMsgId = m[1]; break; }
      }
    }
    c = { ...c, refMsgId };
    if (isDuplicate(c.msgId)) {
      log(`duplicate message ${c.msgId}, skipped`);
      return;
    }
    sourceLastCtx.set(sourceKey, c);
    lastCtx = c;
    const answer = tryAnswerPending(text, sourceKey);
    if (answer) {
      log(`QQ answer (${c.groupOpenId ?? c.userOpenId}): ${text.slice(0, 60)} -> ${answer.reply}`);
      sendText(answer.reply, c);
      return;
    }
    log(`QQ message ${t} (${sourceKey}) by ${memberId}: ${text.slice(0, 120)}${hasImages ? ` +${images.length} image(s)` : ''}`);
    const turnCtx = { groupOpenId: c.groupOpenId, userOpenId: c.userOpenId, msgId: c.msgId, refMsgId: c.refMsgId, at: Date.now() };
    // 按来源模式：为来源解析/创建独立会话；单会话模式：全部进主会话
    const resolveSid = config.perSourceSessions
      ? sessionForSource(sourceKey)
      : Promise.resolve(targetSessionId);
    resolveSid
      .then((sid) => {
        const st = sessionState(sid);
        st.turnCtxQueue.push(turnCtx);
        if (!config.perSourceSessions) {
          turnCtxQueue.push(turnCtx);
          saveTurnCtxQueue(turnCtxQueue);
        }
        return prepareContent(text, images).then((content) => rpc('session.prompt', {
          sessionId: sid,
          mode: 'queue',
          content,
          clientTimeZone: TZ,
        }));
      })
      .then((value) => {
        log(`prompt accepted${value?.command?.text ? ` (command: ${value.command.text})` : ''}`);
        if (config.ack) sendText(hasImages ? `已收到 ✅（含 ${images.length} 张图片）正在处理…` : '已收到 ✅ 正在处理…', { groupOpenId: c.groupOpenId, userOpenId: c.userOpenId, refMsgId: c.refMsgId });
      })
      .catch((err) => {
        log(`prompt failed: ${err.message}`);
        // P1-2：同步清理 per-source 会话状态里的残留 ctx，避免被后续 turn/start 误认领
        for (const st of sessions.values()) {
          const j = st.turnCtxQueue.indexOf(turnCtx);
          if (j !== -1) st.turnCtxQueue.splice(j, 1);
        }
        const i = turnCtxQueue.indexOf(turnCtx);
        if (i !== -1) turnCtxQueue.splice(i, 1);
        saveTurnCtxQueue(turnCtxQueue);
        sendText(`❌ 消息发送失败：${err.message}`, turnCtx);
      });
  }

  // 下载 QQ 附件图片并转成 DSH image 内容块（超 8MB 或非白名单格式跳过并提示）
  // P2-1：下载后校验文件魔数，不轻信 content_type 声明
  const MAGIC_SIG = new Map([
    ['image/jpeg', 'ffd8ff'],
    ['image/png', '89504e47'],
    ['image/gif', '474946'],
    ['image/webp', '52494646'],   // RIFF（+偏移 8 处 WEBP）
  ]);
  function magicOk(buf, mediaType) {
    const sig = MAGIC_SIG.get(mediaType);
    if (!sig) return false;
    if (buf.length < 12) return false;
    if (mediaType === 'image/webp') {
      return buf.slice(0, 4).toString('hex') === sig && buf.slice(8, 12).toString('ascii') === 'WEBP';
    }
    return buf.slice(0, sig.length / 2).toString('hex') === sig;
  }

  async function prepareContent(text, attachments) {
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    if (!Array.isArray(attachments) || attachments.length === 0) return parts;
    await ensureToken();
    const allowed = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    for (const a of attachments) {
      const mediaType = a?.content_type;
      if (!allowed.has(mediaType) || !a?.url) continue;
      try {
        const res = await fetch(a.url, {
          headers: { authorization: `QQBot ${accessToken}` },
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`download HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) throw new Error('image too large (>8MB)');
        if (!magicOk(buf, mediaType)) throw new Error(`magic mismatch for ${mediaType}`);
        parts.push({
          type: 'image',
          mediaType,
          data: buf.toString('base64'),
          ...(a.filename ? { name: a.filename } : {}),
        });
        log(`image downloaded: ${a.filename ?? mediaType} ${buf.length} bytes`);
      } catch (err) {
        log(`image download failed: ${err.message}`);
        parts.push({ type: 'text', text: `[图片接收失败：${err.message}]` });
      }
    }
    return parts;
  }

  // ---- 发件箱（agent → QQ 文件/图片）----
  // 把文件放进 $DSH_HOME/storages/qq-channel-outbox/，插件自动分片上传并发送到 owner 私聊；
  // 成功移入 sent/，失败移入 failed/（40093002 日限额、40093001 可重试等语义进日志）。
  const OUTBOX_DIR = path.join(LOG_ROOT, 'qq-channel-outbox');
  const OUTBOX_SENT = path.join(OUTBOX_DIR, 'sent');
  const OUTBOX_FAILED = path.join(OUTBOX_DIR, 'failed');
  const FILE_TYPE_BY_EXT = new Map([
    ['.jpg', 1], ['.jpeg', 1], ['.png', 1], ['.gif', 1], ['.webp', 1],
    ['.mp4', 2], ['.silk', 3],
  ]);
  const outboxTimer = setInterval(() => {
    pollOutbox().catch((e) => log(`outbox poll error: ${e.message}`));
  }, 5000);

  function md5Hex(d) { return createHash('md5').update(d).digest('hex'); }
  function sha1Hex(d) { return createHash('sha1').update(d).digest('hex'); }

  async function sendFileToOwner(filePath, fileName) {
    if (config.allowedUsers.length === 0) throw new Error('no owner openid configured');
    const user = config.allowedUsers[0];
    const buf = fs.readFileSync(filePath);
    const fileType = FILE_TYPE_BY_EXT.get(path.extname(fileName).toLowerCase()) ?? 4;
    await ensureToken();
    const api = async (p, body) => {
      const res = await fetch(`${config.apiBase}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `QQBot ${accessToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.includes('40093002')) throw new Error('daily file quota exceeded (40093002)');
        if (text.includes('40093001')) throw new Error('upload failed, retryable (40093001)');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      }
      return text ? JSON.parse(text) : {};
    };
    const prep = await api(`/v2/users/${user}/upload_prepare`, {
      file_type: fileType,
      file_size: String(buf.length),
      file_name: fileName,
      md5: md5Hex(buf),
      sha1: sha1Hex(buf),
      md5_10m: md5Hex(buf.subarray(0, 10002432)),
    });
    let offset = 0;
    for (const part of prep.parts ?? []) {
      const end = Math.min(buf.length, offset + Number(part.block_size));
      const chunk = buf.subarray(offset, end);
      offset = end;
      const put = await fetch(part.presigned_url, {
        method: 'PUT',
        body: new Blob([chunk]),
        signal: AbortSignal.timeout(300000),
      });
      if (!put.ok) throw new Error(`chunk PUT HTTP ${put.status}`);
      await api(`/v2/users/${user}/upload_part_finish`, {
        upload_id: prep.upload_id,
        part_index: part.index,
        block_size: part.block_size,
        md5: md5Hex(chunk),
      });
    }
    await api(`/v2/users/${user}/files`, {
      file_type: fileType,
      file_name: fileName,
      upload_id: prep.upload_id,
      srv_send_msg: true,
    });
  }

  // 发件箱重试计数（内存态，重启清零）：filename -> attempts
  const outboxAttempts = new Map();
  const OUTBOX_MAX_ATTEMPTS = 3;

  async function pollOutbox() {
    if (config.allowedUsers.length === 0) return;
    let names = [];
    try { names = fs.readdirSync(OUTBOX_DIR); } catch { return; }
    for (const name of names) {
      const file = path.join(OUTBOX_DIR, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      await sleep(1000);   // 等写入完成：1 秒后大小不再变化才处理
      let st2;
      try { st2 = fs.statSync(file); } catch { continue; }
      if (st2.size !== st.size) {
        log(`outbox: ${name} still being written, deferring`);
        continue;
      }
      try {
        await sendFileToOwner(file, name);
        outboxAttempts.delete(name);
        fs.mkdirSync(OUTBOX_SENT, { recursive: true });
        fs.renameSync(file, path.join(OUTBOX_SENT, `${Date.now()}-${name}`));
        log(`outbox: ${name} sent to owner`);
      } catch (err) {
        // 失败分类：永久失败（日限额/超大/其他 4xx）直接进 failed/；
        // 瞬时失败（网络/5xx/429/40093001 可重试）留原目录重试，超过 3 次才放弃
        const permanent = /40093002|too large|HTTP 4\d\d/.test(String(err?.message ?? err));
        const attempts = (outboxAttempts.get(name) ?? 0) + 1;
        outboxAttempts.set(name, attempts);
        if (permanent || attempts >= OUTBOX_MAX_ATTEMPTS) {
          outboxAttempts.delete(name);
          log(`outbox: ${name} permanently failed after ${attempts} attempt(s): ${err.message}`);
          try {
            fs.mkdirSync(OUTBOX_FAILED, { recursive: true });
            fs.renameSync(file, path.join(OUTBOX_FAILED, `${Date.now()}-${name}`));
          } catch { /* ignore */ }
        } else {
          log(`outbox: ${name} attempt ${attempts} failed (transient): ${err.message} — will retry`);
        }
      }
    }
  }

  // ---- QQ 网关（close-code 分类重连 + op6 Resume + 快速断连熔断） ----
  let gatewaySessionId = '';

  function gatewayAuthToken() {
    return config.token || `QQBot ${accessToken}`;
  }

  async function connectQQ() {
    let backoff = 5000;
    let fastFailures = 0;
    while (!disposed.flag) {
      const startAt = Date.now();
      let closeCode = 0;
      try {
        await ensureToken();
        gatewayWs = new WebSocket(config.gatewayUrl);
        await new Promise((resolve, reject) => {
          gatewayWs.onopen = () => {
            // 有 session_id 时优先 Resume（op6），否则全新 Identify（op2）
            if (gatewaySessionId) {
              log(`QQ gateway connected, resuming session ${gatewaySessionId.slice(0, 12)}`);
              gatewayWs.send(JSON.stringify({
                op: 6,
                d: { token: gatewayAuthToken(), session_id: gatewaySessionId, seq: lastSeq ?? 0 },
              }));
            } else {
              log('QQ gateway connected, sending IDENTIFY');
              gatewayWs.send(JSON.stringify(identifyPayload()));
            }
            resolve();
          };
          gatewayWs.onerror = () => reject(new Error('websocket connect error'));
          gatewayWs.onmessage = (evt) => {
            let msg;
            try { msg = JSON.parse(String(evt.data)); } catch { return; }
            try {
              if (msg.s != null) lastSeq = msg.s;
              if (msg.op === 10) {
                // P0-1：心跳取 hello interval 的 80%（官方建议 0.75~0.9 区间），
                // 网络抖动时心跳略迟也不易被判超时（4914）引发无谓重连。
                const interval = Math.round((Number(msg.d?.heartbeat_interval) || 41250) * 0.8);
                clearInterval(heartbeatTimer);
                heartbeatTimer = setInterval(() => {
                  if (gatewayWs && gatewayWs.readyState === 1) gatewayWs.send(JSON.stringify({ op: 1, d: lastSeq }));
                }, interval);
                log(`QQ gateway ready (heartbeat ${interval}ms = 0.8x)`);
              } else if (msg.op === 0 && msg.t) {
                handleQQDispatch(msg.t, msg.d);
              } else if (msg.op === 9) {
                // Resume 被拒/会话失效：清 session 重新 Identify
                log('QQ INVALID_SESSION, re-identifying');
                gatewaySessionId = '';
                gatewayWs.send(JSON.stringify(identifyPayload()));
              } else if (msg.op === 7) {
                log('QQ server asked to reconnect');
                gatewayWs.close();
              }
            } catch (err) {
              log(`gateway message error: ${err?.stack ?? err}`);
            }
          };
        });
        log('QQ gateway session established');
        await new Promise((resolve) => {
          gatewayWs.onclose = (e) => { closeCode = e?.code ?? 1006; resolve(); };
        });
        clearInterval(heartbeatTimer);
      } catch (err) {
        log(`QQ connect failed: ${err.message}`);
      }

      if (disposed.flag) return;
      const lived = Date.now() - startAt;

      // close-code 分类重连表（QQ WS 规范 + Hermes 语义，第二轮 review 修订）
      if (closeCode === 4004) {
        // 鉴权失败：清 token（单飞重取）+ 清 session
        accessToken = '';
        gatewaySessionId = '';
        backoff = 5000;
        log('QQ close 4004: clearing access token and session');
      } else if (closeCode === 4008) {
        // 服务端要求重连：保留 session，下次走 op6 Resume；退避 60s（对齐 Hermes）
        backoff = 60000;
        log('QQ close 4008: reconnect requested — keeping session for op6 Resume, backoff 60s');
      } else if (closeCode === 4009) {
        // 可恢复（QQ 协议注释：4009 is resumable — 保留 session 状态，快速 Resume）
        backoff = 5000;
        log('QQ close 4009: resumable — keeping session for op6 Resume');
      } else if (closeCode === 4003 || closeCode === 4005) {
        // 网关内部错误：强制全新 Identify（清 session，避免误走 Resume）
        gatewaySessionId = '';
        backoff = 1000;
        log(`QQ close ${closeCode}: gateway error, forced fresh Identify`);
      } else if (closeCode === 4006 || closeCode === 4007 || (closeCode >= 4900 && closeCode <= 4913)) {
        // Resume/Identify 失败：清 session 重新 Identify；显式 5s 退避（不继承 4008 的 60s）
        gatewaySessionId = '';
        backoff = 5000;
        log(`QQ close ${closeCode}: resume/identify failed, clearing session (backoff 5s)`);
      } else if ([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(closeCode)) {
        log(`QQ close ${closeCode}: fatal — stopping gateway (restart dsh web to retry)`);
        return;
      } else {
        backoff = 5000;
      }
      // 快速断连熔断：5s 内连断 3 次 → 暂停 60s
      if (lived < 5000) {
        fastFailures += 1;
        if (fastFailures >= 3) {
          log('QQ fast-disconnect x3, pausing 60s');
          await sleep(60000);
          fastFailures = 0;
          continue;
        }
      } else {
        fastFailures = 0;
      }
      log(`QQ gateway closed (code ${closeCode}); reconnecting in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // R2：pending 审批/提问 15 分钟 TTL 清扫（防只进不出导致编号膨胀/旧按钮命中死 rpcId）
  const PENDING_TTL_MS = 15 * 60 * 1000;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [rpcId, e] of pendingApprovals) {
      if (now - (e.at ?? 0) > PENDING_TTL_MS) {
        pendingApprovals.delete(rpcId);
        const i = approvalOrder.indexOf(rpcId);
        if (i !== -1) approvalOrder.splice(i, 1);
        log(`pending approval ${e.approvalId.slice(0, 8)} expired`);
      }
    }
    for (const [rpcId, e] of pendingQuestions) {
      if (now - (e.at ?? 0) > PENDING_TTL_MS) {
        pendingQuestions.delete(rpcId);
        const i = questionOrder.indexOf(rpcId);
        if (i !== -1) questionOrder.splice(i, 1);
        log(`pending question ${rpcId.slice(0, 8)} expired`);
      }
    }
    // P3：来源最近消息缓存随窗口清理（10 分钟）
    if (now - seenPruneAt > 300 * 1000) {
      for (const [k, v] of sourceLastCtx) {
        if (now - (v.at ?? 0) > 10 * 60 * 1000) sourceLastCtx.delete(k);
      }
    }
  }, 60000);

  // 启动日志：明确打印运行版本、生效模式与会话来源，便于多 AI 环境下快速诊断
  function bootLine() {
    const mode = config.perSourceSessions ? 'per-source' : 'single';
    const src = config.sessionId ? 'configured' : 'auto-picked';
    if (mode === 'single' && !config.sessionId) {
      log(`WARNING: single-session mode without a pinned sessionId — QQ messages go to the most recently active session; configure sessionId (or enable perSourceSessions) to avoid hijacking other sessions`);
    }
    return `bridge up: QQ -> DSH session ${targetSessionId} [${VERSION_TAG}, mode=${mode}, src=${src}]`;
  }

  // ---- 启动 ----
  let lockHeld = false;
  (async () => {
    lockHeld = acquireLock();
    if (!lockHeld) {
      log('WARNING: another dsh instance holds the QQ channel lock — this instance will NOT connect to QQ (prevents gateway kick war); restart this instance after the other one exits');
      return;
    }
    try {
      if (config.sessionId) {
        targetSessionId = config.sessionId;
      } else {
        const { items } = await rpc('session.list', {});
        const candidates = items.filter((it) => it.blank !== true).sort((a, b) => b.updatedAt - a.updatedAt);
        const main = candidates.find((it) => it.origin !== 'subagent') ?? candidates[0];
        if (!main) throw new Error('no active DSH session (open the Web GUI once first)');
        targetSessionId = main.sessionId;
      }
    } catch (err) {
      log(`waiting for DSH session: ${err.message}; retrying in 10s`);
      const t = setInterval(async () => {
        if (disposed.flag) { clearInterval(t); return; }
        try {
          if (!targetSessionId) {
            const { items } = await rpc('session.list', {});
            const candidates = items.filter((it) => it.blank !== true).sort((a, b) => b.updatedAt - a.updatedAt);
            const main = candidates.find((it) => it.origin !== 'subagent') ?? candidates[0];
            if (main) {
              targetSessionId = main.sessionId;
              clearInterval(t);
              sessionState(targetSessionId);
              log(bootLine());
              startEventStream();
              connectQQ();
            }
          }
        } catch { /* keep waiting */ }
      }, 10000);
      return;
    }
    sessionState(targetSessionId);
    log(bootLine());
    startEventStream();
    connectQQ();
  })();

  // ---- 回收 ----
  return () => {
    disposed.flag = true;
    clearInterval(heartbeatTimer);
    clearInterval(sweeper);
    clearInterval(outboxTimer);
    try { gatewayWs?.close(); } catch { /* ignore */ }
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    if (lockHeld) releaseLock();
    log('channel disposed');
  };
}
