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

export interface OpenAIMessageRaw {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
  }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface OpenAIChatRequestRaw {
  model: string;
  messages: OpenAIMessageRaw[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  stop?: string | string[];
}

export class OpenAIAdapter {
  /**
   * Parse an incoming OpenAI /v1/chat/completions request into UnifiedChatRequest.
   */
  public static parseRequest(rawBody: OpenAIChatRequestRaw): UnifiedChatRequest {
    const body = stripCacheControl(rawBody);
    let systemPrompt: string | undefined;
    const messages: UnifiedMessage[] = [];

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        const textContent = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p) => p.text || '').join('\n')
            : '';
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${textContent}` : textContent;
        continue;
      }

      if (msg.role === 'tool') {
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: msg.tool_call_id || '',
              name: msg.name,
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            },
          ],
        });
        continue;
      }

      const parts: UnifiedPart[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            parts.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url;
            if (url.startsWith('data:')) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                parts.push({
                  type: 'image',
                  mediaType: match[1],
                  data: match[2],
                });
              }
            }
          }
        }
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments || '{}');
          } catch {
            parsedArgs = { raw: tc.function.arguments };
          }
          parts.push({
            type: 'tool_call',
            id: tc.id,
            name: tc.function.name,
            arguments: parsedArgs,
          });
        }
      }

      messages.push({
        role: msg.role,
        content: parts,
      });
    }

    const tools: UnifiedTool[] | undefined = body.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeJsonSchema(t.function.parameters || {}),
    }));

    const stopSequences = typeof body.stop === 'string' ? [body.stop] : body.stop;

    return {
      model: body.model,
      messages,
      systemPrompt,
      stream: body.stream ?? false,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      tools,
      stopSequences,
      rawBody: body as unknown as Record<string, unknown>,
    };
  }

  /**
   * Format UnifiedChatResponse into standard OpenAI JSON response.
   */
  public static formatResponse(res: UnifiedChatResponse, requestedModel?: string): Record<string, unknown> {
    const toolCalls = res.toolCalls?.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));

    return {
      id: res.id.startsWith('chatcmpl-') ? res.id : `chatcmpl-${res.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel || res.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: res.content || null,
            ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: res.finishReason === 'tool_calls' ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: res.usage.promptTokens,
        completion_tokens: res.usage.completionTokens,
        total_tokens: res.usage.totalTokens,
      },
    };
  }

  /**
   * Stream unified chunks to an OpenAI SSE client.
   */
  public static createStreamHandler(res: Response, model: string, completionId: string) {
    const id = completionId.startsWith('chatcmpl-') ? completionId : `chatcmpl-${completionId}`;
    const created = Math.floor(Date.now() / 1000);
    let hasSentInitial = false;

    const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      const payload = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    return {
      handleChunk(chunk: UnifiedChunk) {
        if (!hasSentInitial) {
          hasSentInitial = true;
          sendChunk({ role: 'assistant', content: '' });
        }

        if (chunk.text) {
          sendChunk({ content: chunk.text });
        }

        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          const formattedToolCalls = chunk.toolCalls.map((tc, index) => ({
            index,
            id: tc.id,
            type: 'function',
            function: {
              ...(tc.name ? { name: tc.name } : {}),
              arguments: tc.argumentsJson || '',
            },
          }));
          sendChunk({ tool_calls: formattedToolCalls });
        }
      },

      finish(finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop') {
        const reason = finishReason === 'tool_calls' ? 'tool_calls' : 'stop';
        sendChunk({}, reason);
        res.write('data: [DONE]\n\n');
      },
    };
  }
}
