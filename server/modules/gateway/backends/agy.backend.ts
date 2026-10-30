import crossSpawn from 'cross-spawn';

import type { GatewayBackend, UnifiedChatRequest, UnifiedChatResponse, UnifiedChunk } from '../types.js';
import { resolveAgyCommand } from '../../providers/index.js';
import { scrubVendorIdentities } from '../adapters/prompt.scrubber.js';

export class AgyBackend implements GatewayBackend {
  public readonly id = 'agy';
  public readonly name = 'Antigravity (agy) CLI Engine';

  public isConfigured(): boolean {
    return Boolean(resolveAgyCommand());
  }

  public supportsModel(model: string): boolean {
    const m = model.toLowerCase();
    return (
      m.includes('gemini') ||
      m.includes('claude') ||
      m.includes('gpt-oss') ||
      m.includes('antigravity')
    );
  }

  private resolveModelName(requestedModel: string): string {
    const m = requestedModel.toLowerCase();
    if (m.includes('gemini-3.8-flash-medium')) return 'gemini-3.8-flash-medium';
    if (m.includes('gemini-3.8-flash-low')) return 'gemini-3.8-flash-low';
    if (m.includes('gemini')) return 'gemini-3.8-flash-high';
    if (m.includes('claude-opus')) return 'claude-opus-4-6-thinking';
    if (m.includes('claude')) return 'claude-sonnet-4-6';
    if (m.includes('gpt')) return 'gpt-oss-120b-medium';
    return 'gemini-3.8-flash-high';
  }

  private buildPrompt(request: UnifiedChatRequest): string {
    const parts: string[] = [];

    if (request.systemPrompt) {
      parts.push(scrubVendorIdentities(request.systemPrompt));
    }

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        continue;
      }
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content
          .map((p) => {
            if (p.type === 'text') return p.text;
            if (p.type === 'tool_result') return `Tool result: ${p.content}`;
            return '';
          })
          .join('\n');
      }

      if (contentStr.trim()) {
        parts.push(contentStr.trim());
      }
    }

    return parts.join('\n\n');
  }

  public async executeStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: UnifiedChunk) => void
  ): Promise<void> {
    const command = resolveAgyCommand() || 'agy';
    const model = this.resolveModelName(request.model);
    const prompt = this.buildPrompt(request);

    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
    ];

    return new Promise((resolve, reject) => {
      const child = crossSpawn(command, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      let isCompleted = false;

      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;

          try {
            const event = JSON.parse(trimmed);

            if (event.event === 'step_update' && event.step_update) {
              const su = event.step_update;
              if (su.step_type === 'agent_response' && su.text_delta) {
                onChunk({ text: su.text_delta });
              }
              if (su.usage) {
                onChunk({
                  usage: {
                    promptTokens: su.usage.input_tokens,
                    completionTokens: su.usage.output_tokens,
                    totalTokens: su.usage.total_tokens,
                  },
                });
              }
            } else if (event.event === 'result' && event.result) {
              isCompleted = true;
              if (event.result.usage) {
                onChunk({
                  usage: {
                    promptTokens: event.result.usage.input_tokens,
                    completionTokens: event.result.usage.output_tokens,
                    totalTokens: event.result.usage.total_tokens,
                  },
                });
              }
            }
          } catch {
            // Ignore non-JSON lines
          }
        }
      });

      let stderrOutput = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString('utf8');
      });

      child.on('close', (code: number) => {
        if (code === 0 || isCompleted) {
          onChunk({ finishReason: 'stop' });
          resolve();
        } else {
          reject(new Error(`agy CLI exited with code ${code}: ${stderrOutput}`));
        }
      });

      child.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  public async execute(request: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    let fullText = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    await this.executeStream(request, (chunk) => {
      if (chunk.text) {
        fullText += chunk.text;
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.promptTokens || usage.promptTokens,
          completionTokens: chunk.usage.completionTokens || usage.completionTokens,
          totalTokens: chunk.usage.totalTokens || usage.totalTokens,
        };
      }
    });

    return {
      id: `agy-${Date.now()}`,
      model: request.model,
      content: fullText,
      finishReason: 'stop',
      usage,
    };
  }
}
