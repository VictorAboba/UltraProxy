import { Client } from 'ssh2';
import { exec } from '../ssh/exec';

export interface RemoteInfo {
  home: string;
  shell: string;
  hasPython3: boolean;
  /** Absolute paths of present VSCode server data dirs (stable + insiders). */
  serverDirs: string[];
}

/** Probe the cluster for home dir, shell, python3, and VSCode server locations. */
export async function detectRemote(client: Client): Promise<RemoteInfo> {
  const home = (await exec(client, 'echo "$HOME"')).stdout.trim();
  if (!home) {
    throw new Error('Could not determine remote $HOME');
  }
  const shell = (await exec(client, 'echo "$SHELL"')).stdout.trim();
  const hasPython3 = (await exec(client, 'command -v python3 >/dev/null 2>&1 && echo yes || echo no')).stdout.trim() === 'yes';

  const serverDirs: string[] = [];
  for (const d of ['.vscode-server', '.vscode-server-insiders']) {
    const r = await exec(client, `[ -d "$HOME/${d}" ] && echo yes || echo no`);
    if (r.stdout.trim() === 'yes') {
      serverDirs.push(`${home}/${d}`);
    }
  }
  return { home, shell, hasPython3, serverDirs };
}
