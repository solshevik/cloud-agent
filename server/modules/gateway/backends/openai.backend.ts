import type { GatewayBackend, UnifiedChatRequest, UnifiedChatResponse, UnifiedChunk } from '../types.js';
import { gatewayConfigService } from '../gateway.config.js';

export class OpenAIBackend implements GatewayBackend {
  public readonly id = 'openai';
  public readonly name = 'OpenAI Compatible API';

  public isConfigured(): boolean {
    const config = gatewayConfigService.getConfig();
    return Boolean(config.openaiApiKey || config.deepseekApiKey);
  }

  public supportsModel(model: string): boolean {
    const m = model.toLowerCase();
    return (
      m.includes('gpt') ||
      m.includes('o1') ||
      m.includes('o3') ||
      m.includes('deepseek') ||
      m.includes('qwen') ||
      m.includes('llama')
    );
  }

  private resolveEndpointAndKey(model: string): { baseUrl: string; apiKey: string } {
    const config = gatewayConfigService.getConfig();
    const isDeepSeek = model.toLowerCase().includes('deepseek');

    if (isDeepSeek && config.deepseekApiKey) {
      return {
        baseUrl: config.deepseekBaseUrl.replace(/\/+$/, ''),
        apiKey: config.deepseekApiKey,
      };
    }

    if (config.openaiApiKey) {
      return {
        baseUrl: config.openaiBaseUrl.replace(/\/+$/, ''),
        apiKey: config.openaiApiKey,
      };
    }

    if (config.deepseekApiKey) {
      return {
        baseUrl: config.deepseekBaseUrl.replace(/\/+$/, ''),
        apiKey: config.deepseekApiKey,
      };
    }

    throw new Error('Neither OpenAI nor DeepSeek API keys are configured.');
  }

  private buildOpenAIPayload(request: UnifiedChatRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];

    if (request.systemPrompt) {
      messages.push({
        role: 'system',
        content: request.systemPrompt,
      });
    }

    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        let textContent = '';
        const toolCalls: any[] = [];
        let toolResult: any = null;

        for (const part of msg.content) {
          if (part.type === 'text') {
            textContent += part.text;
          } else if (part.type === 'tool_call') {
            toolCalls.push({
              id: part.id,
              type: 'function',
              function: {
                name: part.name,
                arguments: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments),
              },
            });
          } else if (part.type === 'tool_result') {
            toolResult = part;
          }
        }

        if (toolResult) {
          messages.push({
            role: 'tool',
            tool_call_id: toolResult.toolCallId,
            content: toolResult.content,
          });
        } else {
          messages.push({
            role: msg.role,
            content: textContent,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
      }
    }

    const tools = request.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    return {
      model: request.model,
      messages,
      stream,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(request.stopSequences ? { stop: request.stopSequences } : {}),
    };
  }

  public async executeStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: UnifiedChunk) => void
  ): Promise<void> {
    const { baseUrl, apiKey } = this.resolveEndpointAndKey(request.model);
    const url = `${baseUrl}/chat/completions`;
    const payload = this.buildOpenAIPayload(request, true);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('No response body from OpenAI API stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const raw = trimmed.slice(6).trim();
          if (raw === '[DONE]') {
            onChunk({ finishReason: 'stop' });
            return;
          }

          try {
            const data = JSON.parse(raw);
            const choice = data.choices?.[0];
            const delta = choice?.delta;

            const chunk: UnifiedChunk = {};
            if (delta?.content) {
              chunk.text = delta.content;
            }
            if (delta?.reasoning_content) {
              chunk.thinking = delta.reasoning_content;
            }
            if (delta?.tool_calls) {
              chunk.toolCalls = delta.tool_calls.map((tc: any) => ({
                id: tc.id || `call_${Date.now()}`,
                name: tc.function?.name,
                argumentsJson: tc.function?.arguments || '',
              }));
            }
            if (choice?.finish_reason) {
              chunk.finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop';
            }
            if (data.usage) {
              chunk.usage = {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
              };
            }

            onChunk(chunk);
          } catch (err) {
            console.error('Error parsing OpenAI SSE chunk:', err, raw);
          }
        }
      }
    }
  }

  public async execute(request: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const { baseUrl, apiKey } = this.resolveEndpointAndKey(request.model);
    const url = `${baseUrl}/chat/completions`;
    const payload = this.buildOpenAIPayload(request, false);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];
    const message = choice?.message;

    const toolCalls = message?.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: JSON.parse(tc.function?.arguments || '{}'),
    }));

    return {
      id: data.id || `chatcmpl-${Date.now()}`,
      model: data.model || request.model,
      content: message?.content || '',
      thinking: message?.reasoning_content,
      toolCalls,
      finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
    };
  }
}
