/**
 * Gemini usageMetadata -> 统一的 token 记账口径
 *
 * Gemini 字段语义：
 *   promptTokenCount         = 全部提示 token（已经【包含】cachedContentTokenCount）
 *   cachedContentTokenCount  = 提示中命中隐式/显式缓存的部分
 *   toolUsePromptTokenCount  = 工具调用结果回灌的提示 token（不含在 promptTokenCount 内）
 *   candidatesTokenCount     = 可见输出 token（【不含】思考 token）
 *   thoughtsTokenCount       = 思考 token（同样按输出计费）
 *
 * 本网关统一口径（与 Anthropic 一致）：
 *   input_tokens  = prompt + toolUse - cached      （未命中缓存的输入）
 *   cached_tokens = cached                          （= Anthropic cache_read_input_tokens）
 *   output_tokens = candidates + thoughts           （思考 token 计入输出）
 *   total_tokens  = input + cached + output         （= Gemini totalTokenCount，无重复计算）
 *   cache_hit_rate = cached / (input + cached)       （分母为 0 时为 null）
 */

const n = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

export function normalizeGeminiUsage(meta) {
  const m = meta || {};
  const prompt = n(m.promptTokenCount) + n(m.toolUsePromptTokenCount);
  const cached = Math.min(n(m.cachedContentTokenCount), prompt);
  const thoughts = n(m.thoughtsTokenCount);
  const output = n(m.candidatesTokenCount) + thoughts;
  const input = prompt - cached;
  return {
    input_tokens: input,
    cached_tokens: cached,
    output_tokens: output,
    thoughts_tokens: thoughts,
    total_tokens: input + cached + output,
  };
}

/**
 * 流式：usageMetadata 会在多个 chunk 中重复出现，且是【累计值】。
 * 按原始字段取最大值合并（绝不相加），最后再统一 normalize，避免 input/cached 各取各的最大值导致错配。
 */
export function mergeRawUsage(prev, meta) {
  if (!meta) return prev || null;
  const out = { ...(prev || {}) };
  for (const k of ['promptTokenCount', 'cachedContentTokenCount', 'toolUsePromptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']) {
    if (meta[k] !== undefined) out[k] = Math.max(n(out[k]), n(meta[k]));
  }
  return out;
}

export function cacheHitRate(input, cached) {
  const denom = (input || 0) + (cached || 0);
  return denom > 0 ? (cached || 0) / denom : null;
}

/** Anthropic usage 对象 */
export function toAnthropicUsage(u) {
  return {
    input_tokens: u?.input_tokens || 0,
    output_tokens: u?.output_tokens || 0,
    cache_read_input_tokens: u?.cached_tokens || 0,
    cache_creation_input_tokens: 0,
  };
}
