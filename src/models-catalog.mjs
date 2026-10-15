/**
 * Standard OpenAI & Anthropic Models Catalog with Fast Tiers & Hark Agent
 */

export const MODEL_LIST = [
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
    id: 'gemini-3.8-flash-fast',
    name: 'Gemini 3.8 Flash (极速秒出字模式)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity',
    context_window: 1000000,
    max_tokens: 64000,
  },
  {
    id: 'gemini-3.8-flash-high',
    name: 'Gemini 3.8 Flash High (深度思考旗舰)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity',
    context_window: 1000000,
    max_tokens: 64000,
    reasoning: true,
  },
  {
    id: 'gemini-3.8-flash-medium',
    name: 'Gemini 3.8 Flash Medium',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity',
    context_window: 1000000,
    max_tokens: 64000,
  },
  {
    id: 'gemini-3.8-flash-tiered',
    name: 'Gemini 3.8 Flash Tiered',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity',
    context_window: 1000000,
    max_tokens: 64000,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (高优直连)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity-3p',
    context_window: 1000000,
    max_tokens: 128000,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (深度规划)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity-3p',
    context_window: 1000000,
    max_tokens: 128000,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity-3p',
    context_window: 1000000,
    max_tokens: 64000,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity',
    context_window: 1000000,
    max_tokens: 64000,
  },
  // 兼容别名
  {
    id: 'hark-agent-pro',
    name: 'Hark Agent Pro (兼容别名)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'hark',
    context_window: 1000000,
    max_tokens: 128000,
    reasoning: true,
  },
  {
    id: 'claude-3-opus-hark',
    name: 'Claude 3 Opus Hark (兼容别名)',
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'hark',
    context_window: 1000000,
    max_tokens: 128000,
    reasoning: true,
  }
];

export function getModelsResponse() {
  return {
    object: 'list',
    data: MODEL_LIST,
    models: MODEL_LIST,
  };
}
