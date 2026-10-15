/**
 * 永久保存：把运行时新增的账号、绑定、授权码、用量统计同步到 GitHub 仓库的 state 分支。
 * Render 免费版重启/重新部署会清空磁盘，启动时从 state 分支恢复。
 * state 分支不会触发 Render 部署（Render 只部署 main）。
 *
 * 需要 Render 环境变量：
 *   GH_TOKEN  GitHub 令牌（对本仓库有 Contents 读写权限）
 *   GH_REPO   可选，默认 zr987459/antigravity-gateway
 *   GH_STATE_BRANCH 可选，默认 state
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const API = (process.env.GH_API || 'https://api.github.com').replace(/\/$/, '');
const DIR = 'gateway-state';

export class Persist {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.token = (process.env.GH_TOKEN || '').trim();
    this.repo = (process.env.GH_REPO || 'zr987459/antigravity-gateway').trim();
    this.branch = (process.env.GH_STATE_BRANCH || 'state').trim();
    this.shas = new Map();   // remote path -> sha
    this.pushed = new Map(); // remote path -> content hash
    this.timer = null;
    this.busy = false;
    this.again = false;
    this.lastError = '';
    this.lastSync = 0;
  }

  get enabled() { return Boolean(this.token); }

  status() { return { enabled: this.enabled, branch: this.branch, last_sync: this.lastSync || null, error: this.lastError || null }; }

  async req(method, p, body) {
    const r = await fetch(API + p, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'antigravity-gateway', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${method} ${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? {} : r.json();
  }

  async ensureBranch() {
    const b = await this.req('GET', `/repos/${this.repo}/branches/${this.branch}`);
    if (b) return;
    const main = await this.req('GET', `/repos/${this.repo}/git/ref/heads/main`);
    if (!main) throw new Error('找不到 main 分支');
    await this.req('POST', `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${this.branch}`, sha: main.object.sha });
    console.log(`[Persist] 已创建 ${this.branch} 分支`);
  }

  async getFile(p) {
    const f = await this.req('GET', `/repos/${this.repo}/contents/${p}?ref=${this.branch}`);
    if (!f || Array.isArray(f)) return null;
    this.shas.set(p, f.sha);
    const text = Buffer.from(f.content || '', 'base64').toString('utf-8');
    this.pushed.set(p, hash(text));
    return text;
  }

  async listDir(p) {
    const d = await this.req('GET', `/repos/${this.repo}/contents/${p}?ref=${this.branch}`);
    if (!Array.isArray(d)) return [];
    for (const f of d) this.shas.set(f.path, f.sha);
    return d.filter(f => f.type === 'file');
  }

  /** 启动时调用：在账号池加载前把 state 分支的数据写回本地 */
  async restore() {
    if (!this.enabled) { console.log('[Persist] 未设置 GH_TOKEN，账号与绑定不会永久保存'); return; }
    try {
      await this.ensureBranch();
      const accDir = path.join(this.dataDir, 'accounts');
      fs.mkdirSync(accDir, { recursive: true });
      // 已移除的账号
      const removedText = await this.getFile(`${DIR}/removed.json`);
      const removed = removedText ? JSON.parse(removedText) : [];
      for (const name of removed) { try { fs.unlinkSync(path.join(accDir, name)); } catch (e) {} }
      // 账号（含绑定）
      let n = 0;
      for (const f of await this.listDir(`${DIR}/accounts`)) {
        const text = await this.getFile(f.path);
        if (text) { fs.writeFileSync(path.join(accDir, f.name), text, 'utf-8'); n++; }
      }
      // 授权码列表与吊销记录
      const keysText = await this.getFile(`${DIR}/keys.json`);
      if (keysText) {
        const remote = JSON.parse(keysText);
        const file = path.join(this.dataDir, 'keys.json');
        let local = {};
        try { local = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {}
        const keys = Array.isArray(local.keys) ? local.keys : [];
        for (const k of remote.keys || []) if (k && k.key && !keys.find(x => x.key === k.key)) keys.push(k);
        local.keys = keys;
        local.revoked = Array.from(new Set([...(local.revoked || []), ...(remote.revoked || [])]));
        fs.writeFileSync(file, JSON.stringify(local, null, 2), 'utf-8');
      }
      // App 用户登记（按授权码合并，保留最新）
      const usersText = await this.getFile(`${DIR}/app-users.json`);
      if (usersText) {
        const file = path.join(this.dataDir, 'app-users.json');
        const map = new Map();
        let local = [];
        try { local = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {}
        for (const u of [...JSON.parse(usersText), ...local]) {
          if (!u || !u.invite_id) continue;
          const prev = map.get(u.invite_id);
          if (!prev || (u.last_seen || 0) >= (prev.last_seen || 0)) map.set(u.invite_id, { ...prev, ...u });
        }
        fs.writeFileSync(file, JSON.stringify([...map.values()], null, 2), 'utf-8');
      }
      // 用量统计（新容器本地没有，直接用云端的）
      const statsText = await this.getFile(`${DIR}/user_stats.json`);
      const statsFile = path.join(this.dataDir, 'user_stats.json');
      if (statsText && !fs.existsSync(statsFile)) { JSON.parse(statsText); fs.writeFileSync(statsFile, statsText, 'utf-8'); }
      this.removed = new Set(removed);
      this.lastSync = Date.now();
      console.log(`[Persist] 已从 ${this.branch} 分支恢复 ${n} 个账号`);
    } catch (e) {
      this.lastError = '恢复失败，已暂停同步以免覆盖云端数据：' + e.message;
      this.restoreFailed = true;
      console.error('[Persist] 恢复失败:', e.message);
    }
  }

  /** 数据变化后调用，3 秒内合并成一次同步 */
  schedule() {
    if (!this.enabled || this.restoreFailed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), 3000);
  }

  async put(p, text, msg) {
    const h = hash(text);
    if (this.pushed.get(p) === h) return;
    const body = { message: msg, content: Buffer.from(text).toString('base64'), branch: this.branch };
    if (this.shas.has(p)) body.sha = this.shas.get(p);
    const r = await this.req('PUT', `/repos/${this.repo}/contents/${p}`, body);
    if (r && r.content) this.shas.set(p, r.content.sha);
    this.pushed.set(p, h);
  }

  async sync() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const accDir = path.join(this.dataDir, 'accounts');
      const local = fs.existsSync(accDir) ? fs.readdirSync(accDir).filter(f => f.endsWith('.json')) : [];
      const remote = await this.listDir(`${DIR}/accounts`);
      for (const f of local) {
        await this.put(`${DIR}/accounts/${f}`, fs.readFileSync(path.join(accDir, f), 'utf-8'), `state: account ${f}`);
      }
      const removed = this.removed || new Set();
      for (const f of remote) {
        if (!local.includes(f.name)) {
          await this.req('DELETE', `/repos/${this.repo}/contents/${f.path}`, { message: `state: remove ${f.name}`, sha: f.sha, branch: this.branch });
          this.shas.delete(f.path); this.pushed.delete(f.path);
        }
      }
      // 记住被移除的账号（包括仓库 main 里自带、运行时被删的）
      for (const f of this.knownFiles || []) if (!local.includes(f)) removed.add(f);
      for (const f of local) removed.delete(f);
      this.removed = removed;
      this.knownFiles = local;
      await this.put(`${DIR}/removed.json`, JSON.stringify(Array.from(removed), null, 2), 'state: removed accounts');
      let keys = {};
      try { keys = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'keys.json'), 'utf-8')); } catch (e) {}
      await this.put(`${DIR}/keys.json`, JSON.stringify({ keys: keys.keys || [], revoked: keys.revoked || [] }, null, 2), 'state: access codes');
      try {
        const users = fs.readFileSync(path.join(this.dataDir, 'app-users.json'), 'utf-8');
        // last_seen 每次心跳都变，只在名单本身变化时提交，避免刷屏
        const stable = JSON.stringify(JSON.parse(users).map(({ last_seen, ...u }) => u));
        if (this.usersStable !== stable) { await this.put(`${DIR}/app-users.json`, users, 'state: app users'); this.usersStable = stable; }
      } catch (e) {}
      this.lastSync = Date.now(); this.lastError = '';
    } catch (e) {
      this.lastError = e.message;
      console.error('[Persist] 同步失败:', e.message);
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }

  /** 推送用量统计（内容没变就跳过） */
  async syncStats() {
    if (!this.enabled || this.restoreFailed) return;
    try {
      const file = path.join(this.dataDir, 'user_stats.json');
      if (!fs.existsSync(file)) return;
      await this.put(`${DIR}/user_stats.json`, fs.readFileSync(file, 'utf-8'), 'state: usage stats');
    } catch (e) {
      console.error('[Persist] 统计同步失败:', e.message);
    }
  }

  /** 定时备份统计；flush 先把内存里的统计写盘 */
  startStatsSync(flush, intervalMs = 10 * 60 * 1000) {
    if (!this.enabled || this.restoreFailed) return;
    const t = setInterval(() => { try { flush(); } catch (e) {} this.syncStats(); }, intervalMs);
    t.unref?.();
  }

  /** 记录当前本地账号文件，用于识别之后被移除的账号 */
  snapshot() {
    const accDir = path.join(this.dataDir, 'accounts');
    this.knownFiles = fs.existsSync(accDir) ? fs.readdirSync(accDir).filter(f => f.endsWith('.json')) : [];
  }
}

function hash(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
