/**
 * Token Manager & Project ID Resolver
 *
 * 融合顶级开源项目 (CLIProxyAPI) 验证通过的完整机制：
 * 1. 携带 Antigravity 官方 ClientSecret 换票，无需 PKCE 繁重流程，大幅提高成功率；
 * 2. 自动通过 loadCodeAssist / onboardUser 探活并获取用户的专属伴随项目 (cloudaicompanionProject)；
 * 3. 50 分钟主动静默续期守护。
 */

import fs from 'fs';
import path from 'path';
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  GOOGLE_TOKEN_ENDPOINT,
  CLOUDCODE_API_ENDPOINT,
  DAILY_API_ENDPOINT,
  API_VERSION,
} from './constants.mjs';

export class TokenManager {
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.tokenData = {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      email: '',
      projectId: '',
    };
    this.clientId = ANTIGRAVITY_CLIENT_ID;
    this.clientSecret = ANTIGRAVITY_CLIENT_SECRET;
    this.load();
    this.startKeepAlive();
  }

  load() {
    if (!this.storagePath) return;
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        this.tokenData = JSON.parse(raw);
      }
    } catch (e) {
      console.error('[TokenManager] Load error:', e.message);
    }
  }

  save() {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.tokenData, null, 2), 'utf-8');
    } catch (e) {
      console.error('[TokenManager] Save error:', e.message);
    }
  }

  async setRefreshToken(refreshToken, email = '') {
    this.tokenData.refreshToken = refreshToken;
    if (email) this.tokenData.email = email;
    this.save();
    const token = await this.refreshAccessToken();
    if (token) {
      // 换取到 Token 后立即探测或激活用户的 Antigravity 免费项目 ID
      await this.ensureProjectId();
    }
    return token;
  }

  async refreshAccessToken() {
    if (!this.tokenData.refreshToken) return null;
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = (async () => {
      try {
        const bodyParams = new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: this.tokenData.refreshToken,
        });

        const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: bodyParams.toString(),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(`[TokenManager] Refresh failed (${res.status}): ${errText}`);
          return null;
        }

        const data = await res.json();
        this.tokenData.accessToken = data.access_token;
        const expiresIn = data.expires_in || 3600;
        this.tokenData.expiresAt = Date.now() + expiresIn * 1000;
        this.save();
        console.log(`[TokenManager] 令牌主动换票成功 (有效期至: ${new Date(this.tokenData.expiresAt).toLocaleTimeString()})`);
        return this.tokenData.accessToken;
      } catch (e) {
        console.error('[TokenManager] Refresh network error:', e.message);
        return null;
      } finally {
        this._refreshPromise = null;
      }
    })();

    return this._refreshPromise;
  }

  async getValidAccessToken() {
    const safeWindowMs = 5 * 60 * 1000;
    if (this.tokenData.accessToken && Date.now() + safeWindowMs < this.tokenData.expiresAt) {
      return this.tokenData.accessToken;
    }
    return await this.refreshAccessToken();
  }

  /**
   * 自动探测或通过 onboardUser 开通新账号的 Antigravity 伴随项目 (ProjectID)
   */
  async ensureProjectId() {
    if (this.tokenData.projectId) return this.tokenData.projectId;
    if (!this.tokenData.accessToken) return '';

    try {
      const url = `${CLOUDCODE_API_ENDPOINT}/${API_VERSION}:loadCodeAssist`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tokenData.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/1.10.2 linux/arm64',
        },
        body: JSON.stringify({
          metadata: { ideType: 'ANTIGRAVITY' }
        })
      });

      if (!res.ok) return '';
      const data = await res.json();
      let pid = data.cloudaicompanionProject || data.projectId;

      // 如果是全新账号，尚未绑定伴随项目，调用 onboardUser 自动激活
      if (!pid && data.allowedTiers && data.allowedTiers.length > 0) {
        const defaultTier = data.allowedTiers.find(t => t.isDefault) || data.allowedTiers[0];
        const tierId = defaultTier.tierId || 'free';
        console.log(`[TokenManager] 全新账号，正在自动开通 Antigravity Tier: ${tierId}...`);

        const onboardUrl = `${DAILY_API_ENDPOINT}/${API_VERSION}:onboardUser`;
        const onbRes = await fetch(onboardUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.tokenData.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.10.2 linux/arm64',
          },
          body: JSON.stringify({
            tier_id: tierId,
            metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity' }
          })
        });

        if (onbRes.ok) {
          const onbData = await onbRes.json();
          pid = onbData.cloudaicompanionProject || onbData.projectId;
        }
      }

      if (pid) {
        this.tokenData.projectId = pid;
        this.save();
        console.log(`[TokenManager] 成功绑定 Antigravity 伴随项目: ${pid}`);
      }
      return pid;
    } catch (e) {
      console.warn('[TokenManager] ProjectID 自动解析告警:', e.message);
      return '';
    }
  }

  startKeepAlive() {
    setInterval(async () => {
      if (this.tokenData.refreshToken) {
        await this.refreshAccessToken();
      }
    }, 45 * 60 * 1000);
  }

  getStatus() {
    return {
      hasRefreshToken: Boolean(this.tokenData.refreshToken),
      hasAccessToken: Boolean(this.tokenData.accessToken),
      email: this.tokenData.email || 'unknown',
      projectId: this.tokenData.projectId || 'pending_detection',
      expiresInMinutes: Math.max(0, Math.round((this.tokenData.expiresAt - Date.now()) / 60000)),
    };
  }
}
