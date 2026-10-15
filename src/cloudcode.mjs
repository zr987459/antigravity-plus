/**
 * Google Cloud Code / Antigravity Dispatcher
 */

import crypto from 'crypto';
import { convertAnthropicToGoogle } from './content-converter.mjs';
import { resolveSessionId } from './session-router.mjs';

// 稳定会话 ID：Antigravity 的提示缓存按「账号 + sessionId」划分，同一对话必须每轮带同一个 sessionId 才能命中。
// 与 CLIProxyAPI 一致：sha256(首条用户消息文本) 取前 8 字节，屏蔽符号位，前缀 "-"。
export function stableSessionId(anthropicRequest) {
  const first = (anthropicRequest.messages || []).find(m => m.role === 'user');
  let text = '';
  if (first) {
    if (typeof first.content === 'string') text = first.content;
    else if (Array.isArray(first.content)) text = first.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
  }
  if (!text) text = JSON.stringify(first || anthropicRequest.system || '');
  const d = crypto.createHash('sha256').update(text, 'utf8').digest();
  return '-' + (d.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
}

// 模型别名与降级链映射表 (当 Claude 3P 配额耗尽时，无缝降级到 Gemini 旗舰以防中断)
export const MODEL_FALLBACK_CHAINS = {
  'gemini-3.8-flash-fast': ['gemini-2.5-flash', 'gemini-3-flash'],
  'gemini-3.8-flash-high': ['gemini-3-flash', 'gemini-2.5-flash-thinking'],
  'gemini-3.8-flash': ['gemini-3-flash', 'gemini-2.5-flash'],
  'gemini-3.1-pro-high': ['gemini-3.1-pro-low', 'gemini-2.5-pro'],
  'claude-opus-4-6': ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3.8-flash-tiered'],
  'claude-sonnet-4-6': ['claude-opus-4-6-thinking', 'gemini-3.8-flash-tiered'],
};

// 官方底层模型标识映射
export function mapToUpstreamModel(clientModel = '') {
  const m = clientModel.toLowerCase();
  // 保持同源模型一致性：3.8-flash 家族（fast/low/medium/high/tiered）统一映射至 gemini-3.8-flash-tiered，
  // 确保用户在中途切换到极速出字模式（fast）时，既有几十万 Token 的前缀 KV-Cache 绝不丢失！
  if (m.includes('3.8-flash') || m.includes('flash-fast')) return 'gemini-3.8-flash-tiered';
  if (m.includes('3.6-flash')) return 'gemini-3.6-flash-high';
  if (m.includes('3.1-pro')) return 'gemini-3.1-pro-high';
  if (m.includes('2.5-flash')) return 'gemini-2.5-flash-thinking';
  if (m.includes('claude-opus')) return 'claude-opus-4-6-thinking';
  if (m.includes('claude-sonnet')) return 'claude-sonnet-4-6';
  return clientModel;
}

export function buildAntigravityHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/1.10.2 linux/arm64',
    'X-Client-Name': 'antigravity',
    'Connection': 'keep-alive',
  };
}

// 递归对对象属性按字母排序（Canonical JSON 规范化，确保字节流序列化 100% 幂等一致）
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

export function buildCloudCodePayload(anthropicRequest, project = '') {
  const { contents, systemInstruction, tools } = convertAnthropicToGoogle(anthropicRequest);
  const upstreamModel = mapToUpstreamModel(anthropicRequest.model);
  const hasTools = Boolean(tools && tools.length > 0);

  const generationConfig = {
    maxOutputTokens: anthropicRequest.max_tokens || 8192,
    temperature: anthropicRequest.temperature ?? 0.7,
  };

  // 思考模式配置 (支持 Anthropic Extended Thinking 规范及模型自带思考)
  const isHighReasoning = anthropicRequest.model && (
    anthropicRequest.model.includes('high') ||
    anthropicRequest.model.includes('thinking') ||
    anthropicRequest.model.includes('opus')
  );

  // 思考配置：
  //  - Gemini 3.x：用 thinkingLevel 选档（OmniRoute / AIClient2API 同款）。档位取客户端模型名后缀
  //    -low/-medium/-high，没写默认 high（与上游默认 thinkingBudget:-1 实测思考量一致）。
  //    实测 tiered：low≈100 / high≈345 thought tokens；thinkingBudget:0 并不能关掉思考，只是变浅。
  //    有无工具一致，不再在带工具时压低思考（无主流实现这样做）。
  //  - fast 模型（映射到 gemini-2.5-flash）保持 0 思考。
  const isGemini3 = /^gemini-3/.test(upstreamModel) || upstreamModel === 'gemini-pro-agent';
  const levelMatch = String(anthropicRequest.model || '').match(/-(low|medium|high)\b/);
  if (anthropicRequest.model && anthropicRequest.model.includes('fast')) {
    // 3.8-flash fast 模式：保持 tiered 统一模型以复用长缓存，同时配置最低思考等级（low），实现极速吐字
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: 'low', thinkingBudget: 0 };
  } else if (isGemini3) {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: levelMatch ? levelMatch[1] : 'high' };
  } else if (anthropicRequest.thinking && anthropicRequest.thinking.type === 'enabled') {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: anthropicRequest.thinking.budget_tokens || 2048 };
  } else if (hasTools) {
    // Claude 等非 Gemini 3 模型：保持原有行为（带工具且客户端未要求思考时不思考）
    generationConfig.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
  } else if (isHighReasoning) {
    const isSonnet = anthropicRequest.model.includes('sonnet');
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: isSonnet ? 1024 : 2048 };
  }

  const request = {
    contents,
    generationConfig,
  };

  if (systemInstruction) {
    request.systemInstruction = systemInstruction;
  }
  if (hasTools) {
    request.tools = tools;
    // 注入 Google 工具派发模式 (Claude 采用 VALIDATED 模式，Gemini 采用 AUTO 模式)
    const isClaude = Boolean(anthropicRequest.model && anthropicRequest.model.toLowerCase().includes('claude'));
    request.toolConfig = {
      functionCallingConfig: {
        mode: isClaude ? 'VALIDATED' : 'AUTO',
      },
    };
  }

  request.sessionId = resolveSessionId(anthropicRequest, anthropicRequest._gwEmail || '');
  const payload = {
    model: upstreamModel,
    userAgent: 'antigravity',
    requestId: 'agent-' + crypto.randomUUID(),
    request: canonicalize(request),
  };
  if (project && project !== 'pending_detection') payload.project = project;
  return payload;
}
