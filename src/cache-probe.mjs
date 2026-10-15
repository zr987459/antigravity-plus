/**
 * 缓存诊断：记录每个请求 contents 各段的指纹，找出与之前请求的最长公共前缀，
 * 定位"前缀在哪一段开始变了"（隐式缓存只命中完全相同的前缀）。只存哈希和结构，不存正文。
 */
import crypto from 'crypto';

const h = v => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 10);

function describePart(p) {
  const d = { keys: Object.keys(p).sort().join(',') };
  if (p.thoughtSignature) d.sig = h(p.thoughtSignature);
  if (p.functionCall) { d.fc = p.functionCall.name; d.id = p.functionCall.id; d.args = h(p.functionCall.args || {}); }
  if (p.functionResponse) { d.fr = p.functionResponse.name; d.resp = h(p.functionResponse.response || {}); }
  if (typeof p.text === 'string') { d.len = p.text.length; d.text = h(p.text); }
  return d;
}

class CacheProbe {
  constructor(max = 40) { this.max = max; this.items = []; }

  record(email, model, payload) {
    try {
      const req = payload.request || {};
      const head = h({ sys: req.systemInstruction || null, tools: req.tools || null, tc: req.toolConfig || null });
      const segs = (req.contents || []).map(c => ({ role: c.role, hash: h(c), parts: (c.parts || []).map(describePart) }));
      let best = null;
      for (const prev of this.items) {
        if (prev.email !== email || prev.head !== head) continue;
        let i = 0;
        while (i < prev.segs.length && i < segs.length && prev.segs[i].hash === segs[i].hash) i++;
        if (!best || i > best.match) best = { match: i, prev };
      }
      const entry = { t: Date.now(), email, model, sid: req.sessionId, head, sys: h(req.systemInstruction || null), sysLen: JSON.stringify(req.systemInstruction || '').length, tools: h(req.tools || null), toolNames: ((req.tools || [])[0]?.functionDeclarations || []).map(f => f.name).join(','), n: segs.length, segs };
      if (best) {
        entry.match = best.match;
        entry.vs = best.prev.t;
        if (best.match < best.prev.segs.length && best.match < segs.length) {
          entry.diverge = { index: best.match, now: segs[best.match], before: best.prev.segs[best.match] };
        }
      } else entry.match = null; // system/tools 与之前都不同
      this.items.push(entry);
      if (this.items.length > this.max) this.items.shift();
    } catch (e) {}
  }

  report() {
    return this.items.slice().reverse().map(({ segs, ...e }) => e);
  }
}

export const cacheProbe = new CacheProbe();
