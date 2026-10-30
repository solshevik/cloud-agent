import { getConnection } from '../database/index.js';

export interface GatewayConfig {
  apiKey?: string;
  defaultModel: string;
  geminiApiKey?: string;
  geminiBaseUrl: string;
  anthropicApiKey?: string;
  anthropicBaseUrl: string;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  deepseekApiKey?: string;
  deepseekBaseUrl: string;
  modelAliases: Record<string, string>;
}

class GatewayConfigService {
  private getDbConfig(key: string): string | null {
    try {
      const db = getConnection();
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(`gateway.${key}`) as { value: string } | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  private setDbConfig(key: string, value: string): void {
    const db = getConnection();
    db.prepare(`
      INSERT INTO app_config (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(`gateway.${key}`, value);
  }

  public getConfig(): GatewayConfig {
    const defaultAliases: Record<string, string> = {
      // Common Claude models aliased to Gemini or OpenAI if Anthropic key is not present
      'claude-3-7-sonnet-20250219': 'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022': 'claude-3-5-haiku-20241022',
    };

    let userAliases: Record<string, string> = {};
    const rawAliases = this.getDbConfig('model_aliases') || process.env.GATEWAY_MODEL_ALIASES;
    if (rawAliases) {
      try {
        userAliases = JSON.parse(rawAliases);
      } catch {
        // ignore invalid JSON
      }
    }

    return {
      apiKey: process.env.GATEWAY_API_KEY || this.getDbConfig('api_key') || undefined,
      defaultModel:
        process.env.GATEWAY_DEFAULT_MODEL ||
        this.getDbConfig('default_model') ||
        'gemini-2.5-pro',
      geminiApiKey:
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        this.getDbConfig('gemini_api_key') ||
        undefined,
      geminiBaseUrl:
        process.env.GEMINI_BASE_URL ||
        this.getDbConfig('gemini_base_url') ||
        'https://generativelanguage.googleapis.com',
      anthropicApiKey:
        process.env.ANTHROPIC_API_KEY ||
        this.getDbConfig('anthropic_api_key') ||
        undefined,
      anthropicBaseUrl:
        process.env.ANTHROPIC_BASE_URL ||
        this.getDbConfig('anthropic_base_url') ||
        'https://api.anthropic.com',
      openaiApiKey:
        process.env.OPENAI_API_KEY ||
        this.getDbConfig('openai_api_key') ||
        undefined,
      openaiBaseUrl:
        process.env.OPENAI_BASE_URL ||
        this.getDbConfig('openai_base_url') ||
        'https://api.openai.com/v1',
      deepseekApiKey:
        process.env.DEEPSEEK_API_KEY ||
        this.getDbConfig('deepseek_api_key') ||
        undefined,
      deepseekBaseUrl:
        process.env.DEEPSEEK_BASE_URL ||
        this.getDbConfig('deepseek_base_url') ||
        'https://api.deepseek.com',
      modelAliases: { ...defaultAliases, ...userAliases },
    };
  }

  public updateConfig(updates: Partial<Record<string, string>>): void {
    const allowedKeys = [
      'api_key',
      'default_model',
      'gemini_api_key',
      'gemini_base_url',
      'anthropic_api_key',
      'anthropic_base_url',
      'openai_api_key',
      'openai_base_url',
      'deepseek_api_key',
      'deepseek_base_url',
      'model_aliases',
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedKeys.includes(key) && typeof value === 'string') {
        this.setDbConfig(key, value);
      }
    }
  }

  public getMaskedConfig(): Record<string, unknown> {
    const config = this.getConfig();
    const mask = (val?: string) => (val && val.length > 8 ? `${val.slice(0, 4)}...${val.slice(-4)}` : val ? '********' : null);

    return {
      hasGatewayApiKey: Boolean(config.apiKey),
      defaultModel: config.defaultModel,
      gemini: {
        isConfigured: Boolean(config.geminiApiKey),
        apiKey: mask(config.geminiApiKey),
        baseUrl: config.geminiBaseUrl,
      },
      anthropic: {
        isConfigured: Boolean(config.anthropicApiKey),
        apiKey: mask(config.anthropicApiKey),
        baseUrl: config.anthropicBaseUrl,
      },
      openai: {
        isConfigured: Boolean(config.openaiApiKey),
        apiKey: mask(config.openaiApiKey),
        baseUrl: config.openaiBaseUrl,
      },
      deepseek: {
        isConfigured: Boolean(config.deepseekApiKey),
        apiKey: mask(config.deepseekApiKey),
        baseUrl: config.deepseekBaseUrl,
      },
      modelAliases: config.modelAliases,
    };
  }
}

export const gatewayConfigService = new GatewayConfigService();
