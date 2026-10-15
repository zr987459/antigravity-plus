/**
 * Google OAuth Flow Manager (RFC 8252 Desktop App Loopback Flow)
 *
 * 核心机制：
 * Google 官方 Client ID 属于 Native/Desktop 应用类型，
 * Google OAuth 服务器严格强制其 redirect_uri 只能是 http://localhost:PORT/oauth-callback 或者是 127.0.0.1！
 * 传任何公网域名 (如 onrender.com) 都会被 Google 安全校验直接拦截并报：
 * "错误 400：redirect_uri_mismatch"！
 *
 * 解决方案：
 * 1. 始终生成符合 Google 官方规范的标准 redirect_uri (http://localhost:51121/oauth-callback)
 * 2. 授权完成后，浏览器如果跳到 localhost:51121 报无法连接属于正常现象（手机没开本地监听）
 * 3. 用户只需复制浏览器地址栏里带有 code= 的完整网址，粘贴回控制台的输入框，一键提交换票激活！
 */

import http from 'http';
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  SCOPES,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
} from './constants.mjs';

export class OAuthFlowManager {
  constructor(accountPool) {
    this.accountPool = accountPool;
    this.fixedPort = 51121;
    this.server = null;
    this.lastExchangedAccount = null;
    this.initPermanentListener();
  }

  getAuthUrl() {
    // 强制使用 Google 官方 Desktop 客户端白名单允许的标准回调地址
    const redirectUri = `http://localhost:${this.fixedPort}/oauth-callback`;

    const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', 'antigravity_' + Date.now());
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    return authUrl.toString();
  }

  initPermanentListener() {
    if (this.server) return;

    this.server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${this.fixedPort}`);
      if (reqUrl.pathname === '/oauth-callback') {
        const code = reqUrl.searchParams.get('code');
        const htmlResult = await this.processCallbackCode(code, `http://localhost:${this.fixedPort}/oauth-callback`);
        res.writeHead(htmlResult.status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlResult.html);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.on('error', () => {});

    try {
      this.server.listen(this.fixedPort, '0.0.0.0', () => {
        console.log(`📡 Google OAuth 本地回调监听常驻在端口 ${this.fixedPort}`);
      });
    } catch (e) {}
  }

  async processCallbackCode(code, redirectUri) {
    if (!code) {
      return {
        status: 400,
        html: '<h3 style="color:#ef4444;text-align:center;margin-top:40px;font-family:sans-serif;">⚠ 授权失败：未收到 Google Code</h3>',
      };
    }

    try {
      console.log('[OAuth Flow] 收到回调 Code，向 Google 换取 Token...');
      const tokenResult = await this.exchangeCode(code, redirectUri);

      if (this.accountPool && tokenResult.refreshToken && tokenResult.email) {
        this.accountPool.addAccount(tokenResult.refreshToken, tokenResult.email);
        this.lastExchangedAccount = tokenResult.email;
        console.log(`[OAuth Flow] 账号 ${tokenResult.email} 已成功加入账号池！`);
      }

      return {
        status: 200,
        html: `
          <!DOCTYPE html>
          <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>授权成功 - Antigravity Token</title>
            <style>
              body { background: #0b1120; color: #fff; font-family: -apple-system, sans-serif; text-align: center; padding: 40px 16px; margin: 0; }
              .box { max-width: 460px; margin: 0 auto; background: #1e293b; padding: 24px; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
              h2 { color: #22c55e; margin-bottom: 12px; }
              p { color: #94a3b8; font-size: 0.9rem; line-height: 1.6; margin: 6px 0; }
              .email { color: #38bdf8; font-weight: bold; }
              .token-box { margin-top: 16px; text-align: left; }
              .token-label { display: block; color: #cbd5e1; font-size: 0.85rem; margin-bottom: 6px; font-weight: 600; }
              textarea { width: 100%; height: 80px; background: #0f172a; border: 1px solid #38bdf8; color: #38bdf8; padding: 10px; border-radius: 8px; font-family: monospace; font-size: 0.82rem; box-sizing: border-box; resize: none; }
              .btn-copy { width: 100%; background: #38bdf8; color: #0b1120; border: none; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; font-size: 0.95rem; }
              .btn-copy:active { opacity: 0.8; }
              .btn-home { display: inline-block; background: #334155; color: #fff; padding: 10px 20px; border-radius: 8px; font-weight: bold; text-decoration: none; margin-top: 14px; font-size: 0.9rem; }
            </style>
          </head>
          <body>
            <div class="box">
              <h2>🎉 Google 授权成功！</h2>
              <p>账号 <span class="email">${tokenResult.email || 'Google'}</span> 已激活。</p>
              <div class="token-box">
                <span class="token-label">🔑 您的 Refresh Token (长期凭据)：</span>
                <textarea id="rt" readonly>${tokenResult.refreshToken}</textarea>
                <button class="btn-copy" onclick="navigator.clipboard.writeText(document.getElementById('rt').value);this.innerText='✅ Refresh Token 已成功复制！';">📋 一键复制 Refresh Token</button>
              </div>
              <p style="margin-top: 16px; font-size: 0.8rem; color: #64748b;">账号已自动同步至网关账号池，您可以直接返回控制台使用。</p>
              <a class="btn-home" href="/">👉 返回网关控制台</a>
            </div>
          </body>
          </html>
        `,
      };
    } catch (err) {
      console.error('[OAuth Flow] 换票失败:', err.message);
      return {
        status: 500,
        html: `
          <body style="background:#0b1120;color:#fff;font-family:sans-serif;text-align:center;padding:40px 16px;">
            <h2 style="color:#ef4444;">⚠ 换取令牌失败</h2>
            <p style="color:#94a3b8;">${err.message}</p>
            <a href="/" style="color:#38bdf8;margin-top:20px;display:inline-block;">返回控制台重试</a>
          </body>
        `,
      };
    }
  }

