import * as vscode from 'vscode';

const KEYS = {
  sshPassword: 'ultraproxy.sshPassword',
  sshKeyPassphrase: 'ultraproxy.sshKeyPassphrase',
  shareLink: 'ultraproxy.shareLink',
  anthropicKey: 'ultraproxy.anthropicApiKey',
  openaiKey: 'ultraproxy.openaiApiKey',
} as const;

/** Wrapper over VSCode SecretStorage. SSH secrets are keyed per cluster (with legacy fallback). */
export class Secrets {
  constructor(private readonly storage: vscode.SecretStorage) {}

  private async getWithLegacy(key: string, legacyKey: string): Promise<string | undefined> {
    return (await this.storage.get(key)) ?? (await this.storage.get(legacyKey));
  }

  private set(key: string, v: string): Thenable<void> {
    return v ? this.storage.store(key, v) : this.storage.delete(key);
  }

  /**
   * `allowLegacy` enables falling back to the un-suffixed key from the pre-multi-cluster version.
   * It must ONLY be true when there is a single cluster; otherwise a stale global secret would bleed
   * into every new named cluster that has no secret of its own.
   */
  async getSshPassword(cluster: string, allowLegacy = false): Promise<string | undefined> {
    const key = `${KEYS.sshPassword}:${cluster}`;
    return allowLegacy ? this.getWithLegacy(key, KEYS.sshPassword) : this.storage.get(key);
  }
  setSshPassword(cluster: string, v: string): Thenable<void> {
    return this.set(`${KEYS.sshPassword}:${cluster}`, v);
  }

  async getSshKeyPassphrase(cluster: string, allowLegacy = false): Promise<string | undefined> {
    const key = `${KEYS.sshKeyPassphrase}:${cluster}`;
    return allowLegacy ? this.getWithLegacy(key, KEYS.sshKeyPassphrase) : this.storage.get(key);
  }
  setSshKeyPassphrase(cluster: string, v: string): Thenable<void> {
    return this.set(`${KEYS.sshKeyPassphrase}:${cluster}`, v);
  }

  /** Optional: store the share link as a secret instead of in settings.json (global). */
  getShareLink(): Thenable<string | undefined> {
    return this.storage.get(KEYS.shareLink);
  }
  setShareLink(v: string): Thenable<void> {
    return this.set(KEYS.shareLink, v);
  }

  /** Optional provider API keys — only used locally by the connection test to list models. */
  getAnthropicKey(): Thenable<string | undefined> {
    return this.storage.get(KEYS.anthropicKey);
  }
  setAnthropicKey(v: string): Thenable<void> {
    return this.set(KEYS.anthropicKey, v);
  }

  getOpenAIKey(): Thenable<string | undefined> {
    return this.storage.get(KEYS.openaiKey);
  }
  setOpenAIKey(v: string): Thenable<void> {
    return this.set(KEYS.openaiKey, v);
  }

  /** Move a cluster's SSH secrets to a new name (used when a cluster is renamed in the UI). */
  async moveClusterSecrets(oldName: string, newName: string): Promise<void> {
    if (!oldName || !newName || oldName === newName) {
      return;
    }
    for (const base of [KEYS.sshPassword, KEYS.sshKeyPassphrase]) {
      const v = await this.storage.get(`${base}:${oldName}`);
      if (v !== undefined) {
        await this.storage.store(`${base}:${newName}`, v);
        await this.storage.delete(`${base}:${oldName}`);
      }
    }
  }

  /** Remove every stored secret, including per-cluster SSH secrets and the legacy un-suffixed keys. */
  async clearAll(clusterNames: string[]): Promise<void> {
    const dels: Thenable<void>[] = [
      this.storage.delete(KEYS.shareLink),
      this.storage.delete(KEYS.anthropicKey),
      this.storage.delete(KEYS.openaiKey),
      this.storage.delete(KEYS.sshPassword),
      this.storage.delete(KEYS.sshKeyPassphrase),
    ];
    for (const name of clusterNames) {
      dels.push(this.storage.delete(`${KEYS.sshPassword}:${name}`));
      dels.push(this.storage.delete(`${KEYS.sshKeyPassphrase}:${name}`));
    }
    await Promise.all(dels);
  }
}
