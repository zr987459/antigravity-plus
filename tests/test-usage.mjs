/**
 * Token 记账单元测试：node tests/test-usage.mjs
 * 合成 Gemini SSE / JSON 响应，校验 Anthropic usage 输出与 StatsTracker 统计值。
 */
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { handleStreamConversion } from '../src/sse-streamer.mjs';
import { convertGoogleToAnthropic } from '../src/content-converter.mjs';
import { StatsTracker, migrateBucket } from '../src/stats.mjs';
import { normalizeGeminiUsage } from '../src/usage.mjs';

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓', name); });

function mockRes() {
  const r = new EventEmitter();
  r.out = ''; r.ended = false; r.writableFinished = false; r.headersSent = false;
  r.setHeader = () => {}; r.flushHeaders = () => { r.headersSent = true; };
  r.write = s => { r.out += s; return true; };
  r.end = () => { r.ended = true; r.writableFinished = true; r.emit('close'); };
  return r;
}
function upstream(chunks, { hang = false } = {}) {
  const enc = new TextEncoder();
  let i = 0, cancelled = false, wake = null;
  return {
    body: {
      getReader: () => ({
        read: async () => {
          if (cancelled) return { done: true };
          if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
          if (hang) { await new Promise(res => (wake = res)); return { done: true }; }
          return { done: true };
        },
        cancel: async () => { cancelled = true; wake?.(); },
      }),
    },
  };
}
const sse = obj => `data: ${JSON.stringify({ response: obj })}\n\n`;
const events = out => out.split('\n\n').filter(Boolean).map(b => ({ event: b.match(/^event: (.*)$/m)?.[1], data: JSON.parse(b.match(/^data: (.*)$/m)[1]) }));

// 合成：提示 1000（其中缓存 600），工具回灌 40，输出 120 + 思考 300；usage 在多个 chunk 中累计出现
const geminiStream = [
  sse({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, toolUsePromptTokenCount: 40 } }),
  sse({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, toolUsePromptTokenCount: 40, candidatesTokenCount: 50, thoughtsTokenCount: 300 } }),
  sse({ candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, toolUsePromptTokenCount: 40, candidatesTokenCount: 120, thoughtsTokenCount: 300, totalTokenCount: 1460 } }),
];
// 期望：input = 1000 + 40 - 600 = 440；cached = 600；output = 120 + 300 = 420；total = 1460 = Gemini totalTokenCount
const EXP = { input_tokens: 440, cached_tokens: 600, output_tokens: 420, thoughts_tokens: 300, total_tokens: 1460 };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agstats-'));
const st = new StatsTracker(tmp, { autoFlushOnExit: false });

console.log('usage normalize');
await ok('normalizeGeminiUsage 口径', () => {
  assert.deepEqual(normalizeGeminiUsage({ promptTokenCount: 1000, cachedContentTokenCount: 600, toolUsePromptTokenCount: 40, candidatesTokenCount: 120, thoughtsTokenCount: 300 }), EXP);
  assert.deepEqual(normalizeGeminiUsage(undefined), { input_tokens: 0, cached_tokens: 0, output_tokens: 0, thoughts_tokens: 0, total_tokens: 0 });
  // cached > prompt 的异常数据被夹住，input 不会为负
  assert.equal(normalizeGeminiUsage({ promptTokenCount: 10, cachedContentTokenCount: 50 }).input_tokens, 0);
});

console.log('stream');
await ok('流式 usage：累计值取最终值、含思考、input 不含缓存、onFinish 恰好一次', async () => {
  const res = mockRes(); const calls = [];
  const t0 = Date.now();
  await handleStreamConversion(upstream(geminiStream), res, 'gemini-x', u => calls.push(u), t0);
  assert.equal(calls.length, 1);
  const u = calls[0];
  for (const k of Object.keys(EXP)) assert.equal(u[k], EXP[k], k);
  assert.equal(u.outcome, 'ok');
  assert.ok(u.ttft_ms >= 0);
  const ev = events(res.out);
  const delta = ev.find(e => e.event === 'message_delta').data.usage;
  assert.deepEqual(delta, { input_tokens: 440, output_tokens: 420, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 });
  const start = ev.find(e => e.event === 'message_start').data.message.usage;
  assert.equal(start.input_tokens, 440); assert.equal(start.cache_read_input_tokens, 600);
  assert.equal(ev.at(-1).event, 'message_stop');
  st.recordRequest({ email: 'A@x.com', model: 'gemini-x', latency_ms: 1000, ttft_ms: u.ttft_ms, status: 200, is_stream: true, ...u });
});

await ok('客户端中途断开：停止读上游，按已收到的 usage 记一次，outcome=client_abort', async () => {
  const res = mockRes(); const calls = [];
  const p = handleStreamConversion(upstream(geminiStream.slice(0, 2), { hang: true }), res, 'gemini-x', u => calls.push(u));
  await new Promise(r => setTimeout(r, 20));
  res.emit('close');
  await p;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outcome, 'client_abort');
  assert.equal(calls[0].input_tokens, 440); assert.equal(calls[0].output_tokens, 350);
  assert.ok(!res.out.includes('message_stop'));
});

