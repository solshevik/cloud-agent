import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

const AGY_PROJECT_SKILL_DIRS = [
  ['.gemini', 'skills'],
  ['.agents', 'skills'],
  ['.claude', 'skills'],
];

const AGY_USER_SKILL_DIRS = [
  ['.gemini', 'antigravity-cli', 'builtin', 'skills'],
  ['.gemini', 'antigravity-cli', 'skills'],
  ['.gemini', 'skills'],
];

export class AgySkillsProvider extends SkillsProvider {
  constructor() {
    super('agy');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    const projectRoots = [path.resolve(workspacePath)];
    if (repoRoot && repoRoot !== workspacePath) {
      projectRoots.push(path.resolve(repoRoot));
    }

    for (const projectRoot of projectRoots) {
      for (const skillDir of AGY_PROJECT_SKILL_DIRS) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(projectRoot, ...skillDir),
          commandPrefix: '/',
        });
      }
    }

    for (const skillDir of AGY_USER_SKILL_DIRS) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir: path.join(os.homedir(), ...skillDir),
        commandPrefix: '/',
      });
    }

    return sources;
  }
}
