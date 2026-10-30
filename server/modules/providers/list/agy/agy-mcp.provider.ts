import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';

export class AgyMcpProvider extends McpProvider {
  constructor() {
    super('agy', ['user'], ['stdio']);
  }

  protected async readScopedServers(_scope: McpScope, _workspacePath: string): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    _servers: Record<string, unknown>,
  ): Promise<void> {
    // No-op for now
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    return {
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }
    const cfg = rawConfig as Record<string, unknown>;
    return {
      provider: 'agy',
      name,
      scope,
      transport: 'stdio',
      command: typeof cfg.command === 'string' ? cfg.command : 'node',
      args: Array.isArray(cfg.args) ? (cfg.args as string[]) : [],
      env: (cfg.env as Record<string, string>) || {},
    };
  }
}
