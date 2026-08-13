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
import { randomUUID } from 'node:crypto';

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
  ack: z.boolean().default(true),
  markdown: z.boolean().default(true),
  perSourceSessions: z.boolean().default(false),
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

  function sessionState(sid) {
    let s = sessions.get(sid);
    if (!s) {
      s = { turnBuffer: [], inTurn: false, turnCtxQueue: [] };
      sessions.set(sid, s);
    }
    return s;
  }
  // 某会话的回复目标：按来源模式查来源的最近消息，单会话模式用全局 lastCtx
  function sourceCtxFor(sid) {
    const key = sessionToSource.get(sid);
    if (key) {
      const c = sourceLastCtx.get(key);
      if (c) return c;
    }
    return lastCtx ?? {};
  }
  // 为来源解析/创建会话（按来源模式）
  async function sessionForSource(sourceKey) {
    const known = sourceToSession.get(sourceKey);
    if (known) return known;
    const created = await rpc('session.create', {});
    const sid = created.sessionId;
    sourceToSession.set(sourceKey, sid);
    sessionToSource.set(sid, sourceKey);
    saveSourceMap();
    log(`new session for source ${sourceKey}: ${sid}`);
    return sid;
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
  async function ensureToken() {
    if (!accessToken || Date.now() > accessTokenExpiry) await refreshToken();
  }
  function identifyPayload() {
    return {
      op: 2,
      d: {
        token: config.token || `QQBot ${accessToken}`,
        intents: 1 << 25,
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
    const refMsgId = c.refMsgId ?? lastCtx?.refMsgId;   // 引用回复：挂到被回答的那条消息下
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
              ...(withId ? { msg_id: msgId, msg_seq: nextMsgSeq(msgId) } : {}),
              ...(i === 0 && refMsgId ? { message_reference: { message_id: refMsgId } } : {}),
            }
          : {
              content: part,
              msg_type: 0,
              ...(withId ? { msg_id: msgId } : {}),
              ...(i === 0 && refMsgId ? { message_reference: { message_id: refMsgId } } : {}),
            };
        let res = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `QQBot ${accessToken}` },
          body: JSON.stringify(bodyFor(asMarkdown, useMsgId)),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const errText = await res.text();
          const isDedup = errText.includes('40054005') || errText.includes('msgseq');
          if (useMsgId && isDedup) {
            log(`msg_id ${msgId} rejected (dedup), retrying as active message`);
            useMsgId = false;
            res = await fetch(target, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `QQBot ${accessToken}` },
              body: JSON.stringify(bodyFor(asMarkdown, false)),
              signal: AbortSignal.timeout(15000),
            });
          } else if (asMarkdown) {
            log(`markdown rejected (HTTP ${res.status}), falling back to plain text`);
            res = await fetch(target, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `QQBot ${accessToken}` },
              body: JSON.stringify(bodyFor(false, false)),
              signal: AbortSignal.timeout(15000),
            });
          }
        }
        if (!res.ok) {
          log(`send message failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
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

  function tryAnswerPending(text) {
    const t = String(text).trim();
    let m = t.match(/^(同意|允许|批准|approve|拒绝|驳回|reject)(?:\s*#?\s*(\d{1,2}))?$/i);
    if (m) {
      if (approvalOrder.length === 0) return { reply: '⚠️ 当前没有待处理的审批。' };
      const allow = /^(同意|允许|批准|approve)$/i.test(m[1]);
      const n = m[2] ? Number(m[2]) : 1;
      if (n < 1 || n > approvalOrder.length) return { reply: `⚠️ 审批编号范围 1-${approvalOrder.length}。` };
      const rpcId = approvalOrder[n - 1];
      const entry = pendingApprovals.get(rpcId);
      respondRpc(rpcId, {
        sessionId: entry.sessionId,
        approvalId: entry.approvalId,
        outcome: allow ? 'allowed-once' : 'rejected',
      });
      return { reply: `已提交审批 #${n}：${allow ? '同意 ✅' : '拒绝 ❌'}` };
    }
    m = t.match(/^(\d{1,2})$/);
    if (m && questionOrder.length > 0) {
      const key = questionOrder[questionOrder.length - 1];
      const entry = pendingQuestions.get(key);
      if (!entry || entry.questions.length !== 1) return null;
      const q = entry.questions[0];
      const idx = Number(m[1]) - 1;
      if (!Array.isArray(q?.options) || idx < 0 || idx >= q.options.length) {
        return { reply: `⚠️ 选项范围 1-${q?.options?.length ?? 0}。` };
      }
      respondRpc(key, {
        sessionId: entry.sessionId,
        answer: { answers: [{ id: q.id, selected: [q.options[idx].id] }] },
      });
      return { reply: `已选择 ${idx + 1}) ${q.options[idx].label ?? q.options[idx].id} ✅` };
    }
    return null;
  }

  // ---- DSH 事件帧处理 ----
  function eventText(event) {
    const blocks = event?.data?.message?.content ?? [];
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }

  function handleFrame(frame) {
    const p = frame?.payload;
    if (!p) return;
    if (p.type === 'approval/requested' && sessions.has(p.sessionId)) {
      if (pendingApprovals.has(frame.rpcId)) return;
      pendingApprovals.set(frame.rpcId, {
        sessionId: p.sessionId, approvalId: p.approvalId,
        toolName: p.toolName, reason: p.reason,
      });
      approvalOrder.push(frame.rpcId);
      const n = approvalOrder.length;
      const what = [p.toolName, p.reason].filter(Boolean).join('：');
      sendText(`🔐 需要审批 #${n}：${what}\n回复「同意」批准 /「拒绝」驳回（可带编号，如：同意${n}）`, sourceCtxFor(p.sessionId));
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
    if (p.type === 'question/requested') {
      if (pendingQuestions.has(frame.rpcId)) return;
      pendingQuestions.set(frame.rpcId, { sessionId: p.sessionId, questions: p.questions });
      questionOrder.push(frame.rpcId);
      const q = p.questions?.[0];
      if (p.questions?.length === 1 && q?.options?.length) {
        const opts = q.options.map((o, i) => `${i + 1}) ${o.label ?? o.id}`).join('\n');
        sendText(`❓ 提问（#${questionOrder.length}）：${q.title}\n${opts}\n回复数字选择（如：1）`, sourceCtxFor(p.sessionId));
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
    if (ev.type === 'turn/start') { st.turnBuffer = []; st.inTurn = true; return; }
    if (ev.type === 'turn/end') {
      st.inTurn = false;
      const reply = st.turnBuffer.join('').trim();
      st.turnBuffer = [];
      const c = st.turnCtxQueue.shift() ?? sourceCtxFor(p.sessionId);
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
            handleFrame(frame);
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
    } else if (t === 'READY') {
      log(`QQ READY: bot=${d?.user?.username ?? '?'} (openid=${d?.user?.id ?? '?'})`);
      return;
    } else {
      // 记录一切未处理的事件类型，便于诊断群事件缺失问题
      log(`unhandled QQ dispatch: ${t} ${JSON.stringify(d ?? {}).slice(0, 160)}`);
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
    sourceLastCtx.set(sourceKey, c);
    lastCtx = c;
    const answer = tryAnswerPending(text);
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
        const i = turnCtxQueue.indexOf(turnCtx);
        if (i !== -1) turnCtxQueue.splice(i, 1);
        saveTurnCtxQueue(turnCtxQueue);
        sendText(`❌ 消息发送失败：${err.message}`, turnCtx);
      });
  }

  // 下载 QQ 附件图片并转成 DSH image 内容块（超 8MB 或非白名单格式跳过并提示）
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

  async function connectQQ() {
    while (!disposed.flag) {
      try {
        await ensureToken();
        gatewayWs = new WebSocket(config.gatewayUrl);
        await new Promise((resolve, reject) => {
          gatewayWs.onopen = () => {
            log('QQ gateway connected, sending IDENTIFY');
            gatewayWs.send(JSON.stringify(identifyPayload()));
            resolve();
          };
          gatewayWs.onerror = () => reject(new Error('websocket connect error'));
          gatewayWs.onmessage = (evt) => {
            let msg;
            try { msg = JSON.parse(String(evt.data)); } catch { return; }
            if (msg.s != null) lastSeq = msg.s;
            if (msg.op === 10) {
              const interval = Number(msg.d?.heartbeat_interval) || 41250;
              clearInterval(heartbeatTimer);
              heartbeatTimer = setInterval(() => {
                if (gatewayWs && gatewayWs.readyState === 1) gatewayWs.send(JSON.stringify({ op: 1, d: lastSeq }));
              }, interval);
              log(`QQ gateway ready (heartbeat ${interval}ms)`);
            } else if (msg.op === 0 && msg.t) {
              handleQQDispatch(msg.t, msg.d);
            } else if (msg.op === 9) {
              log('QQ INVALID_SESSION, re-identifying');
              gatewayWs.send(JSON.stringify(identifyPayload()));
            } else if (msg.op === 7) {
              log('QQ server asked to reconnect');
              gatewayWs.close();
            }
          };
        });
        log('QQ gateway session established');
        await new Promise((resolve) => { gatewayWs.onclose = () => resolve(); });
        clearInterval(heartbeatTimer);
        log('QQ gateway closed; reconnecting in 5s');
      } catch (err) {
        log(`QQ connect failed: ${err.message}; retrying in 5s`);
      }
      if (!disposed.flag) await sleep(5000);
    }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---- 启动 ----
  (async () => {
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
              log(`bridge up: QQ -> DSH session ${targetSessionId}${config.perSourceSessions ? ' (per-source sessions)' : ''}`);
              startEventStream();
              connectQQ();
            }
          }
        } catch { /* keep waiting */ }
      }, 10000);
      return;
    }
    sessionState(targetSessionId);
    log(`bridge up: QQ -> DSH session ${targetSessionId}${config.perSourceSessions ? ' (per-source sessions)' : ''}`);
    startEventStream();
    connectQQ();
  })();

  // ---- 回收 ----
  return () => {
    disposed.flag = true;
    clearInterval(heartbeatTimer);
    try { gatewayWs?.close(); } catch { /* ignore */ }
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    log('channel disposed');
  };
}
