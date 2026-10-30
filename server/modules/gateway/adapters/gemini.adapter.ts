import type {
  UnifiedChatRequest,
  UnifiedChunk,
  UnifiedMessage,
  UnifiedPart,
  UnifiedTool,
} from '../types.js';

import { sanitizeJsonSchema } from './schema.cleaner.js';
import { cleanSystemPrompt, scrubVendorIdentities } from './prompt.scrubber.js';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiRequestPayload {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    thinkingConfig?: {
      thinkingBudget?: number;
    };
  };
}

export class GeminiAdapter {
  /**
   * Convert UnifiedChatRequest to Google Gemini REST request payload.
   */
  public static toGeminiPayload(req: UnifiedChatRequest): GeminiRequestPayload {
    const contents: GeminiContent[] = [];

    // Extract system prompt and any system-role messages into systemInstruction
    const systemParts: Array<{ text: string }> = [];
    if (req.systemPrompt) {
      const cleaned = cleanSystemPrompt(req.systemPrompt);
      if (cleaned) {
        systemParts.push({ text: cleaned });
      }
    }

    const nonSystemMessages: UnifiedMessage[] = [];
    for (const msg of req.messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n')
            : '';
        if (text.trim()) {
          const cleaned = cleanSystemPrompt(text.trim());
          if (cleaned) {
            systemParts.push({ text: cleaned });
          }
        }
      } else {
        nonSystemMessages.push(msg);
      }
    }

    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    if (systemParts.length > 0) {
      systemInstruction = { parts: systemParts };
    }

    // Build a map of tool call IDs to tool names to accurately resolve tool_result in Gemini
    const toolIdToNameMap = new Map<string, string>();
    for (const msg of nonSystemMessages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_call') {
            toolIdToNameMap.set(part.id, part.name);
          }
        }
      }
    }

    // Map only conversation turns (user & model) into contents
    for (const msg of nonSystemMessages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiPart[] = [];

      if (typeof msg.content === 'string') {
        if (msg.content.trim()) {
          parts.push({ text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            parts.push({ text: part.text });
          } else if (part.type === 'image') {
            parts.push({
              inlineData: {
                mimeType: part.mediaType,
                data: part.data,
              },
            });
          } else if (part.type === 'tool_call') {
            const argsObj = typeof part.arguments === 'string'
              ? JSON.parse(part.arguments || '{}')
              : part.arguments;
            parts.push({
              functionCall: {
                name: part.name,
                args: argsObj,
              },
            });
          } else if (part.type === 'tool_result') {
            const toolName = part.name || toolIdToNameMap.get(part.toolCallId) || req.tools?.[0]?.name || 'tool_response';
            let resContent: Record<string, unknown>;
            if (typeof part.content === 'object' && part.content !== null) {
              resContent = part.content as Record<string, unknown>;
            } else {
              try {
                const parsed = JSON.parse(part.content);
                resContent = typeof parsed === 'object' && parsed !== null ? parsed : { output: part.content };
              } catch {
                resContent = { output: part.content };
              }
            }
            parts.push({
              functionResponse: {
                name: toolName,
                response: resContent,
              },
            });
          }
        }
      }

      if (parts.length > 0) {
        // Merge with previous content block if same role (Gemini requires alternating or grouped roles)
        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === role) {
          lastContent.parts.push(...parts);
        } else {
          contents.push({ role, parts });
        }
      }
    }

    // Map tools with sanitized JSON schema
    let tools: GeminiRequestPayload['tools'];
    if (req.tools && req.tools.length > 0) {
      tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeJsonSchema(t.parameters),
          })),
        },
      ];
    }

    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature,
      maxOutputTokens: req.maxTokens,
      stopSequences: req.stopSequences,
    };

    if (req.thinkingBudget) {
      generationConfig.thinkingConfig = {
        thinkingBudget: req.thinkingBudget,
      };
    }

    return {
      contents,
      systemInstruction,
      tools,
      generationConfig,
    };
  }

  /**
   * Parse a Gemini response chunk or complete JSON into UnifiedChunk.
   */
  public static parseGeminiChunk(data: Record<string, unknown>): UnifiedChunk {
    const chunk: UnifiedChunk = {};
    const candidate = (data.candidates as any[])?.[0];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          if (part.thought) {
            chunk.thinking = (chunk.thinking || '') + part.text;
          } else {
            chunk.text = (chunk.text || '') + part.text;
          }
        }

        if (part.functionCall) {
          const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          chunk.toolCalls = chunk.toolCalls || [];
          chunk.toolCalls.push({
            id: callId,
            name: part.functionCall.name,
            argumentsJson: JSON.stringify(part.functionCall.args || {}),
          });
          chunk.finishReason = 'tool_calls';
        }
      }
    }

    if (candidate?.finishReason) {
      const reason = candidate.finishReason;
      if (reason === 'STOP') {
        chunk.finishReason = chunk.toolCalls && chunk.toolCalls.length > 0 ? 'tool_calls' : 'stop';
      } else if (reason === 'MAX_TOKENS') {
        chunk.finishReason = 'length';
      }
    }

    const metadata = data.usageMetadata as any;
    if (metadata) {
      chunk.usage = {
        promptTokens: metadata.promptTokenCount,
        completionTokens: metadata.candidatesTokenCount,
        totalTokens: metadata.totalTokenCount,
      };
    }

    return chunk;
  }
}
