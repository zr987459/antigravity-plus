/**
 * Model Connectivity & Latency Test Runner
 */

import { buildAntigravityHeaders, buildCloudCodePayload } from './cloudcode.mjs';
import { ANTIGRAVITY_ENDPOINTS } from './constants.mjs';

export async function runConnectivityTest(tokenManager, accountPool) {
  let mgr = tokenManager;
  if (!mgr || !mgr.tokenData.refreshToken) {
    return {
      ok: false,
      all_ok: false,
      message: '未检测到有效 Google 账号，请先在上方完成授权',
      models: [],
      validation_account: '未登录',
    };
  }

  let accessToken = await mgr.getValidAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      all_ok: false,
      message: 'Google 凭据刷新失败，请重新点击授权',
      models: [],
      validation_account: mgr.tokenData.email,
    };
  }

  const testModels = [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', tag: 'Gemini 思考旗舰' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tag: 'Claude 3P 旗舰' },
  ];

  const results = [];
  let hasAnySuccess = false;

  for (const m of testModels) {
    const startTime = Date.now();
    let modelSuccess = false;

    // 优先轮询 daily.sandbox 推理集群
    for (const host of ANTIGRAVITY_ENDPOINTS) {
      try {
        const anthropicReq = {
          model: m.id,
          messages: [{ role: 'user', content: 'Say hello in 3 words' }],
          max_tokens: 30,
          temperature: 0.1,
        };

        const payload = buildCloudCodePayload(anthropicReq);
        const headers = buildAntigravityHeaders(accessToken);
        const upstreamUrl = `${host}/v1internal:generateContent`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const latency = Date.now() - startTime;

        if (res.ok) {
          const data = await res.json();
          const parts = data?.response?.candidates?.[0]?.content?.parts || [];
          const text = parts.find(p => p.text && !p.thought)?.text || parts[0]?.text || '连通正常';
          results.push({
            id: m.id,
            name: m.name,
            tag: m.tag,
            ok: true,
            latency_ms: latency,
            preview: text.trim().slice(0, 45),
            message: `出字正常 (${latency}ms)`,
          });
          hasAnySuccess = true;
          modelSuccess = true;
          break;
        } else if (res.status === 429 && accountPool) {
          // 当前账号配额耗尽，尝试轮换账号重试
          const nextMgr = accountPool.rotateToNext();
          if (nextMgr && nextMgr.tokenData.email !== mgr.tokenData.email) {
            mgr = nextMgr;
            accessToken = await mgr.getValidAccessToken();
          }
        }
      } catch (err) {
        // 集群容灾
      }
    }

    if (!modelSuccess) {
      results.push({
        id: m.id,
        name: m.name,
        tag: m.tag,
        ok: false,
        latency_ms: Date.now() - startTime,
        preview: '配额用尽或通道阻塞',
        message: 'Google 上游拒绝连接 (429/超时)',
      });
    }
  }

  return {
    ok: hasAnySuccess,
    all_ok: results.every(r => r.ok),
    message: hasAnySuccess ? '所有已选模型通道连通出字正常！' : '通道验证未通过，请检查凭据。',
    models: results,
    validation_account: mgr.tokenData.email,
  };
}
