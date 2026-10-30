import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { normalizeSessionName, readFileTimestamps } from '@/shared/utils.js';

const PROVIDER = 'agy' as const;

export class AgySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

  async synchronize(_since?: Date): Promise<number> {
    if (!fs.existsSync(this.brainDir)) {
      return 0;
    }

    let count = 0;
    try {
      const entries = await fsp.readdir(this.brainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        const transcriptPath = path.join(
          this.brainDir,
          sessionId,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );

        if (!fs.existsSync(transcriptPath)) continue;

        const session = await this.parseTranscriptFile(sessionId, transcriptPath);
        if (session) {
          const timestamps = await readFileTimestamps(transcriptPath);
          sessionsDb.createSession(
            session.sessionId,
            PROVIDER,
            session.projectPath,
            session.sessionName,
            timestamps.createdAt,
            timestamps.updatedAt,
            transcriptPath,
          );
          count++;
        }
      }
    } catch (err) {
      console.warn('[AgySessionSynchronizer] Error during synchronize:', err);
    }

    return count;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('transcript.jsonl')) {
      return null;
    }

    // Path structure: .../brain/<sessionId>/.system_generated/logs/transcript.jsonl
    const parts = filePath.split(path.sep);
    const logsIdx = parts.lastIndexOf('logs');
    if (logsIdx < 2) return null;
    const sessionId = parts[logsIdx - 2];

    const session = await this.parseTranscriptFile(sessionId, filePath);
    if (!session) return null;

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      session.sessionId,
      PROVIDER,
      session.projectPath,
      session.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
    );
  }

  private async parseTranscriptFile(
    sessionId: string,
    transcriptPath: string,
  ): Promise<{ sessionId: string; projectPath: string; sessionName: string } | null> {
    try {
      const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      let sessionName = 'Antigravity Session';
      let projectPath = os.homedir();

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const item = JSON.parse(trimmed);
          if (item.type === 'USER_INPUT' && item.content) {
            const rawContent = String(item.content);
            const userReqMatch = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const text = userReqMatch ? userReqMatch[1].trim() : rawContent.trim();
            const firstLine = text.split('\n')[0].trim();
            sessionName = normalizeSessionName(firstLine, 'Antigravity Session');
            break;
          }
        } catch {
          // ignore parsing error
        }
      }

      return {
        sessionId,
        projectPath,
        sessionName,
      };
    } catch {
      return null;
    }
  }
}
