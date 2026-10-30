import type { GatewayBackend, UnifiedChatRequest, UnifiedChatResponse, UnifiedChunk } from '../types.js';
import { GeminiAdapter } from '../adapters/gemini.adapter.js';
import { gatewayConfigService } from '../gateway.config.js';

export class GeminiBackend implements GatewayBackend {
  public readonly id = 'gemini';
  public readonly name = 'Google Gemini API';

  public isConfigured(): boolean {
    const config = gatewayConfigService.getConfig();
    return Boolean(config.geminiApiKey);
  }

  public supportsModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.includes('gemini') || m.includes('gemma');
  }

  private resolveModelName(model: string): string {
    // Strip prefixes like "models/" or "gemini/"
    return model.replace(/^(models\/|gemini\/)/i, '');
  }

  public async executeStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: UnifiedChunk) => void
  ): Promise<void> {
    const config = gatewayConfigService.getConfig();
    const apiKey = config.geminiApiKey;
    if (!apiKey) {
      throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY in environment or gateway config.');
    }

    const modelName = this.resolveModelName(request.model);
    const url = `${config.geminiBaseUrl}/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const payload = GeminiAdapter.toGeminiPayload(request);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('No response body from Gemini API stream.');
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
          const jsonStr = trimmed.slice(6).trim();
          if (jsonStr) {
            try {
              const data = JSON.parse(jsonStr);
              const chunk = GeminiAdapter.parseGeminiChunk(data);
              onChunk(chunk);
            } catch (err) {
              console.error('Error parsing Gemini SSE chunk:', err, jsonStr);
            }
          }
        }
      }
    }
  }

  public async execute(request: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const config = gatewayConfigService.getConfig();
    const apiKey = config.geminiApiKey;
    if (!apiKey) {
      throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY in environment or gateway config.');
    }

    const modelName = this.resolveModelName(request.model);
    const url = `${config.geminiBaseUrl}/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const payload = GeminiAdapter.toGeminiPayload(request);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const chunk = GeminiAdapter.parseGeminiChunk(data);

    return {
      id: `gemini-${Date.now()}`,
      model: request.model,
      content: chunk.text || '',
      thinking: chunk.thinking,
      toolCalls: chunk.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name || '',
        arguments: tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {},
      })),
      finishReason: chunk.finishReason || 'stop',
      usage: {
        promptTokens: chunk.usage?.promptTokens || 0,
        completionTokens: chunk.usage?.completionTokens || 0,
        totalTokens: chunk.usage?.totalTokens || 0,
      },
    };
  }
}
