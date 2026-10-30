import crypto from 'crypto';

import type { UnifiedChatRequest, UnifiedMessage } from './types.js';
import { cleanSystemPrompt } from './adapters/prompt.scrubber.js';

export interface SessionEntry {
  sessionKey: string;
  agyConversationId: string;
  turnCount: number;
  createdAt: number;
  lastActiveAt: number;
}

export class SessionContinuityManager {
  private sessions = new Map<string, SessionEntry>();
  private readonly ttlMs = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Resolves a stable session key for a request.
   * Priority:
   * 1. Explicit sessionId passed in argument or request
   * 2. Metadata session_id in request.rawBody
   * 3. Fingerprint based on the first user message in the conversation tree
   */
  public resolveSessionKey(request: UnifiedChatRequest, explicitSessionId?: string): string {
    const rawSid =
      explicitSessionId ||
      request.sessionId ||
      (request.rawBody?.metadata as any)?.session_id ||
      (request.rawBody as any)?.session_id;

    if (rawSid && typeof rawSid === 'string' && rawSid.trim()) {
      return `id:${rawSid.trim()}`;
    }

    // Fallback: Fingerprint the conversation by its first user message
    const firstUserMsg = request.messages.find((m) => m.role === 'user');
    let firstUserText = '';
    if (firstUserMsg) {
      if (typeof firstUserMsg.content === 'string') {
        firstUserText = firstUserMsg.content;
      } else if (Array.isArray(firstUserMsg.content)) {
        firstUserText = firstUserMsg.content
          .map((p) => (p.type === 'text' ? p.text : ''))
          .join(' ');
      }
    }

    const normalized = firstUserText.trim().replace(/\s+/g, ' ').slice(0, 500);
    if (!normalized) {
      return 'fp:default';
    }

    const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    return `fp:${hash}`;
  }

  /**
   * Determines whether the current request is the first turn in a conversation.
   * If there are no assistant messages in the history, it is considered Turn 1.
   */
  public isFirstTurn(request: UnifiedChatRequest): boolean {
    return !request.messages.some((m) => m.role === 'assistant');
  }

  /**
   * Retrieves an active agy conversation ID by session key.
   */
  public getAgyConversationId(sessionKey: string): string | undefined {
    this.cleanExpired();
    const entry = this.sessions.get(sessionKey);
    if (entry) {
      entry.lastActiveAt = Date.now();
      return entry.agyConversationId;
    }
    return undefined;
  }

  /**
   * Records or updates a session mapping to an agy conversation ID.
   */
  public setAgyConversationId(sessionKey: string, agyConversationId: string): void {
    const existing = this.sessions.get(sessionKey);
    const now = Date.now();
    if (existing) {
      existing.agyConversationId = agyConversationId;
      existing.turnCount += 1;
      existing.lastActiveAt = now;
    } else {
      this.sessions.set(sessionKey, {
        sessionKey,
        agyConversationId,
        turnCount: 1,
        createdAt: now,
        lastActiveAt: now,
      });
    }
  }

  /**
   * Removes a session mapping (e.g. when resuming fails or conversation is invalid).
   */
  public removeSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Extracts the prompt for agy CLI.
   * If Turn 1: returns full prompt (system prompt + user messages).
   * If Turn 2+: returns only the incremental trailing messages after the last assistant response.
   */
  public getPromptForAgy(request: UnifiedChatRequest, isResume: boolean): string {
    const parts: string[] = [];

    let targetMessages: UnifiedMessage[] = request.messages;

    if (isResume) {
      // Find the last assistant message and take only subsequent messages
      let lastAssistantIndex = -1;
      for (let i = request.messages.length - 1; i >= 0; i--) {
        if (request.messages[i].role === 'assistant') {
          lastAssistantIndex = i;
          break;
        }
      }

      if (lastAssistantIndex !== -1 && lastAssistantIndex < request.messages.length - 1) {
        targetMessages = request.messages.slice(lastAssistantIndex + 1);
      }
    } else {
      // First turn: include cleaned system prompt
      if (request.systemPrompt) {
        const cleanedSystem = cleanSystemPrompt(request.systemPrompt);
        if (cleanedSystem) {
          parts.push(cleanedSystem);
        }
      }
    }

    for (const msg of targetMessages) {
      if (msg.role === 'system') continue;

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

  /**
   * Cleans expired session mappings.
   */
  public cleanExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions.entries()) {
      if (now - entry.lastActiveAt > this.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  /**
   * Clears all session mappings (useful for testing).
   */
  public clear(): void {
    this.sessions.clear();
  }
}

export const sessionContinuityManager = new SessionContinuityManager();
