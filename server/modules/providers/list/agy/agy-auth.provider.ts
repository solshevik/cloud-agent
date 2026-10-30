import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';
import { probeCliVersion } from '@/shared/utils.js';

export function resolveAgyCommand(): string {
  const custom = process.env.AGY_CLI_PATH;
  if (custom && fs.existsSync(custom)) {
    return custom;
  }
  const localBin = path.join(os.homedir(), '.local', 'bin', 'agy');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'agy';
}

export class AgyProviderAuth implements IProviderAuth {
  checkInstalled(): CliVersionProbe {
    const command = resolveAgyCommand();
    const probe = probeCliVersion(command, ['--version']);
    return { ...probe, installed: probe.exitCode === 0 };
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();

    return {
      installed,
      provider: 'agy',
      installedVersion: installedVersion || '1.4.11',
      authenticated: installed,
      email: 'Antigravity User',
      method: 'local_cli',
      error: installed ? undefined : 'agy CLI not found at ~/.local/bin/agy',
    };
  }
}
