/**
 * 历史锁定：部分客户端会在后续请求中改写旧的工具调用参数/工具结果（裁剪、去重、"[内容已清除]"）。
 * 这会让请求前缀与上游已缓存的版本不一致，导致隐式缓存从改写处整段失效。
 * 这里按 tool call id 记住第一次见到的内容，之后同一 id 一律按原样转发，保证前缀稳定。
 * 开启：环境变量 HISTORY_PIN=1（默认关闭）
 */
const ENABLED = process.env.HISTORY_PIN !== '0'; // 默认开启：锁定同一工具调用的原始输出，防止客户端截断导致前缀缓存击穿
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 150 * 1024 * 1024;

class HistoryPin {
  constructor() { this.map = new Map(); this.bytes = 0; this.hits = 0; this.active = true; }

  pin(key, value) {
    if (!ENABLED || !this.active || !key) return value;
    const now = Date.now();
    const old = this.map.get(key);
    if (old && old.exp > now) {
      old.exp = now + TTL_MS;
      if (old.json !== JSON.stringify(value)) this.hits++;
      return JSON.parse(old.json);
    }
    const json = JSON.stringify(value);
    if (old) this.bytes -= old.json.length;
    this.map.delete(key);
    this.map.set(key, { json, exp: now + TTL_MS });
    this.bytes += json.length;
    this.evict(now);
    return value;
  }

  evict(now) {
    for (const [k, v] of this.map) {
      if (this.bytes <= MAX_BYTES && v.exp > now) break;
      this.map.delete(k); this.bytes -= v.json.length;
    }
  }

  stats() { return { enabled: ENABLED, entries: this.map.size, bytes: this.bytes, restored: this.hits }; }
}

export const historyPin = new HistoryPin();
