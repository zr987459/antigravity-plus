/**
 * Real-time SSE Protocol Streamer (Google Chunked Stream -> Anthropic SSE Stream)
 */

import crypto from 'crypto';
import { signatureCache, FALLBACK_THOUGHT_SIGNATURE } from './signature-cache.mjs';
import { normalizeGeminiUsage, mergeRawUsage, toAnthropicUsage } from './usage.mjs';

/**
 * 将 Google 的流式输出逐块解析并转换为 Anthropic 标准 Server-Sent Events 事件
 *
 * onFinish(usage) 保证【恰好调用一次】：正常结束、上游中断、客户端断开都会回调。
 * usage = { input_tokens, cached_tokens, output_tokens, thoughts_tokens, total_tokens,
 *           ttft_ms, outcome: 'ok' | 'client_abort' | 'stream_error', error }
 */
export async function handleStreamConversion(upstreamRes, clientRes, originalModel, onFinish = null, startTime = Date.now()) {
  clientRes.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  clientRes.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  clientRes.setHeader('Connection', 'keep-alive');
  clientRes.setHeader('X-Accel-Buffering', 'no'); // 禁用反向代理（Nginx / Render / Cloudflare）的块缓冲，杜绝积攒到几 KB 才突发导致的 2 t/s 龟速卡顿
  clientRes.socket?.setNoDelay?.(true); // 禁用 Nagle 算法，确保微小思考块/字立刻发出
  clientRes.flushHeaders?.();

  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  let blockIndex = 0;
  let currentBlockType = null; // 'thinking' | 'text' | null
  let hasEmittedStart = false;
  let stopReason = 'end_turn';

  let rawUsage = null;         // 合并后的原始 usageMetadata（累计值取最大）
  let firstTokenAt = 0;        // 首个内容 token 到达时间（TTFT）
  let finished = false;
  let clientGone = false;
  const usageNow = () => normalizeGeminiUsage(rawUsage);
  const finish = (outcome, error = null) => {
    if (finished) return;
    finished = true;
    if (typeof onFinish === 'function') {
      try {
        onFinish({ ...usageNow(), ttft_ms: firstTokenAt ? firstTokenAt - startTime : null, outcome, error });
      } catch (e) { console.error('[Stream onFinish Error]', e); }
    }
  };

  let latestSeenSignature = FALLBACK_THOUGHT_SIGNATURE;
  let thinkingHasSignature = false;

  const sendEvent = (event, data) => {
    if (clientGone) return;
    clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    clientRes.flush?.();
  };

  const emitStart = () => {
    if (hasEmittedStart) return;
    hasEmittedStart = true;
    sendEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: originalModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { ...toAnthropicUsage(usageNow()), output_tokens: 1 },
      },
    });
  };

  const closeCurrentBlock = () => {
    if (currentBlockType !== null) {
      if (currentBlockType === 'thinking' && !thinkingHasSignature) {
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'signature_delta',
            signature: latestSeenSignature || FALLBACK_THOUGHT_SIGNATURE,
          },
        });
        thinkingHasSignature = true;
      }

      sendEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
      currentBlockType = null;
      thinkingHasSignature = false;
    }
  };

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 客户端提前断开：停止读取上游，按已收到的 usage 记一次
  const onClientClose = () => {
    if (clientRes.writableFinished) return;
    clientGone = true;
    reader.cancel().catch(() => {});
  };
  clientRes.on?.('close', onClientClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let jsonStr = trimmed;
        if (jsonStr.startsWith('data:')) {
          jsonStr = jsonStr.slice(5).trim();
        }
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let chunk;
        try {
          chunk = JSON.parse(jsonStr);
        } catch (e) {
          continue;
        }

        const inner = chunk.response || chunk;
        if (inner.usageMetadata) {
          rawUsage = mergeRawUsage(rawUsage, inner.usageMetadata);
        }

        const candidate = inner?.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        // 1. 发送 message_start 事件
        if (parts.length > 0) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          emitStart();
        }

        // 2. 遍历各 part 分段处理
        for (const part of parts) {
          const sig = part.thoughtSignature || part.thought_signature;
          if (sig) {
            latestSeenSignature = sig;
          }

          if (part.text !== undefined) {
            const isThought = part.thought === true;
            const targetType = isThought ? 'thinking' : 'text';

            if (currentBlockType !== targetType) {
              closeCurrentBlock();
              currentBlockType = targetType;
              sendEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: isThought
                  ? { type: 'thinking', thinking: '' }
                  : { type: 'text', text: '' },
              });
            }

            if (part.text) {
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: isThought
                  ? { type: 'thinking_delta', thinking: part.text }
                  : { type: 'text_delta', text: part.text },
              });
            }

            if (isThought && sig) {
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'signature_delta', signature: sig },
              });
              thinkingHasSignature = true;
            }
          } else if (part.functionCall) {
            closeCurrentBlock();
            stopReason = 'tool_use';
            const callId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
            const actualSig = sig || latestSeenSignature || FALLBACK_THOUGHT_SIGNATURE;

            signatureCache.set(callId, actualSig, part.functionCall.name);

            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: callId,
                name: part.functionCall.name,
                input: {},
              },
            });

            const argsStr = JSON.stringify(part.functionCall.args || {});
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: argsStr,
              },
            });

            closeCurrentBlock();
          }
        }
      }
    }

    if (clientGone) {
      finish('client_abort', '客户端提前断开');
      return;
    }

    emitStart(); // 上游没有任何 part 时也保证事件序列完整
    closeCurrentBlock();

    // 3. 终结事件（message_delta.usage 为累计值，带上最终的 input/cache 数）
    const finalUsage = toAnthropicUsage(usageNow());
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: finalUsage,
    });

    sendEvent('message_stop', {
      type: 'message_stop',
    });

    finish('ok');
    clientRes.end();
  } catch (err) {
    if (clientGone) {
      finish('client_abort', '客户端提前断开');
    } else {
      console.error('[Stream Processing Error]', err);
      finish('stream_error', String(err?.message || err).slice(0, 100));
    }
    try {
      clientRes.end();
    } catch (e) {}
  } finally {
    clientRes.off?.('close', onClientClose);
    finish('ok'); // 兜底（已调用过则无操作）
  }
}
