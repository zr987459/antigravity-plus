/**
 * Antigravity+ Official Models Catalog (Clean & Modern 2026 Lineup)
 */

export const MODEL_LIST = [
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon (Google 当世前沿旗舰 / 100万上下文 + 100万长输出 / 自主工程智能体)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'google',
    context_window: 1000000,
    max_tokens: 1000000,
    reasoning: true,
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash (新一代最强大脑 Flash / 智能体架构深度优化)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'google',
    context_window: 1000000,
    max_tokens: 64000,
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash (官方网页版直驱底座 / 秒出字极速模型)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'google-web',
    context_window: 1000000,
    max_tokens: 64000,
  },
  {
    id: 'gemini-web-flash',
    name: 'Gemini Web Flash (Google 官方网页直驱 / Cookie免Key)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'google-web',
    context_window: 1000000,
    max_tokens: 64000,
  },
  {
    id: 'gemini-web-thinking',
    name: 'Gemini Web Thinking (Google 官方网页深度思考模式)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'google-web',
    context_window: 1000000,
    max_tokens: 64000,
    reasoning: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude 3.7 / 4.6 Sonnet (混合推理高优直连)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'anthropic',
    context_window: 1000000,
    max_tokens: 128000,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (深度规划与复杂架构)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'anthropic',
    context_window: 1000000,
    max_tokens: 128000,
  }
];

export function getModelsResponse() {
  return {
    object: 'list',
    data: MODEL_LIST,
    models: MODEL_LIST,
  };
}