await ok('上游无内容也输出完整事件序列，usage=0，output 不再伪造为 1', async () => {
  const res = mockRes(); const calls = [];
  await handleStreamConversion(upstream([]), res, 'm', u => calls.push(u));
  const ev = events(res.out).map(e => e.event);
  assert.deepEqual(ev, ['message_start', 'message_delta', 'message_stop']);
  assert.equal(calls[0].output_tokens, 0);
});

console.log('non-stream');
await ok('非流式 usage 与流式一致；_gw_usage 不会序列化给客户端', () => {
  const msg = convertGoogleToAnthropic({ response: { candidates: [{ content: { parts: [{ text: 'hi' }] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, toolUsePromptTokenCount: 40, candidatesTokenCount: 120, thoughtsTokenCount: 300 } } }, 'm');
  assert.deepEqual(msg.usage, { input_tokens: 440, output_tokens: 420, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 });
  assert.deepEqual(msg._gw_usage, EXP);
  assert.ok(!JSON.stringify(msg).includes('_gw_usage'));
  st.recordRequest({ email: 'a@x.com', model: 'm', latency_ms: 3000, status: 200, ...msg._gw_usage });
});

console.log('stats');
await ok('统计：total = input+cached+output，命中率、均值延迟、错误请求、总览 = 各账号之和', () => {
  st.recordRequest({ email: 'b@x.com', model: 'm', latency_ms: 50, status: 429, error: 'quota' });
  st.recordRequest({ email: 'b@x.com', model: 'm', latency_ms: 2000, status: 200, input_tokens: 100, cached_tokens: 0, output_tokens: 10 });
  const a = st.getStats('a@x.com');
  assert.equal(a.total_requests, 2);
  assert.equal(a.input_tokens, 880); assert.equal(a.cached_tokens, 1200); assert.equal(a.output_tokens, 840); assert.equal(a.thoughts_tokens, 600);
  assert.equal(a.total_tokens, 880 + 1200 + 840);
  assert.equal(a.cache_hit_rate, 1200 / 2080);
  assert.equal(a.avg_latency_ms, 2000); // (1000+3000)/2，而不是"最后一次"
  const b = st.getStats('b@x.com');
  assert.equal(b.error_requests, 1); assert.equal(b.success_requests, 1);
  assert.equal(b.avg_latency_ms, 2000); // 429 的 50ms 不计入成功延迟均值
  assert.equal(b.cache_hit_rate, 0);
  const all = st.getStats();
  assert.equal(all.total_requests, 4);
  assert.equal(all.total_tokens, a.total_tokens + b.total_tokens);
  assert.equal(all.cache_hit_rate, 1200 / (2080 + 100));
  assert.equal(all.avg_latency_ms, Math.round((1000 + 3000 + 2000) / 3));
  assert.equal(all.accounts.length, 2);
  assert.equal(all.last_24h.requests, 4);
  assert.equal(all.last_24h.tokens, all.total_tokens);
  const logs = st.getAllLogs();
  assert.equal(logs.find(l => l.tokens.input === 100).tokens.total, 110);
  assert.equal(logs.find(l => l.status === 429).cache_hit_rate, null); // 0 分母 → null
  assert.ok(Object.keys(st.userStats['a@x.com'].hourly)[0].match(/^\d{4}-\d\d-\d\dT\d\d$/)); // UTC key
});

await ok('防抖写盘 + flush 后重启数据一致', () => {
  st.flush();
  const st2 = new StatsTracker(tmp, { autoFlushOnExit: false });
  assert.deepEqual(st2.getStats(), st.getStats());
});

await ok('旧版 user_stats.json 迁移：补字段、重算 total、按日志重建真实均值延迟、小时 key 转 UTC 格式', () => {
  const old = { total_requests: 3, total_tokens: 150, input_tokens: 100, output_tokens: 50, cached_tokens: 400, avg_latency_ms: 999,
    logs: [{ status: 200, latency_ms: 1000, tokens: { input: 50, output: 25, cached: 200 } }, { status: 200, latency_ms: 3000, tokens: { input: 50, output: 25, cached: 200 } }, { status: 502, latency_ms: 10 }],
    hourly: { '2026-10-14 03': { requests: 3, tokens: 150 } }, daily: { '2026-10-14': { requests: 3, tokens: 150 } } };
  const b = migrateBucket(old);
  assert.equal(b.total_tokens, 550); assert.equal(b.avg_latency_ms, 2000); assert.equal(b.error_requests, 1);
  assert.ok(b.hourly['2026-10-14T03']); assert.equal(b.hourly['2026-10-14T03'].cached, 0);
  assert.equal(b.logs[0].cache_hit_rate, 0.8);
  assert.equal(migrateBucket(b), b); // 幂等
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
