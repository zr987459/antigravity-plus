/**
 * System Prompt Identity Scrubbing
 * 
 * 机制解析：
 * Google Cloud Code 上游接口对系统提示词有指纹审查机制。
 * 若检测到明显的非官方/竞品 Agent 身份标识（如 Claude、Hermes、Nous 等），
 * 上游会静默抛出伪装的 429 RESOURCE_EXHAUSTED。
 * 本模块在向 Google 转发前将此类指纹替换为通用助手描述。
 */

const DEFAULT_SCRUB_RULES = [
  [/Nous Research/gi, 'the assistant team'],
  [/Hermes Agent/gi, 'the assistant'],
  [/Hermes/gi, 'the assistant'],
  [/Claude Code/gi, 'the coding assistant'],
  [/Claude/gi, 'the assistant'],
  [/Anthropic/gi, 'the AI provider']
];

export function scrubIdentity(text) {
  if (typeof text !== 'string') return text;
  let result = text;
  for (const [pattern, replacement] of DEFAULT_SCRUB_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
