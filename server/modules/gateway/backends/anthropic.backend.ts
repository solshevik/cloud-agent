import type { GatewayBackend, UnifiedChatRequest, UnifiedChatResponse, UnifiedChunk } from '../types.js';
import { gatewayConfigService } from '../gateway.config.js';

export class AnthropicBackend implements GatewayBackend {
  public readonly id = 'anthropic';
  public readonly name = 'Anthropic Claude API';

  public isConfigured(): boolean {
    const config = gatewayConfigService.getConfig();
    return Boolean(config.anthropicApiKey);
  }

  public supportsModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.includes('claude');
  }

  private buildAnthropicPayload(request: UnifiedChatRequest, stream: boolean): Record<string, unknown> {
    const messages = request.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((msg) => {
        if (typeof msg.content === 'string') {
          return { role: msg.role, content: msg.content };
        }
        const contentParts = (msg.content as any[]).map((p) => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
          if (p.type === 'tool_call') return { type: 'tool_use', id: p.id, name: p.name, input: p.arguments };
          if (p.type === 'tool_result') return { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, is_error: p.isError };
          return p;
        });
        return { role: msg.role, content: contentParts };
      });

    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    return {
      model: request.model,
      messages,
      system: request.systemPrompt,
      stream,
      temperature: request.temperature,
      max_tokens: request.maxTokens || 4096,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
    };
  }

  public async executeStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: UnifiedChunk) => void
  ): Promise<void> {
    const config = gatewayConfigService.getConfig();
    const apiKey = config.anthropicApiKey;
    if (!apiKey) {
      throw new Error('Anthropic API key is not configured.');
    }

    const url = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/messages`;
    const payload = this.buildAnthropicPayload(request, true);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('No response body from Anthropic stream.');
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
          try {
            const data = JSON.parse(raw);
            const chunk: UnifiedChunk = {};

            if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta') {
                chunk.text = data.delta.text;
              } else if (data.delta?.type === 'thinking_delta') {
                chunk.thinking = data.delta.thinking;
              } else if (data.delta?.type === 'input_json_delta') {
                chunk.toolCalls = [
                  {
                    id: `call_${data.index}`,
                    argumentsJson: data.delta.partial_json,
                  },
                ];
              }
            } else if (data.type === 'content_block_start') {
              if (data.content_block?.type === 'tool_use') {
                chunk.toolCalls = [
                  {
                    id: data.content_block.id,
                    name: data.content_block.name,
                    argumentsJson: '',
                  },
                ];
              }
            } else if (data.type === 'message_delta') {
              if (data.delta?.stop_reason) {
                chunk.finishReason = data.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';
              }
              if (data.usage) {
                chunk.usage = { completionTokens: data.usage.output_tokens };
              }
            }

            onChunk(chunk);
          } catch (err) {
            console.error('Error parsing Anthropic SSE chunk:', err, raw);
          }
        }
      }
    }
  }

  public async execute(request: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const config = gatewayConfigService.getConfig();
    const apiKey = config.anthropicApiKey;
    if (!apiKey) {
      throw new Error('Anthropic API key is not configured.');
    }

    const url = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/messages`;
    const payload = this.buildAnthropicPayload(request, false);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as any;
    let textContent = '';
    let thinking: string | undefined;
    const toolCalls: any[] = [];

    for (const part of data.content || []) {
      if (part.type === 'text') textContent += part.text;
      if (part.type === 'thinking') thinking = (thinking || '') + part.thinking;
      if (part.type === 'tool_use') {
        toolCalls.push({
          id: part.id,
          name: part.name,
          arguments: part.input,
        });
      }
    }

    return {
      id: data.id,
      model: data.model,
      content: textContent,
      thinking,
      toolCalls,
      finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }
}
