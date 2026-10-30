import type { GatewayBackend, UnifiedChatRequest, UnifiedChatResponse, UnifiedChunk } from '../types.js';
import { gatewayConfigService } from '../gateway.config.js';

import { AgyBackend } from './agy.backend.js';
import { AnthropicBackend } from './anthropic.backend.js';
import { GeminiBackend } from './gemini.backend.js';
import { OpenAIBackend } from './openai.backend.js';

export class BackendRouter {
  private geminiBackend = new GeminiBackend();
  private openaiBackend = new OpenAIBackend();
  private anthropicBackend = new AnthropicBackend();
  private agyBackend = new AgyBackend();

  public resolveBackend(requestedModel: string): { backend: GatewayBackend; targetModel: string } {
    const config = gatewayConfigService.getConfig();
    let model = requestedModel || config.defaultModel;

    // 1. Check custom aliases first
    if (config.modelAliases[model]) {
      model = config.modelAliases[model];
    }

    const lowerModel = model.toLowerCase();

    // 2. Direct match by model prefix if backend configured
    if (lowerModel.includes('gemini') || lowerModel.includes('gemma')) {
      if (this.geminiBackend.isConfigured()) {
        return { backend: this.geminiBackend, targetModel: model };
      }
      if (this.agyBackend.isConfigured()) {
        return { backend: this.agyBackend, targetModel: model };
      }
    }

    if (
      lowerModel.includes('gpt') ||
      lowerModel.includes('o1') ||
      lowerModel.includes('o3') ||
      lowerModel.includes('deepseek')
    ) {
      if (this.openaiBackend.isConfigured()) {
        return { backend: this.openaiBackend, targetModel: model };
      }
      if (this.agyBackend.isConfigured()) {
        return { backend: this.agyBackend, targetModel: 'gpt-oss-120b-medium' };
      }
    }

    if (lowerModel.includes('claude')) {
      if (this.anthropicBackend.isConfigured()) {
        return { backend: this.anthropicBackend, targetModel: model };
      }
      // If Anthropic key is absent, fallback to Gemini, Agy, or DeepSeek/OpenAI
      if (this.geminiBackend.isConfigured()) {
        return { backend: this.geminiBackend, targetModel: 'gemini-2.5-pro' };
      }
      if (this.agyBackend.isConfigured()) {
        return { backend: this.agyBackend, targetModel: 'claude-sonnet-4-6' };
      }
      if (this.openaiBackend.isConfigured()) {
        const target = config.deepseekApiKey ? 'deepseek-chat' : 'gpt-4o';
        return { backend: this.openaiBackend, targetModel: target };
      }
    }

    // 3. Fallback to any configured backend
    if (this.geminiBackend.isConfigured()) {
      return { backend: this.geminiBackend, targetModel: 'gemini-2.5-pro' };
    }
    if (this.agyBackend.isConfigured()) {
      return { backend: this.agyBackend, targetModel: 'gemini-3.8-flash-high' };
    }
    if (this.openaiBackend.isConfigured()) {
      const target = config.deepseekApiKey ? 'deepseek-chat' : 'gpt-4o';
      return { backend: this.openaiBackend, targetModel: target };
    }
    if (this.anthropicBackend.isConfigured()) {
      return { backend: this.anthropicBackend, targetModel: 'claude-3-7-sonnet-20250219' };
    }

    throw new Error(
      'No upstream backend configured. Please configure GEMINI_API_KEY, OPENAI_API_KEY, or ensure agy is installed.'
    );
  }

  public async executeStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: UnifiedChunk) => void
  ): Promise<{ backendId: string; targetModel: string }> {
    const { backend, targetModel } = this.resolveBackend(request.model);
    const targetRequest: UnifiedChatRequest = {
      ...request,
      model: targetModel,
    };
    await backend.executeStream(targetRequest, onChunk);
    return { backendId: backend.id, targetModel };
  }

  public async execute(
    request: UnifiedChatRequest
  ): Promise<{ response: UnifiedChatResponse; backendId: string; targetModel: string }> {
    const { backend, targetModel } = this.resolveBackend(request.model);
    const targetRequest: UnifiedChatRequest = {
      ...request,
      model: targetModel,
    };
    const response = await backend.execute(targetRequest);
    return { response, backendId: backend.id, targetModel };
  }

  public listAvailableModels(): Array<{ id: string; object: 'model'; created: number; owned_by: string }> {
    const models: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [];
    const timestamp = 1700000000;

    // Standard Gemini models
    if (this.geminiBackend.isConfigured()) {
      models.push(
        { id: 'gemini-2.5-pro', object: 'model', created: timestamp, owned_by: 'google' },
        { id: 'gemini-2.5-flash', object: 'model', created: timestamp, owned_by: 'google' },
        { id: 'gemini-2.0-flash', object: 'model', created: timestamp, owned_by: 'google' },
        { id: 'gemini-1.5-pro', object: 'model', created: timestamp, owned_by: 'google' }
      );
    }

    // Standard Anthropic models
    models.push(
      { id: 'claude-3-7-sonnet-20250219', object: 'model', created: timestamp, owned_by: 'anthropic' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model', created: timestamp, owned_by: 'anthropic' },
      { id: 'claude-3-5-haiku-20241022', object: 'model', created: timestamp, owned_by: 'anthropic' }
    );

    // Standard OpenAI/DeepSeek models
    if (this.openaiBackend.isConfigured()) {
      const config = gatewayConfigService.getConfig();
      if (config.openaiApiKey) {
        models.push(
          { id: 'gpt-4o', object: 'model', created: timestamp, owned_by: 'openai' },
          { id: 'gpt-4o-mini', object: 'model', created: timestamp, owned_by: 'openai' },
          { id: 'o1', object: 'model', created: timestamp, owned_by: 'openai' },
          { id: 'o3-mini', object: 'model', created: timestamp, owned_by: 'openai' }
        );
      }
      if (config.deepseekApiKey) {
        models.push(
          { id: 'deepseek-chat', object: 'model', created: timestamp, owned_by: 'deepseek' },
          { id: 'deepseek-reasoner', object: 'model', created: timestamp, owned_by: 'deepseek' }
        );
      }
    }

    // Antigravity models (always available in this environment!)
    models.push(
      { id: 'gemini-3.8-flash-high', object: 'model', created: timestamp, owned_by: 'antigravity' },
      { id: 'gemini-3.8-flash-medium', object: 'model', created: timestamp, owned_by: 'antigravity' },
      { id: 'claude-sonnet-4-6', object: 'model', created: timestamp, owned_by: 'antigravity' },
      { id: 'gpt-oss-120b-medium', object: 'model', created: timestamp, owned_by: 'antigravity' }
    );

    return models;
  }
}

export const backendRouter = new BackendRouter();
