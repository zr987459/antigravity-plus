/**
 * Antigravity Gateway Server (Clean & Hark-Enabled Edition)
 *
 * 手机本地独立运行的高可用 AI 代理中枢：
 * 1. 兼容 Anthropic Messages API (/v1/messages) 与 OpenAI (/v1/chat/completions)
 * 2. 深度思考 (Thinking) 与思考签名 (Thought Signature) 智能补全
 * 3. 实时官方配额探测 (/api/gemini/quota & /api/hark/quota)
 * 4. 双模式：Antigravity (Google / CloudCode) 模式 + Hark.com 自主智能体模式
 * 5. 纯净极简，无冗余商业授权码逻辑，单机独占低耗高效
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AccountPool } from './account-pool.mjs';
import { signatureCache } from './signature-cache.mjs';
import { OAuthFlowManager } from './oauth-flow.mjs';
import { runConnectivityTest } from './test-runner.mjs';
import { fetchRealQuota } from './quota-fetcher.mjs';
import { getModelsResponse } from './models-catalog.mjs';
import { statsTracker } from './stats.mjs';
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_ENDPOINT_DAILY } from './constants.mjs';
import { AccessControl } from './access-control.mjs';
import { Persist } from './persist.mjs';
import {
  buildAntigravityHeaders,
  buildCloudCodePayload,
  MODEL_FALLBACK_CHAINS,
} from './cloudcode.mjs';
import { convertGoogleToAnthropic } from './content-converter.mjs';
import { handleStreamConversion } from './sse-streamer.mjs';
import { cacheProbe } from './cache-probe.mjs';
import { historyPin } from './history-pin.mjs';
import { clientSessionKey, bumpSessionOnOverflow, sessionStats } from './session-router.mjs';
import { isGeminiWebModel, handleGeminiWebRequest, GeminiWebAccountManager } from './gemini-web-provider.mjs';

let lastClientHeaders = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8792;

// 状态持久化
const persist = new Persist(path.join(__dirname, '..', 'data'));
await persist.restore();
statsTracker.load();
persist.startStatsSync(() => statsTracker.flush());
if (persist.enabled) {
  process.removeAllListeners('SIGTERM');
  process.once('SIGTERM', async () => {
    statsTracker.flush();
    await Promise.race([persist.syncStats(), new Promise(r => setTimeout(r, 8000))]);
    process.exit(0);
  });
}

// 账号池与 Gemini Web 账号管理
const accountPool = new AccountPool(path.join(__dirname, '..', 'data', 'accounts'));
const geminiWebAccounts = new GeminiWebAccountManager(path.join(__dirname, '..', 'data', 'gemini_web_accounts.json'));

persist.snapshot();
for (const m of ['addAccount', 'removeAccount', 'clearAccounts']) {
  const orig = accountPool[m].bind(accountPool);
  accountPool[m] = (...args) => { const r = orig(...args); persist.schedule(); return r; };
}

const oauthFlowManager = new OAuthFlowManager(accountPool);
const access = new AccessControl(path.join(__dirname, '..', 'data', 'keys.json'));

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function denyAdmin(res) {
  sendJson(res, 401, { ok: false, need_admin: true, error: '需要管理密钥' });
}

// 仅管理员可访问的内部接口
const ADMIN_PATHS = new Set([
  '/api/status', '/api/stats', '/api/logs', '/api/logs/clear', '/api/gemini/test', '/api/gemini/auth',
  '/api/oauth/exchange', '/api/oauth/token-exchange', '/api/accounts/add-token', '/api/accounts/switch',
  '/api/accounts/remove', '/api/gemini-web/accounts', '/api/gemini-web/accounts/switch',
  '/api/gemini-web/accounts/remove', '/api/gemini-web/accounts/test',
]);

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const dashboardHtmlPath = path.join(__dirname, 'dashboard.html');
const tokenHtmlPath = path.join(__dirname, 'token-page.html');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-admin-key, anthropic-version');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  {
    let p = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    if (/(^|\/)messages$/.test(p) && !p.startsWith('/api/')) p = '/v1/messages';
    else if (/(^|\/)chat\/completions$/.test(p) && !p.startsWith('/api/')) p = '/v1/chat/completions';
    else if (/(^|\/)v1\/models$/.test(p)) p = '/v1/models';
    url.pathname = p;
  }

  // 1. 控制台主页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (fs.existsSync(dashboardHtmlPath)) {
      const html = fs.readFileSync(dashboardHtmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
  }

  // 1.1 Token 专属提取页面 (/token, /get-token)
  if (url.pathname === '/token' || url.pathname === '/get-token' || url.pathname === '/token.html') {
    if (fs.existsSync(tokenHtmlPath)) {
      const html = fs.readFileSync(tokenHtmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
  }

  // 1.5 OAuth 回调
  if (url.pathname === '/oauth-callback') {
    const code = url.searchParams.get('code');
    const redirectUri = `http://localhost:${oauthFlowManager.fixedPort}/oauth-callback`;
    const result = await oauthFlowManager.processCallbackCode(code, redirectUri);
    res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(result.html);
    return;
  }

  // 1.55 App 下载
  if (url.pathname === '/app.apk' || url.pathname === '/app') {
    const apk = path.join(__dirname, '..', 'public', 'Antigravity.apk');
    if (!fs.existsSync(apk)) { sendJson(res, 404, { error: 'APK 还没生成' }); return; }
    const st = fs.statSync(apk);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename="Antigravity.apk"',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(apk).pipe(res);
    return;
  }

  // 1.6 健康检查
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, app: 'antigravity-plus', version: '1.0.0', auth: false });
    return;
  }

  // ====================== Gemini Web 官方网页直驱接口 ======================
  if (url.pathname === '/api/gemini-web/accounts' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, accounts: geminiWebAccounts.list() });
    return;
  }

  if (url.pathname === '/api/gemini-web/accounts' && req.method === 'POST') {
    try {
      const data = await readBody(req);
      if (!data.cookie) {
        sendJson(res, 400, { ok: false, error: 'Cookie 不能为空' });
        return;
      }
      const acc = geminiWebAccounts.addAccount(data);
      sendJson(res, 200, { ok: true, account: acc, message: 'Gemini Web 账号添加成功！' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/gemini-web/accounts/test' && req.method === 'POST') {
    const { id } = await readBody(req);
    const targetId = id || (geminiWebAccounts.getAvailableAccount()?.id);
    if (!targetId) {
      sendJson(res, 400, { ok: false, error: '暂无可用的 Gemini Web 账号' });
      return;
    }
    const result = await geminiWebAccounts.testAccount(targetId);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/gemini-web/accounts/switch' && req.method === 'POST') {
    try {
      const { id } = await readBody(req);
      geminiWebAccounts.switchAccount(id);
      sendJson(res, 200, { ok: true, message: '切换成功' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/gemini-web/accounts/remove' && req.method === 'POST') {
    try {
      const { id } = await readBody(req);
      geminiWebAccounts.removeAccount(id);
      sendJson(res, 200, { ok: true, message: '移除成功' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ====================== Antigravity 核心接口 ======================
  // 2. 真实配额接口 (/api/gemini/quota)
  if (url.pathname === '/api/gemini/quota') {
    const email = url.searchParams.get('email');
    const mgr = email ? accountPool.getManager(email) : accountPool.getActiveManager();
    const targetMgr = mgr || accountPool.getActiveManager();
    const quotaData = await fetchRealQuota(targetMgr);
    sendJson(res, 200, quotaData);
    return;
  }

  // 3. 统计数据与日志
  if (url.pathname === '/api/stats') {
    sendJson(res, 200, statsTracker.getStats());
    return;
  }

  if (url.pathname === '/api/debug/cache') {
    sendJson(res, 200, { pin: historyPin.stats(), session: sessionStats(), clientHeaders: lastClientHeaders, requests: cacheProbe.report() });
    return;
  }

  if (url.pathname === '/api/logs') {
    sendJson(res, 200, statsTracker.getAllLogs(100));
    return;
  }

  if (url.pathname === '/api/logs/clear' && req.method === 'POST') {
    const resetAll = url.searchParams.get('all') === '1';
    if (resetAll) {
      statsTracker.resetStats();
    } else {
      statsTracker.clearAllLogs();
    }
    sendJson(res, 200, { ok: true, resetAll });
    return;
  }

  if (url.pathname === '/api/stats/reset' && req.method === 'POST') {
    statsTracker.resetStats();
    sendJson(res, 200, { ok: true, message: '统计数据已归零' });
    return;
  }

  // 4. 模型列表接口
  if (url.pathname === '/v1/models' || url.pathname === '/models' || url.pathname === '/api/models') {
    sendJson(res, 200, getModelsResponse());
    return;
  }

  // 5. 服务状态
  if (url.pathname === '/api/status') {
    const activeMgr = accountPool.getActiveManager();
    const host = req.headers.host || '';
    const status = {
      app: 'antigravity-gateway',
      version: '4.0.0',
      auth_enabled: access.enabled,
      port: PORT,
      auth_url: oauthFlowManager.getAuthUrl(host),
      active_account: activeMgr ? activeMgr.getStatus() : null,
      accounts: accountPool.getAllStatus(),
      stats: statsTracker.getStats(),
      signature_cache_size: signatureCache.size(),
      persist: persist.status(),
      hark_accounts_count: harkAccounts.accounts.length,
    };
    sendJson(res, 200, status);
    return;
  }

  // 6. 出字测速
  if (url.pathname === '/api/gemini/test' && req.method === 'POST') {
    const activeMgr = accountPool.getActiveManager();
    const testResult = await runConnectivityTest(activeMgr, accountPool);
    sendJson(res, 200, testResult);
    return;
  }

  // 7. OAuth 授权链接
  if (url.pathname === '/api/gemini/auth' && req.method === 'POST') {
    const host = req.headers.host || '';
    const authUrl = oauthFlowManager.getAuthUrl(host);
    sendJson(res, 200, { ok: true, auth_url: authUrl, message: '授权链接已就绪' });
    return;
  }

  // 8. 手动回贴回调 URL 或 Code 换票入池
  if (url.pathname === '/api/oauth/exchange' && req.method === 'POST') {
    try {
      const { code_or_url } = await readBody(req);
      if (!code_or_url) {
        sendJson(res, 400, { ok: false, error: '请粘贴回调 URL 或 Code' });
        return;
      }
      const tokenResult = await oauthFlowManager.exchangeRawInput(code_or_url);
      if (tokenResult.refreshToken && tokenResult.email) {
        accountPool.addAccount(tokenResult.refreshToken, tokenResult.email);
      }
      sendJson(res, 200, {
        ok: true,
        message: `账号 ${tokenResult.email} 授权成功并加入账号池！`,
        email: tokenResult.email,
        refreshToken: tokenResult.refreshToken,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 8.5 专门提取 Token 的 API (/token 页面使用)
  if (url.pathname === '/api/oauth/token-exchange' && req.method === 'POST') {
    try {
      const { code_or_url } = await readBody(req);
      if (!code_or_url) {
        sendJson(res, 400, { ok: false, error: '请粘贴回调 URL 或 Code' });
        return;
      }
      const tokenResult = await oauthFlowManager.exchangeRawInput(code_or_url);
      sendJson(res, 200, {
        ok: true,
        email: tokenResult.email,
        refreshToken: tokenResult.refreshToken,
        accessToken: tokenResult.accessToken,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 8.6 直接通过 Refresh Token 添加账号
  if (url.pathname === '/api/accounts/add-token' && req.method === 'POST') {
    try {
      const { refresh_token } = await readBody(req);
      if (!refresh_token || !refresh_token.trim()) {
        sendJson(res, 400, { ok: false, error: '请提供有效的 Refresh Token' });
        return;
      }
      const result = await oauthFlowManager.validateAndAddRefreshToken(refresh_token);
      sendJson(res, 200, {
        ok: true,
        message: `账号 ${result.email} 验证通过并已成功加入账号池！`,
        email: result.email,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 9. 账号切换与管理
  if (url.pathname === '/api/accounts/switch' && req.method === 'POST') {
    try {
      const { email } = await readBody(req);
      accountPool.switchAccount(email);
      sendJson(res, 200, { ok: true, message: `已切换至账号 ${email}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/accounts/remove' && req.method === 'POST') {
    try {
      const { email } = await readBody(req);
      accountPool.removeAccount(email);
      sendJson(res, 200, { ok: true, message: `已移除账号 ${email}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // 9.5 OpenAI 兼容接口：/v1/chat/completions
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    try {
      const oaiReq = await readBody(req);
      const anthropicReq = {
        model: oaiReq.model,
        messages: oaiReq.messages,
        stream: oaiReq.stream,
        system: oaiReq.messages?.find(m => m.role === 'system')?.content,
      };

      if (isGeminiWebModel(oaiReq.model)) {
        const startTime = Date.now();
        await handleGeminiWebRequest(req, res, oaiReq, geminiWebAccounts, 'openai');
        statsTracker.recordRequest({
          email: 'gemini-web-pool',
          model: oaiReq.model,
          latency_ms: Date.now() - startTime,
          status: 200,
          is_stream: Boolean(oaiReq.stream),
          input_tokens: JSON.stringify(oaiReq.messages || []).length,
          output_tokens: 512,
        });
        return;
      }

      sendJson(res, 400, { error: '当前 /v1/chat/completions 推荐使用 gemini-web-flash 等模型，其余模型请调用 /v1/messages' });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // 10. 核心 Anthropic 协议推理接口：/v1/messages
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      const startTime = Date.now();
      let statsRecorded = false;
      let statsEmail = null;
      let statsModel = null;
      try {
        const anthropicReq = JSON.parse(body);
        statsModel = anthropicReq.model;

        // 【Gemini Web 专用路由通道】
        if (isGeminiWebModel(anthropicReq.model)) {
          statsEmail = 'gemini-web-pool';
          try {
            await handleGeminiWebRequest(req, res, anthropicReq, geminiWebAccounts, 'anthropic');
            statsTracker.recordRequest({
              email: statsEmail,
              model: anthropicReq.model,
              latency_ms: Date.now() - startTime,
              status: 200,
              is_stream: Boolean(anthropicReq.stream),
              input_tokens: JSON.stringify(anthropicReq.messages || []).length,
              output_tokens: 512,
            });
            statsRecorded = true;
          } catch (err) {
            console.error('[Gemini Web Execution Error]', err);
            if (!res.headersSent) {
              sendJson(res, 500, { type: 'error', error: { type: 'gateway_error', message: err.message } });
            }
          }
          return;
        }

        // Google / Antigravity 路由通道
        anthropicReq._gwSessionKey = clientSessionKey(req.headers, anthropicReq);
        lastClientHeaders = {
          names: Object.keys(req.headers).sort(),
          metadataKeys: Object.keys(anthropicReq.metadata || {}),
          hasClientSession: Boolean(anthropicReq._gwSessionKey),
        };

        let activeMgr = accountPool.getActiveManager();
        if (!activeMgr) {
          sendJson(res, 401, {
            error: {
              type: 'authentication_error',
              message: '账号池暂无可用 Google 账号，请在控制台添加账号',
            },
          });
          return;
        }

        statsEmail = activeMgr.tokenData.email;
        let accessToken = await activeMgr.getValidAccessToken();
        const isStreaming = Boolean(anthropicReq.stream);
        let lastFailedDetails = null;

        let response = null;
        const trySendToAccount = async (mgr) => {
          let tok = await mgr.getValidAccessToken();
          if (!tok) return null;
          if (!mgr.tokenData.projectId && typeof mgr.ensureProjectId === 'function') {
            await mgr.ensureProjectId().catch(() => '');
          }
          anthropicReq._gwEmail = mgr.tokenData.email;
          let p = buildCloudCodePayload(anthropicReq, mgr.tokenData.projectId);
          cacheProbe.record(mgr.tokenData.email, anthropicReq.model, p);

          const streamUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`;
          const nonStreamUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:generateContent`;
          const targetUrl = isStreaming ? streamUrl : nonStreamUrl;

          let r = await fetch(targetUrl, {
            method: 'POST',
            headers: buildAntigravityHeaders(tok),
            body: JSON.stringify(p),
          });

          if (r && r.status === 400) {
            const errText = await r.clone().text().catch(() => '');
            if (bumpSessionOnOverflow(anthropicReq, mgr.tokenData.email, errText)) {
              p = buildCloudCodePayload(anthropicReq, mgr.tokenData.projectId);
              r = await fetch(targetUrl, {
                method: 'POST',
                headers: buildAntigravityHeaders(tok),
                body: JSON.stringify(p),
              });
            }
          }
          return r;
        };

        try {
          response = await trySendToAccount(activeMgr);
          if (response && (response.status === 429 || response.status === 403 || response.status === 401)) {
            const errBody = await response.clone().text().catch(() => '');
            if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(errBody)) {
              console.warn(`[Failover] 主账号 ${activeMgr.tokenData.email} 触发配额耗尽(${response.status})，借调备用账号...`);
              const altMgr = accountPool.rotateToNext();
              if (altMgr && altMgr !== activeMgr) {
                const altResp = await trySendToAccount(altMgr);
                if (altResp && altResp.ok) {
                  activeMgr = altMgr;
                  accessToken = await activeMgr.getValidAccessToken();
                  statsEmail = activeMgr.tokenData.email;
                  response = altResp;
                }
              }
            }
          }
        } catch (e) {
          lastFailedDetails = { status: 500, body: e.message };
        }

        if (!response || !response.ok) {
          const executeAttempt = async (modelToUse) => {
            const reqCopy = { ...anthropicReq, model: modelToUse };
            const payload = buildCloudCodePayload(reqCopy, activeMgr.tokenData.projectId);
            const headers = buildAntigravityHeaders(accessToken);

            for (const host of ANTIGRAVITY_ENDPOINTS) {
              const upstreamEndpoint = isStreaming
                ? `${host}/v1internal:streamGenerateContent?alt=sse`
                : `${host}/v1internal:generateContent`;

              try {
                const r = await fetch(upstreamEndpoint, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(payload),
                });
                if (r.ok) return r;
                const errText = await r.text().catch(() => '');
                lastFailedDetails = { status: r.status, body: errText };
              } catch (e) {
                lastFailedDetails = { status: 500, body: e.message };
              }
            }
            return null;
          };

          response = await executeAttempt(anthropicReq.model);
          if (!response || !response.ok) {
            const fallbacks = MODEL_FALLBACK_CHAINS[anthropicReq.model] || [];
            for (const fallbackModel of fallbacks) {
              response = await executeAttempt(fallbackModel);
              if (response && response.ok) break;
            }
          }
        }

        if (!response || !response.ok) {
          const errDetail = lastFailedDetails ? lastFailedDetails.body : 'Google 集群无响应';
          sendJson(res, 502, {
            error: {
              type: 'upstream_error',
              message: errDetail,
            },
          });
          statsTracker.recordRequest({
            email: activeMgr.tokenData.email,
            model: anthropicReq.model,
            latency_ms: Date.now() - startTime,
            status: 502,
            error: String(errDetail).slice(0, 100),
          });
          statsRecorded = true;
          return;
        }

        if (isStreaming) {
          await handleStreamConversion(response, res, anthropicReq.model, (usage) => {
            const status = usage.outcome === 'ok' ? 200 : usage.outcome === 'client_abort' ? 499 : 502;
            statsTracker.recordRequest({
              email: activeMgr.tokenData.email,
              model: anthropicReq.model,
              latency_ms: Date.now() - startTime,
              ttft_ms: usage.ttft_ms,
              status,
              is_stream: true,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cached_tokens: usage.cached_tokens,
              thoughts_tokens: usage.thoughts_tokens,
              error: usage.error || null,
            });
          }, startTime);
        } else {
          const googleData = await response.json();
          const anthropicResp = convertGoogleToAnthropic(googleData, anthropicReq.model);
          sendJson(res, 200, anthropicResp);

          const u = anthropicResp._gw_usage || {};
          statsTracker.recordRequest({
            email: activeMgr.tokenData.email,
            model: anthropicReq.model,
            latency_ms: Date.now() - startTime,
            status: 200,
            is_stream: false,
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cached_tokens: u.cached_tokens || 0,
            thoughts_tokens: u.thoughts_tokens || 0,
          });
        }
        statsRecorded = true;
      } catch (err) {
        console.error('[Messages Handler Error]', err);
        if (!statsRecorded && statsEmail) {
          statsTracker.recordRequest({
            email: statsEmail,
            model: statsModel,
            latency_ms: Date.now() - startTime,
            status: 500,
            error: String(err?.message || err).slice(0, 100),
          });
        }
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: {
              type: 'api_error',
              message: err.message,
            },
          });
        }
      }
    });
    return;
  }

  console.warn('[404]', req.method, req.url);
  sendJson(res, 404, { error: 'Endpoint not found', method: req.method, path: url.pathname });
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Antigravity+ (v1.0.0 Gemini-Web Edition) 运行在 http://0.0.0.0:${PORT}`);
});