  async exchangeRawInput(rawInput) {
    // 去掉换行、空格（手机复制长网址常被折行），并兼容被二次编码的网址
    let code = String(rawInput || '').replace(/\s+/g, '');
    for (let i = 0; i < 2 && /%(25)?(2F|3A|3F|26|3D)/i.test(code); i++) { try { code = decodeURIComponent(code); } catch (e) { break; } }
    // 官方 RFC 8252 Desktop 客户端必须始终使用 localhost:51121 换票
    const redirectUri = `http://localhost:${this.fixedPort}/oauth-callback`;

    if (code.includes('code=')) {
      try {
        const u = new URL(code.startsWith('http') ? code : 'http://localhost/' + code);
        const extractedCode = u.searchParams.get('code');
        if (extractedCode) code = extractedCode;
      } catch (e) {
        const m = code.match(/code=([^&]+)/);
        if (m) code = decodeURIComponent(m[1]);
      }
    }

    // 粘贴的是 Refresh Token（1//...，授权成功页会自动复制它），直接按 Refresh Token 导入
    if (/^1\/\/[0-9A-Za-z_-]{20,}$/.test(code)) return await this.validateAndAddRefreshToken(code);
    code = code.split('&')[0].split('#')[0];
    if (!/^4\/[0-9A-Za-z_-]{20,}$/.test(code)) {
      throw new Error('授权码不完整或已失效：如果刚才的页面显示「授权成功」，账号已经加好，直接返回控制台即可；否则请重新点「登录 Google」，授权完成后把地址栏里从 http://localhost 开头、包含 code= 的整条网址完整复制过来（不要只复制一部分）');
    }
    return await this.exchangeCode(code, redirectUri);
  }

  async exchangeCode(code, redirectUri) {
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google API 换票失败 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;

    let email = '';
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (userRes.ok) {
        const u = await userRes.json();
        email = u.email || '';
      }
    } catch (e) {}

    return {
      accessToken,
      refreshToken,
      email,
      expiresIn: data.expires_in || 3600,
    };
  }

  async validateAndAddRefreshToken(refreshToken) {
    const cleanToken = refreshToken.trim();
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: cleanToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google Refresh Token 校验失败 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const accessToken = data.access_token;

    let email = '';
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (userRes.ok) {
        const u = await userRes.json();
        email = u.email || '';
      }
    } catch (e) {}

    if (!email) {
      email = `user_${Date.now()}@gmail.com`;
    }

    if (this.accountPool) {
      this.accountPool.addAccount(cleanToken, email);
    }

    return {
      email,
      refreshToken: cleanToken,
      accessToken,
    };
  }
}
