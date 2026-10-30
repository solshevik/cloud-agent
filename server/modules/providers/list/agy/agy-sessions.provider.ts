import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'agy' as const;

function cleanAgyUserPrompt(rawText: string): string {
  if (!rawText) return '';
  const userReqMatch = rawText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (userReqMatch && userReqMatch[1]) {
    return userReqMatch[1].trim();
  }
  return rawText
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
}

export class AgySessionsProvider implements IProviderSessions {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      if (typeof rawMessage === 'string' && rawMessage.trim()) {
        return [
          createNormalizedMessage({
            kind: 'stream_delta',
            content: rawMessage,
            sessionId,
            provider: PROVIDER,
          }),
        ];
      }
      return [];
    }

    if (raw.event === 'step_update') {
      const step = readObjectRecord(raw.step_update);
      if (step?.text_delta) {
        return [
          createNormalizedMessage({
            kind: 'stream_delta',
            content: String(step.text_delta),
            sessionId,
            provider: PROVIDER,
          }),
        ];
      }
      if (step?.thinking_delta) {
        return [
          createNormalizedMessage({
            kind: 'thinking',
            content: String(step.thinking_delta),
            sessionId,
            provider: PROVIDER,
          }),
        ];
      }
    }

    return [];
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;
    const transcriptPath = path.join(
      os.homedir(),
      '.gemini',
      'antigravity-cli',
      'brain',
      providerSessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );

    if (!fs.existsSync(transcriptPath)) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: offset ?? 0,
        limit,
      };
    }

    const messages: NormalizedMessage[] = [];
    const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const item = JSON.parse(trimmed);
        const timestamp = item.created_at || new Date().toISOString();

        if (item.type === 'USER_INPUT') {
          const content = cleanAgyUserPrompt(item.content || '');
          if (content) {
            messages.push(
              createNormalizedMessage({
                id: `user-${item.step_index ?? generateMessageId()}`,
                sessionId,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content,
                timestamp,
              }),
            );
          }
        } else if (item.type === 'PLANNER_RESPONSE') {
          if (item.thinking) {
            messages.push(
              createNormalizedMessage({
                id: `thinking-${item.step_index ?? generateMessageId()}`,
                sessionId,
                provider: PROVIDER,
                kind: 'thinking',
                role: 'assistant',
                content: item.thinking,
                timestamp,
              }),
            );
          }

          if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
            for (let i = 0; i < item.tool_calls.length; i++) {
              const tc = item.tool_calls[i];
              messages.push(
                createNormalizedMessage({
                  id: `tool-${item.step_index}-${i}`,
                  sessionId,
                  provider: PROVIDER,
                  kind: 'tool_use',
                  role: 'assistant',
                  content: JSON.stringify(tc.args || {}),
                  displayText: tc.name,
                  timestamp,
                }),
              );
            }
          }

          if (item.content) {
            messages.push(
              createNormalizedMessage({
                id: `assistant-${item.step_index ?? generateMessageId()}`,
                sessionId,
                provider: PROVIDER,
                kind: 'text',
                role: 'assistant',
                content: item.content,
                timestamp,
              }),
            );
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    const total = messages.length;
    const { page, hasMore } = sliceTailPage(messages, limit, offset);

    return {
      messages: page,
      total,
      hasMore,
      offset: offset ?? 0,
      limit,
    };
  }
}
