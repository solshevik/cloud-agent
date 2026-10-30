import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

export const AGY_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gemini-3.8-flash-high',
      label: 'Gemini 3.8 Flash (High)',
      description: 'Google Deepmind Gemini 3.8 model with high reasoning effort',
    },
    {
      value: 'gemini-3.8-flash-medium',
      label: 'Gemini 3.8 Flash (Medium)',
      description: 'Balanced latency and reasoning Gemini 3.8 model',
    },
    {
      value: 'gemini-3.8-flash-low',
      label: 'Gemini 3.8 Flash (Low)',
      description: 'Fastest Gemini 3.8 model with low reasoning effort',
    },
    {
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6 (Thinking)',
      description: 'Anthropic Claude Sonnet 4.6 with thinking support',
    },
    {
      value: 'claude-opus-4-6-thinking',
      label: 'Claude Opus 4.6 (Thinking)',
      description: 'Anthropic Claude Opus 4.6 reasoning model',
    },
    {
      value: 'gpt-oss-120b-medium',
      label: 'GPT-OSS 120B (Medium)',
      description: 'High-parameter open weights reasoning model',
    },
  ],
  DEFAULT: 'gemini-3.8-flash-high',
};

export class AgyProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return AGY_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(AGY_PREDEFINED_MODELS);
  }
}
