/**
 * Thought Signature & Tool Call Registry
 *
 * 解决 Gemini 思考模型与长上下文多轮工具调用时 thought_signature 丢失导致的 400 错误。
 * 1. 拦截并提取 thought_signature 与工具名称；
 * 2. 下游回传 tool_result 时，自动将匹配的真实名称与签名无缝缝合；
 * 3. 持久化存储至本地，即使网关重启也不丢多轮会话状态；
 * 4. 内置合法兜底签名 (Fallback Signature)，杜绝任何遗漏报错。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSIST_FILE = path.join(__dirname, '..', 'data', 'signatures.json');

// Google 官方认证有效的合法思考签名兜底数据 (Base64)
export const FALLBACK_THOUGHT_SIGNATURE =
  "Ep4DCpsDAWkUfRPMXRY1Nr/Bc9gU+E+ZC+EvFegUic8lBiObBzAqrkyCng1WzxqB2QrZyDn9xVyUwfMTu6Rn++0jI9z+ak/n/KBhoOg4nu4tue3eZbMDQ07d81AXSl6wmgW/2Ynf7vU66bEsm0V6vRPhsuXLuVeWO1EtqwKcSsAD1JkSbJALtdhd1WPhwxdVkYVLoxGUUK8iE5l5ugsFrPPTkzmwz1EfBLIsD5FUiZ8i8pAujAlWn2i2IelwM7lAaoM9lg+KLBuxtUuGR8hlttbFrwUDn+vdw+rn3/OBAEgcRNNbXq/dimSU6BcJ7l2TLZbArcCyNj5HqEQRtUVHTxnTW6ZsiUsjPXn6KXWBxsTP4cCZgcjZtRrvCgkgc/svb6ckkfk8V4eiCIOWkfUJrcTAmJj99NZ4ypPwKftiPoK6BZvX7nDXMTthtUUrrl2RXhJSl/BUUDeU1KpSiXwSDj+4+bb+9xfcT1lD1nxn2hcxGk84gvs1nmSbihCfCER48J8583wsdKEzUyeLf0tpmNcNEJUlzsFAU1JCjeEdYqSF";

export class SignatureCache {
  constructor(ttlMs = 24 * 60 * 60 * 1000, maxSize = 3000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.cache = new Map(); // key: call_id, value: { signature: string, name: string, expireAt: number }
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(PERSIST_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
        const now = Date.now();
        for (const [k, v] of Object.entries(raw)) {
          if (v.expireAt > now) {
            this.cache.set(k, v);
          }
        }
      }
    } catch (e) {}
  }

  save() {
    try {
      const obj = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      const dir = path.dirname(PERSIST_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(obj), 'utf-8');
    } catch (e) {}
  }

  set(callId, signature, name = '') {
    if (!callId) return;
    this.cleanup();
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(callId, {
      signature: signature || FALLBACK_THOUGHT_SIGNATURE,
      name: name || '',
      expireAt: Date.now() + this.ttlMs,
    });
    this.save();
  }

  get(callId) {
    if (!callId) return FALLBACK_THOUGHT_SIGNATURE;
    const entry = this.cache.get(callId);
    if (!entry) return FALLBACK_THOUGHT_SIGNATURE;
    if (Date.now() > entry.expireAt) {
      this.cache.delete(callId);
      return FALLBACK_THOUGHT_SIGNATURE;
    }
    return entry.signature || FALLBACK_THOUGHT_SIGNATURE;
  }

  getName(callId) {
    if (!callId) return '';
    const entry = this.cache.get(callId);
    return entry ? entry.name || '' : '';
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [key, val] of this.cache.entries()) {
      if (now > val.expireAt) {
        this.cache.delete(key);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  size() {
    return this.cache.size;
  }
}

export const signatureCache = new SignatureCache();
