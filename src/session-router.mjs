/**
 * 上游 sessionId 计算，对齐主流开源实现：
 *  - CLIProxyAPI (sdk/cliproxy/session/info.go)：优先使用客户端自带的会话标识；
 *    子代理（agent id 非 main）单独一个会话，避免与主对话互相覆盖缓存。
 *  - CLIProxyAPI / gcli2api / AIClient2API：没有客户端标识时，sha256(首条用户消息文本) 取 63 位，格式 "-<数字>"。
 *  - Antigravity-Manager (proxy/common/session.rs)：上游按 sessionId 累积输入，超过 1,048,576 token
 *    后该会话每次都报 400，此时把该会话的"代数"加一，换一个新 sessionId。
 */
import crypto from 'crypto';

function toSid(seed) {
  const d = crypto.createHash('sha256').update(seed, 'utf8').digest();
  return '-' + (d.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
}

function firstUserText(anthropicRequest) {
  const first = (anthropicRequest.messages || []).find(m => m.role === 'user');
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  if (Array.isArray(first.content)) {
    const t = first.content.find(c => c.type === 'text' && c.text);
    return t ? t.text : '';
  }
  return '';
}

const pick = (h, ...names) => {
  for (const n of names) {
    const v = h[n.toLowerCase()];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  }
  return '';
};

/**
 * 从请求头 / 请求体提取客户端会话标识（顺序同 CLIProxyAPI）。返回 '' 表示客户端没带。
 */
export function clientSessionKey(headers = {}, body = {}) {
  let sid = pick(headers, 'x-claude-code-session-id');
  if (!sid) {
    // Claude Code: metadata.user_id 形如 "user_<hash>_account_<uuid>_session_<uuid>"
    const uid = String(body?.metadata?.user_id || '');
    const m = uid.match(/session_([0-9a-f-]{8,})/i);
    if (m) sid = m[1];
  }
  if (!sid) sid = pick(headers, 'session-id', 'session_id', 'x-http-session-id', 'x-session-id', 'x-session-affinity',
    'x-conversation-id', 'x-thread-id');
  if (!sid) {
    const b = body || {};
    sid = String(b.session_id || b.sessionId || b.conversation_id || b.metadata?.session_id || b.metadata?.conversation_id || '').trim().slice(0, 200);
  }
  if (!sid) return '';
  // 保持主会话前缀共享：子代理继承父会话的同一 sessionId，确保长上下文缓存能被所有并发子任务共同命中
  return `client:${sid}`;
}

const generations = new Map(); // key -> generation
const keyOf = (email, base) => `${email || ''}|${base}`;

/**
 * 识别是否是旁路/辅助请求（如标题生成、上下文压缩、单步探测等），避免污染主对话缓存
 */
function isAuxiliaryRequest(req) {
  if (!req || !Array.isArray(req.messages) || req.messages.length === 0) return false;
  // 只有真正简短的探活/标题生成请求（<= 2 条消息）才作为旁路隔离；长对话中的总结/压缩必须保持主会话，以复用已有长缓存
  if (req.messages.length <= 2) {
    if (req.max_tokens && req.max_tokens <= 100) return true;
    const last = req.messages[req.messages.length - 1];
    let text = '';
    if (typeof last?.content === 'string') text = last.content;
    else if (Array.isArray(last?.content)) {
      text = last.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
    }
    return /^(title|generate title|quick check)\b/i.test(text.trim());
  }
  return false;
}

/** 计算本次请求的 sessionId。anthropicRequest._gwSessionKey 由 server 预先填入（客户端标识）。 */
export function resolveSessionId(anthropicRequest, email = '') {
  const clientKey = anthropicRequest._gwSessionKey || '';
  let base = clientKey ? toSid(clientKey) : toSid(firstUserText(anthropicRequest) || JSON.stringify(anthropicRequest.system || ''));
  // 旁路请求强制使用独立分支 sessionId，避免和主会话互相覆盖上游缓存
  if (isAuxiliaryRequest(anthropicRequest)) {
    base = toSid(`${base}:aux`);
  }
  const gen = generations.get(keyOf(email, base)) || 0;
  return gen === 0 ? base : toSid(`${base}|gen|${gen}`);
}

/** 上游报"输入超过 1048576 token"时调用：该会话换新一代 ID。返回是否需要重试。 */
export function bumpSessionOnOverflow(anthropicRequest, email, errorText) {
  if (!/exceeds the maximum number of tokens allowed/i.test(String(errorText || ''))) return false;
  const clientKey = anthropicRequest._gwSessionKey || '';
  const base = clientKey ? toSid(clientKey) : toSid(firstUserText(anthropicRequest) || JSON.stringify(anthropicRequest.system || ''));
  const k = keyOf(email, base);
  generations.set(k, (generations.get(k) || 0) + 1);
  return true;
}

export function sessionStats() {
  return { bumped: generations.size, toolsPinned: toolPins.size, toolPinRestored: toolPinHits };
}

/**
 * 工具定义锁定：同一会话里，客户端有时会微调工具描述里的动态文字（参数结构不变），
 * 这会让 tools 哈希变化、整段前缀失效。参数结构相同则沿用第一次的描述，保护 Google 隐式缓存。
 */
const TTL_MS = 6 * 60 * 60 * 1000;
const toolPins = new Map(); // key -> { desc, params, exp }
let toolPinHits = 0;

export function pinToolDescriptions(convKey, functionDeclarations) {
  if (process.env.TOOL_PIN === '0' || !Array.isArray(functionDeclarations)) return functionDeclarations;
  const now = Date.now();
  return functionDeclarations.map(fd => {
    const key = convKey + ':' + fd.name;
    const params = JSON.stringify(fd.parameters || {});
    const old = toolPins.get(key);
    if (old && old.exp > now && old.params === params) {
      old.exp = now + TTL_MS;
      if (old.desc !== fd.description) {
        toolPinHits++;
        return { ...fd, description: old.desc };
      }
      return fd;
    }
    toolPins.delete(key);
    toolPins.set(key, { desc: fd.description, params, exp: now + TTL_MS });
    while (toolPins.size > 5000) toolPins.delete(toolPins.keys().next().value);
    return fd;
  });
}

