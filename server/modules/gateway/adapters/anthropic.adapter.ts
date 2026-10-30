import type { Response } from 'express';

import type {
  UnifiedChatRequest,
  UnifiedChatResponse,
  UnifiedChunk,
  UnifiedMessage,
  UnifiedPart,
  UnifiedTool,
} from '../types.js';

import { sanitizeJsonSchema, stripCacheControl } from './schema.cleaner.js';
import { cleanSystemPrompt, scrubVendorIdentities } from './prompt.scrubber.js';

export interface AnthropicContentPart {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentPart[];
  is_error?: boolean;
}

export interface AnthropicRawMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentPart[];
}

export interface AnthropicRawRequest {
  model: string;
  messages: AnthropicRawMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  stop_sequences?: string[];
}

export class AnthropicAdapter {
  /**
   * Parse an incoming Anthropic /v1/messages request body into UnifiedChatRequest.
   */
  public static parseRequest(rawBody: AnthropicRawRequest): UnifiedChatRequest {
    const body = stripCacheControl(rawBody);

    let systemPrompt: string | undefined;
    if (typeof body.system === 'string') {
      systemPrompt = body.system;
    } else if (Array.isArray(body.system)) {
      systemPrompt = body.system
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n');
    }

    if (systemPrompt) {
      systemPrompt = cleanSystemPrompt(systemPrompt);
    }

    const messages: UnifiedMessage[] = (body.messages || []).map((msg) => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
          content: msg.content,
        };
      }

      const parts: UnifiedPart[] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image' && part.source?.data) {
          parts.push({
            type: 'image',
            mediaType: part.source.media_type || 'image/png',
            data: part.source.data,
          });
        } else if (part.type === 'tool_use' && part.id && part.name) {
          parts.push({
            type: 'tool_call',
            id: part.id,
            name: part.name,
            arguments: part.input || {},
          });
        } else if (part.type === 'tool_result' && part.tool_use_id) {
          let textResult = '';
          if (typeof part.content === 'string') {
            textResult = part.content;
          } else if (Array.isArray(part.content)) {
            textResult = part.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text)
              .join('\n');
          }
          parts.push({
            type: 'tool_result',
            toolCallId: part.tool_use_id,
            content: textResult,
            isError: part.is_error,
          });
        }
      }

      return {
        role: msg.role,
        content: parts,
      };
    });

    const tools: UnifiedTool[] | undefined = body.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: sanitizeJsonSchema(t.input_schema || {}),
    }));

    let thinkingBudget: number | undefined;
    const rawThinking = (rawBody as any).thinking;
    if (rawThinking?.type === 'enabled' && typeof rawThinking.budget_tokens === 'number') {
      thinkingBudget = rawThinking.budget_tokens;
    }

    return {
      model: body.model,
      messages,
      systemPrompt,
      stream: body.stream ?? false,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      tools,
      stopSequences: body.stop_sequences,
      thinkingBudget,
      rawBody: body as unknown as Record<string, unknown>,
    };
  }

  /**
   * Format UnifiedChatResponse into Anthropic JSON response.
   */
  public static formatResponse(res: UnifiedChatResponse, requestedModel?: string): Record<string, unknown> {
    const content: Array<Record<string, unknown>> = [];

    if (res.thinking) {
      content.push({
        type: 'thinking',
        thinking: res.thinking,
      });
    }

    if (res.content) {
      content.push({
        type: 'text',
        text: res.content,
      });
    }

    if (res.toolCalls && res.toolCalls.length > 0) {
      for (const tc of res.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
    }

    let stopReason = 'end_turn';
    if (res.finishReason === 'tool_calls') {
      stopReason = 'tool_use';
    } else if (res.finishReason === 'length') {
      stopReason = 'max_tokens';
    }

    return {
      id: res.id.startsWith('msg_') ? res.id : `msg_${res.id}`,
      type: 'message',
      role: 'assistant',
      model: requestedModel || res.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: res.usage.promptTokens,
        output_tokens: res.usage.completionTokens,
      },
    };
  }

  /**
   * Stream unified chunks to an Anthropic SSE client.
   */
  public static createStreamHandler(res: Response, model: string, messageId: string) {
    let blockIndex = 0;
    let hasSentMessageStart = false;
    let textBlockStarted = false;
    let thinkingBlockStarted = false;
    let activeToolIndex: number | null = null;
    let activeToolId: string | null = null;
    let totalOutputTokens = 0;

    const sendEvent = (event: string, data: Record<string, unknown>) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ensureMessageStart = (promptTokens = 10) => {
      if (!hasSentMessageStart) {
        hasSentMessageStart = true;
        sendEvent('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: promptTokens,
              output_tokens: 1,
            },
          },
        });
      }
    };

    return {
      handleChunk(chunk: UnifiedChunk) {
        ensureMessageStart(chunk.usage?.promptTokens || 10);

        // 1. Thinking block delta
        if (chunk.thinking) {
          if (!thinkingBlockStarted) {
            thinkingBlockStarted = true;
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex++,
              content_block: { type: 'thinking', thinking: '' },
            });
          }
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex - 1,
            delta: { type: 'thinking_delta', thinking: chunk.thinking },
          });
        }

        // Close thinking block if text arrives
        if (thinkingBlockStarted && chunk.text) {
          sendEvent('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex - 1,
          });
          thinkingBlockStarted = false;
        }

        // 2. Text block delta
        if (chunk.text) {
          if (!textBlockStarted) {
            textBlockStarted = true;
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex++,
              content_block: { type: 'text', text: '' },
            });
          }
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex - 1,
            delta: { type: 'text_delta', text: chunk.text },
          });
          totalOutputTokens += Math.max(1, Math.ceil(chunk.text.length / 4));
        }

        // 3. Tool call blocks
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          // If text was open, close it
          if (textBlockStarted) {
            sendEvent('content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex - 1,
            });
            textBlockStarted = false;
          }

          for (const tc of chunk.toolCalls) {
            if (activeToolIndex !== null && activeToolId !== tc.id && tc.name) {
              sendEvent('content_block_stop', {
                type: 'content_block_stop',
                index: activeToolIndex,
              });
              activeToolIndex = null;
              activeToolId = null;
            }

            if (activeToolIndex === null) {
              activeToolIndex = blockIndex++;
              activeToolId = tc.id;
              sendEvent('content_block_start', {
                type: 'content_block_start',
                index: activeToolIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name || 'unknown_tool',
                  input: {},
                },
              });
            }

            if (tc.argumentsJson) {
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: activeToolIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: tc.argumentsJson,
                },
              });
            }
          }
        }
      },

      finish(finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop', finalOutputTokens?: number) {
        if (!hasSentMessageStart) {
          ensureMessageStart();
        }

        if (textBlockStarted) {
          sendEvent('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex - 1,
          });
        }

        if (thinkingBlockStarted) {
          sendEvent('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex - 1,
          });
        }

        if (activeToolIndex !== null) {
          sendEvent('content_block_stop', {
            type: 'content_block_stop',
            index: activeToolIndex,
          });
          activeToolIndex = null;
          activeToolId = null;
        }

        let stopReason = 'end_turn';
        if (finishReason === 'tool_calls') {
          stopReason = 'tool_use';
        } else if (finishReason === 'length') {
          stopReason = 'max_tokens';
        }

        sendEvent('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
          },
          usage: {
            output_tokens: finalOutputTokens || Math.max(1, totalOutputTokens),
          },
        });

        sendEvent('message_stop', {
          type: 'message_stop',
        });
      },
    };
  }
}
