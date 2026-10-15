/**
 * Google Gemini Web2API Provider for Antigravity+
 * 基于 Google Gemini 官方网页版 StreamGenerate 协议转换
 * 支持免 API Key 直接使用 CookieBox 提取的官方 Cookie 调用原生 Gemini 4 / 3.8 / 3.6 模型
 * 内置 XSRF Token 自愈机制与 Function Calling 工具调用捕获解析器
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const GEMINI_BASE = 'https://gemini.google.com';

export class GeminiWebAccountManager {
  constructor(storageFile) {
    this.storageFile = storageFile;
    this.accounts = [];
    this.activeId = '';
    this.rrIndex = 0;
    this.init();
  }

  init() {
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf-8');
        this.accounts = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[GeminiWebProvider] 读取账号配置失败:', e.message);
    }

    if (!Array.isArray(this.accounts)) this.accounts = [];
    if (this.accounts.length > 0 && !this.activeId) {
      const act = this.accounts.find(a => a.active);
      this.activeId = act ? act.id : this.accounts[0].id;
    }
  }

  save() {
    try {
      fs.writeFileSync(this.storageFile, JSON.stringify(this.accounts, null, 2), 'utf-8');
    } catch (e) {
      console.error('[GeminiWebProvider] 保存账号配置失败:', e);
    }
  }

  static parseSapisid(cookieStr) {
    const m = cookieStr.match(/SAPISID=([^;]+)/);
    return m ? m[1].trim() : '';
  }

  static makeSapisidHash(sapisid) {
    if (!sapisid) return '';
    const ts = Math.floor(Date.now() / 1000);
    const str = `${ts} ${sapisid} https://gemini.google.com`;
    const h = crypto.createHash('sha1').update(str).digest('hex');
    return `SAPISIDHASH ${ts}_${h}`;
  }

  getAvailableAccount() {
    if (this.accounts.length === 0) return null;
    const available = this.accounts.filter(a => a.active !== false && a.cookie);
    if (available.length === 0) return this.accounts[0] || null;

    const acc = available[this.rrIndex % available.length];
    this.rrIndex = (this.rrIndex + 1) % available.length;
    return acc;
  }

  addAccount({ name, cookie, email = '' }) {
    const id = `gem_web_${crypto.randomBytes(6).toString('hex')}`;
    const sapisid = GeminiWebAccountManager.parseSapisid(cookie);

    let autoName = name;
    if (!autoName) {
      const psidMatch = cookie.match(/__Secure-1PSID=([^;]+)/);
      autoName = psidMatch ? `Gemini-${psidMatch[1].slice(2, 8)}` : `Gemini-${id.slice(-6)}`;
    }

    const account = {
      id,
      name: autoName,
      email: email || '',
      cookie: cookie.trim(),
      sapisid: sapisid || '',
      active: true,
      snlm0e: '',
      bl: 'boq_gemini-web-uiserver_20261013.29_p0',
      lastRefreshed: 0,
      addedAt: Date.now(),
      lastUsed: 0,
    };

    if (this.accounts.length === 0) {
      this.activeId = id;
    }

    this.accounts.push(account);
    this.save();
    return account;
  }

  removeAccount(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
    if (this.activeId === id) {
      this.activeId = this.accounts.length > 0 ? this.accounts[0].id : '';
    }
    this.save();
  }

  switchAccount(id) {
    const acc = this.accounts.find(a => a.id === id);
    if (acc) {
      this.activeId = id;
      acc.active = true;
      this.save();
      return acc;
    }
    return null;
  }

  async refreshAccountTokens(acc) {
    const sapisid = acc.sapisid || GeminiWebAccountManager.parseSapisid(acc.cookie);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Cookie: acc.cookie,
      Authorization: GeminiWebAccountManager.makeSapisidHash(sapisid),
      Referer: 'https://gemini.google.com/',
    };

    const resp = await fetch('https://gemini.google.com/app', {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      throw new Error(`Google 页面响应异常 HTTP ${resp.status}`);
    }
    const html = await resp.text();
    const snlm0eMatch = html.match(/"SNlM0e":"([^"]+)"/);
    const blMatch = html.match(/"cfb2h":"([^"]+)"/);

    if (snlm0eMatch) acc.snlm0e = snlm0eMatch[1];
    if (blMatch) acc.bl = blMatch[1];
    acc.lastRefreshed = Date.now();
    this.save();
    return { snlm0e: acc.snlm0e, bl: acc.bl };
  }

  async testAccount(id) {
    const acc = this.accounts.find(a => a.id === id);
    if (!acc) return { ok: false, error: '账号不存在' };

    const t0 = Date.now();
    try {
      const res = await this.refreshAccountTokens(acc);
      const latency = Date.now() - t0;
      if (res.snlm0e) {
        acc.lastUsed = Date.now();
        this.save();
        return {
          ok: true,
          latency,
          snlm0e: res.snlm0e.slice(0, 10) + '...',
          bl: res.bl,
          preview: `连通正常 · 已获鉴权令牌 (${latency}ms)`,
        };
      } else {
        return { ok: false, error: 'Cookie 已过期或未能提取到 SNlM0e 令牌' };
      }
    } catch (e) {
      return { ok: false, latency: Date.now() - t0, error: e.message || '网络超时' };
    }
  }

  list() {
    return this.accounts.map(a => ({
      id: a.id,
      name: a.name,
      email: a.email || 'Google 账号',
      active: a.active !== false,
      isPrimary: a.id === this.activeId,
      lastUsed: a.lastUsed || 0,
      addedAt: a.addedAt || 0,
      hasCookie: Boolean(a.cookie),
      hasSnlm0e: Boolean(a.snlm0e),
      cookieMasked: a.cookie ? `${a.cookie.slice(0, 18)}...${a.cookie.slice(-8)}` : '',
    }));
  }
}

export function isGeminiWebModel(modelName) {
  if (!modelName) return false;
  const m = String(modelName).toLowerCase();
  return (
    m.includes('gemini-web') ||
    m.includes('gemini-3.6') ||
    m.includes('gemini-3.8') ||
    m.includes('gemini-4-argon')
  );
}

function formatToolsInstruction(tools, toolChoice = 'auto') {
  if (!Array.isArray(tools) || tools.length === 0 || toolChoice === 'none') return '';
  const toolDefs = tools.map(t => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || fn.input_schema || {},
    };
  });

  let requirementNote = 'Autonomously determine if a tool is required to satisfy the user query accurately.';
  if (typeof toolChoice === 'object' && toolChoice?.function?.name) {
    requirementNote = `You MUST invoke the specific tool: "${toolChoice.function.name}".`;
  } else if (toolChoice === 'required') {
    requirementNote = 'You MUST invoke at least one tool before concluding your response.';
  }

  return (
    `[Tools Available]\n` +
    `You are equipped with the following autonomous tools:\n` +
    JSON.stringify(toolDefs, null, 2) + `\n\n` +
    `[Tool Calling Protocol]\n` +
    `1. ${requirementNote}\n` +
    `2. If you need to invoke tools, output a dedicated code block formatted strictly as:\n` +
    `\`\`\`tool_call\n` +
    `{"name": "tool_name", "arguments": {<valid_json_arguments>}}\n` +
    `\`\`\`\n` +
    `3. You may invoke multiple tool calls in parallel if necessary.\n` +
    `4. If no tools are required, answer directly in natural language without using tool_call blocks.\n\n`
  );
}

function parseToolCalls(text) {
  const toolCalls = [];
  const patterns = [
    /```tool_call\s*\n([\s\S]*?)\n```/g,
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
  ];

  let clean = text;
  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(text)) !== null) {
      try {
        const rawJson = match[1].trim();
        const data = JSON.parse(rawJson);
        if (data && data.name) {
          toolCalls.push({
            id: `call_${crypto.randomBytes(6).toString('hex')}`,
            type: 'function',
            name: data.name,
            arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {}),
            parsedArgs: data.arguments || {},
          });
        }
      } catch (_) {}
    }
    clean = clean.replace(pat, '').trim();
  }

  // Fallback: 如果模型直接用 json 代码块输出 {"name": "...", "arguments": ...}
  if (toolCalls.length === 0) {
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/g;
    let jm;
    while ((jm = jsonBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(jm[1].trim());
        if (parsed && parsed.name && (parsed.arguments || parsed.parameters)) {
          toolCalls.push({
            id: `call_${crypto.randomBytes(6).toString('hex')}`,
            type: 'function',
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || parsed.parameters || {}),
            parsedArgs: parsed.arguments || parsed.parameters || {},
          });
          clean = clean.replace(jm[0], '').trim();
        }
      } catch (_) {}
    }
  }

  return { cleanText: clean, toolCalls };
}

function extractPromptFromMessages(messages, tools, toolChoice) {
  let prompt = '';
  if (tools && tools.length > 0) {
    prompt += formatToolsInstruction(tools, toolChoice);
  }
  if (!Array.isArray(messages) || messages.length === 0) return prompt;

  const parts = [];
  for (const m of messages) {
    const role = m.role || 'user';
    let text = '';
    const toolResults = [];

    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const textParts = [];
      for (const c of m.content) {
        if (typeof c === 'string') {
          textParts.push(c);
        } else if (c.type === 'text') {
          textParts.push(c.text || '');
        } else if (c.type === 'tool_result') {
          toolResults.push(`[Tool Result for ${c.tool_use_id || 'tool'}]: ${typeof c.content === 'string' ? c.content : JSON.stringify(c.content)}`);
        }
      }
      text = textParts.join('\n');
    }

    if (role === 'system') {
      parts.push(`[System]: ${text}`);
    } else if (role === 'assistant') {
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        const callsStr = m.tool_calls.map(tc => {
          const fn = tc.function || tc;
          return `\`\`\`tool_call\n{"name": "${fn.name}", "arguments": ${fn.arguments}}\n\`\`\``;
        }).join('\n');
        parts.push(`[Assistant]: ${text ? text + '\n' : ''}${callsStr}`);
      } else {
        parts.push(`[Assistant]: ${text}`);
      }
    } else if (role === 'tool') {
      parts.push(`[Tool Result for ${m.name || m.tool_call_id || 'tool'}]: ${text}`);
    } else {
      let uMsg = text ? `[User]: ${text}` : '';
      if (toolResults.length > 0) {
        uMsg += (uMsg ? '\n' : '') + toolResults.join('\n');
      }
      if (uMsg) parts.push(uMsg);
    }
  }

  return prompt + parts.join('\n\n');
}

export async function handleGeminiWebRequest(req, res, unifiedReq, accountManager, protocolType = 'openai') {
  const acc = accountManager.getAvailableAccount();
  if (!acc) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '暂无可用的 Gemini Web 账号，请在控制台录入 Cookie。' } }));
    return;
  }

  // 确保 SNlM0e 存在且不过期（每 30 分钟刷新一次）
  if (!acc.snlm0e || Date.now() - (acc.lastRefreshed || 0) > 30 * 60 * 1000) {
    try {
      await accountManager.refreshAccountTokens(acc);
    } catch (e) {
      console.warn('[GeminiWebProvider] 预刷新 SNlM0e 失败，尝试复用缓存:', e.message);
    }
  }

  const tools = unifiedReq.tools;
  const prompt = extractPromptFromMessages(unifiedReq.messages, tools, unifiedReq.tool_choice);
  const isStreaming = Boolean(unifiedReq.stream);
  const modelName = unifiedReq.model || 'gemini-web-flash';
  const sapisid = acc.sapisid || GeminiWebAccountManager.parseSapisid(acc.cookie);

  const inner = new Array(80).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ['zh-CN'];
  inner[2] = ['', '', '', null, null, null, null, null, null, ''];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]]; // 开启 thinking
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[45] = 1;
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;

  const outer = [null, JSON.stringify(inner)];
  const params = new URLSearchParams();
  params.set('f.req', JSON.stringify(outer));
  if (acc.snlm0e) {
    params.set('at', acc.snlm0e);
  }

  const reqid = Math.floor(Date.now() / 1000) % 1000000;
  const streamUrl = `${GEMINI_BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${acc.bl || 'boq_gemini-web-uiserver_20261013.29_p0'}&hl=zh-CN&_reqid=${reqid}&rt=c`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Cookie: acc.cookie,
    Authorization: GeminiWebAccountManager.makeSapisidHash(sapisid),
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/app',
    'X-Same-Domain': '1',
  };

  const messageId = `chatcmpl_${crypto.randomBytes(12).toString('hex')}`;

  try {
    let postResp = await fetch(streamUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
      signal: AbortSignal.timeout(60000),
    });

    let raw = await postResp.text();

    // 自愈机制：如果 Google 提示 XSRF 轮换过期 (400 / xsrf)
    if (!postResp.ok || raw.includes('BardErrorInfo') || raw.includes('xsrf')) {
      const xsrfMatch = raw.match(/\["xsrf","([^"]+)"/);
      if (xsrfMatch) {
        acc.snlm0e = xsrfMatch[1];
        accountManager.save();
        params.set('at', acc.snlm0e);
        // 携带新令牌立即重试
        postResp = await fetch(streamUrl, {
          method: 'POST',
          headers,
          body: params.toString(),
          signal: AbortSignal.timeout(60000),
        });
        raw = await postResp.text();
      }
    }

    if (!postResp.ok) {
      res.writeHead(postResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Google Gemini 响应异常 (${postResp.status}): ${raw.slice(0, 150)}` } }));
      return;
    }

    // 提取正文文本
    const texts = [];
    for (const line of raw.split('\n')) {
      if (!line.includes('"wrb.fr"') || line.length < 200) continue;
      try {
        const arr = JSON.parse(line);
        const innerData = JSON.parse(arr[0][2]);
        if (Array.isArray(innerData) && innerData.length > 4 && innerData[4]) {
          for (const part of innerData[4]) {
            if (Array.isArray(part) && part.length > 1 && Array.isArray(part[1])) {
              for (const t of part[1]) {
                if (typeof t === 'string' && t.length > 0) texts.push(t);
              }
            }
          }
        }
      } catch (_) {}
    }

    let fullReply = '';
    for (let i = texts.length - 1; i >= 0; i--) {
      if (texts[i].trim()) {
        fullReply = texts[i];
        break;
      }
    }

    if (!fullReply) {
      fullReply = '（Gemini 响应成功，未能解析到正文内容）';
    }

    // 工具调用解析 (如果有定义 tools)
    let cleanReply = fullReply;
    let toolCalls = [];
    if (tools && tools.length > 0) {
      const parsed = parseToolCalls(fullReply);
      cleanReply = parsed.cleanText;
      toolCalls = parsed.toolCalls;
    }

    const hasToolCalls = toolCalls.length > 0;

    // 组装输出
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.socket?.setNoDelay?.(true);
      res.flushHeaders?.();

      if (protocolType === 'openai') {
        res.write(
          `data: ${JSON.stringify({
            id: messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`
        );

        if (cleanReply) {
          const chunkSize = 16;
          for (let i = 0; i < cleanReply.length; i += chunkSize) {
            const chunk = cleanReply.slice(i, i + chunkSize);
            res.write(
              `data: ${JSON.stringify({
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
              })}\n\n`
            );
          }
        }

        if (hasToolCalls) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            res.write(
              `data: ${JSON.stringify({
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: i,
                          id: tc.id,
                          type: 'function',
                          function: { name: tc.name, arguments: tc.arguments },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              })}\n\n`
            );
          }
        }

        res.write(
          `data: ${JSON.stringify({
            id: messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // Anthropic SSE
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: modelName,
              content: [],
              stop_reason: null,
              usage: { input_tokens: prompt.length, output_tokens: 0 },
            },
          })}\n\n`
        );

        let blockIndex = 0;
        if (cleanReply) {
          res.write(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            })}\n\n`
          );

          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: cleanReply },
            })}\n\n`
          );

          res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${blockIndex}}\n\n`);
          blockIndex++;
        }

        if (hasToolCalls) {
          for (const tc of toolCalls) {
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
              })}\n\n`
            );

            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: tc.arguments },
              })}\n\n`
            );

            res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${blockIndex}}\n\n`);
            blockIndex++;
          }
        }

        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: hasToolCalls ? 'tool_use' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: fullReply.length },
          })}\n\n`
        );
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      }
    } else {
      // 非流式
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (protocolType === 'openai') {
        const msg = { role: 'assistant', content: cleanReply || null };
        if (hasToolCalls) {
          msg.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        res.end(
          JSON.stringify({
            id: messageId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
              {
                index: 0,
                message: msg,
                finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: prompt.length,
              completion_tokens: fullReply.length,
              total_tokens: prompt.length + fullReply.length,
            },
          })
        );
      } else {
        // Anthropic JSON
        const contentArr = [];
        if (cleanReply) contentArr.push({ type: 'text', text: cleanReply });
        if (hasToolCalls) {
          for (const tc of toolCalls) {
            contentArr.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.parsedArgs,
            });
          }
        }
        res.end(
          JSON.stringify({
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: modelName,
            content: contentArr,
            stop_reason: hasToolCalls ? 'tool_use' : 'end_turn',
            usage: {
              input_tokens: prompt.length,
              output_tokens: fullReply.length,
            },
          })
        );
      }
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Gemini Web 处理异常: ${e.message}` } }));
  }
}
