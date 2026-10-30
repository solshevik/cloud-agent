import crossSpawn from 'cross-spawn';

import type { GatewayBackend, UnifiedChatRequest, UnifiedChatResponse, UnifiedChunk } from '../types.js';
import { resolveAgyCommand } from '../../providers/index.js';
import { sessionContinuityManager } from '../session.manager.js';

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

  private resolveModelName(requestedModel: string, thinkingBudget?: number): string {
    const m = requestedModel.toLowerCase();
    if (m.includes('gemini-3.8-flash-medium')) return 'gemini-3.8-flash-medium';
    if (m.includes('gemini-3.8-flash-low')) return 'gemini-3.8-flash-low';
    if (m.includes('gemini-3.8-flash-high')) return 'gemini-3.8-flash-high';
    if (m.includes('gemini') || m.includes('gemma')) {
      if (typeof thinkingBudget === 'number') {
        if (thinkingBudget > 4096) return 'gemini-3.8-flash-high';
        if (thinkingBudget > 1024) return 'gemini-3.8-flash-medium';
      }
      return 'gemini-3.8-flash-low';
    }
    if (m.includes('claude-opus')) return 'claude-opus-4-6-thinking';
    if (m.includes('claude')) return 'claude-sonnet-4-6';
    if (m.includes('gpt')) return 'gpt-oss-120b-medium';
    return 'gemini-3.8-flash-low';
  }

  public async executeStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: UnifiedChunk) => void
  ): Promise<void> {
    const command = resolveAgyCommand() || 'agy';
    const model = this.resolveModelName(request.model, request.thinkingBudget);

    // Resolve session continuity
    const sessionKey = sessionContinuityManager.resolveSessionKey(request);
    const isFirstTurn = sessionContinuityManager.isFirstTurn(request);
    const conversationId = isFirstTurn ? undefined : sessionContinuityManager.getAgyConversationId(sessionKey);
    const isResume = Boolean(conversationId);

    const prompt = sessionContinuityManager.getPromptForAgy(request, isResume);

    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
    ];

    if (conversationId) {
      args.unshift('--conversation', conversationId);
    }

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
      let hasEmittedText = false;
      let errorMessage: string | undefined;
      let capturedConversationId: string | undefined;

      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;

          try {
            const event = JSON.parse(trimmed);

            if (event.event === 'init' && event.conversation_id) {
              capturedConversationId = event.conversation_id;
            } else if (event.event === 'step_update' && event.step_update) {
              const su = event.step_update;
              if (su.conversation_id && !capturedConversationId) {
                capturedConversationId = su.conversation_id;
              }
              if (su.step_type === 'agent_response' && su.text_delta) {
                hasEmittedText = true;
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
              if (event.result.status === 'ERROR') {
                errorMessage = event.result.error || 'agy execution error';
              } else {
                isCompleted = true;
                if (!hasEmittedText && event.result.response) {
                  hasEmittedText = true;
                  onChunk({ text: event.result.response });
                }
              }
              if (event.result.conversation_id && !capturedConversationId) {
                capturedConversationId = event.result.conversation_id;
              }
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
        if (errorMessage) {
          if (conversationId) {
            sessionContinuityManager.removeSession(sessionKey);
          }
          reject(new Error(`agy CLI error: ${errorMessage}`));
          return;
        }

        if (code === 0 || isCompleted) {
          if (capturedConversationId) {
            sessionContinuityManager.setAgyConversationId(sessionKey, capturedConversationId);
          }
          onChunk({ finishReason: 'stop' });
          resolve();
        } else {
          // If conversation resume failed, invalidate cached session mapping so next retry starts fresh
          if (conversationId) {
            sessionContinuityManager.removeSession(sessionKey);
          }
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
