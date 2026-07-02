import * as vscode from 'vscode';
import { ClusterSession, ProviderTest } from './cluster/session';
import { Secrets } from './config/secrets';
import { ClusterConfig, getClusters, readSettings, resolveNoProxyForCluster } from './config/settings';
import { Logger } from './util/logger';
import { resolvePort } from './util/ports';
import { StatusBar } from './ui/statusBar';
import { resolveShareLink } from './uri/shareLink';
import { describeProfile } from './uri/types';
import { buildXrayConfig, normalizeWhitelist } from './xray/configBuilder';
import { resolveXrayBinary } from './xray/binaryResolver';
import { XrayProcess } from './xray/process';

export { ProviderTest } from './cluster/session';

/**
 * Coordinates ONE shared local Xray with N per-cluster reverse-tunnel sessions.
 * Each cluster gets its own reverse forward into the same local Xray HTTP proxy.
 */
export class Orchestrator {
  private xray?: XrayProcess;
  private xrayHttpPort = 0;
  private xrayQueue: Promise<unknown> = Promise.resolve();
  private pendingApplies = 0;
  private readonly sessions = new Map<string, ClusterSession>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly secrets: Secrets,
    private readonly status: StatusBar,
  ) {}

  clusters(): ClusterConfig[] {
    return getClusters(readSettings());
  }

  isAnyActive(): boolean {
    return [...this.sessions.values()].some((s) => s.isActive());
  }

  activeSessionNames(): string[] {
    return [...this.sessions.values()].filter((s) => s.isActive()).map((s) => s.name);
  }

  sessionStateOf(name: string): string {
    const s = this.sessions.get(name);
    return s ? s.state : 'off';
  }

  // ---- shared Xray lifecycle (serialized) -------------------------------------------------

  private xEnqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.xrayQueue.then(fn, fn);
    this.xrayQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureXray(): Promise<number> {
    return this.xEnqueue(async () => {
      if (this.xray && this.xray.isRunning()) {
        return this.xrayHttpPort;
      }
      const s = readSettings();
      const shareLink = (s.shareLink || (await this.secrets.getShareLink()) || '').trim();
      if (!shareLink) {
        throw new Error('No proxy share link set. Configure ultraproxy.shareLink or use "Set Credentials".');
      }
      this.logger.addSecret(shareLink);

      const profile = await resolveShareLink(shareLink, { serverName: s.subscriptionServerName || undefined });
      this.logger.addSecret(profile.kind === 'shadowsocks' ? profile.password : profile.uuid);
      if (profile.kind === 'vless' && profile.transport.allowInsecure && !s.allowInsecureTls) {
        this.logger.warn('Ignoring allowInsecure from the share link (set ultraproxy.allowInsecureTls to honor it).');
        profile.transport.allowInsecure = false;
      }
      this.logger.info(`Proxy: ${describeProfile(profile)}`);

      const binPath = await resolveXrayBinary(
        {
          configuredPath: s.xrayPath,
          version: s.xrayVersion,
          cacheRoot: this.ctx.globalStorageUri.fsPath,
          bundledRoot: this.ctx.extensionPath,
          allowUnverified: s.allowUnverifiedBinary,
        },
        this.logger,
      );
      const socksPort = await resolvePort(s.localSocksPort);
      const httpPort = await resolvePort(s.localHttpPort);
      const whitelist = normalizeWhitelist(s.whitelistExtras);
      const config = buildXrayConfig(profile, {
        socksPort,
        httpPort,
        whitelistDomains: whitelist,
        strict: s.strictWhitelist,
      });

      this.xray = new XrayProcess(binPath, this.logger);
      await this.xray.start(config, httpPort);
      this.xrayHttpPort = httpPort;
      this.logger.info(
        `Xray up. Local SOCKS ${socksPort}, HTTP ${httpPort}. Mode: ${s.strictWhitelist ? 'strict (block)' : 'direct fallback'}.`,
      );
      return httpPort;
    });
  }

  private async stopXrayIfIdle(): Promise<void> {
    return this.xEnqueue(async () => {
      // needsXray() covers reconnecting sessions too (a session between apply and remove still holds
      // a tunnel that pipes to the shared Xray port), so we never stop it out from under a peer.
      const anyLive = [...this.sessions.values()].some((s) => s.needsXray());
      if (this.pendingApplies === 0 && !anyLive && this.xray) {
        this.xray.stop();
        this.xray = undefined;
        this.xrayHttpPort = 0;
        this.logger.info('Xray stopped (no active clusters).');
      }
    });
  }

  // ---- per-cluster operations -------------------------------------------------------------

  async applyCluster(name: string): Promise<void> {
    const cfg = this.clusters().find((c) => c.name === name);
    if (!cfg) {
      throw new Error(`No cluster named "${name}" is configured.`);
    }
    this.pendingApplies++;
    try {
      const httpPort = await this.ensureXray();
      let session = this.sessions.get(name);
      if (!session) {
        session = new ClusterSession(cfg, this.logger, this.secrets, {
          onStateChange: () => this.refreshStatus(),
          onNotice: (m, o) => this.notice(m, o),
        });
        this.sessions.set(name, session);
      } else {
        session.updateConfig(cfg);
      }
      const noProxy = resolveNoProxyForCluster(readSettings(), cfg);
      await session.apply({
        localHttpPort: httpPort,
        noProxy,
        allowLegacySecret: this.clusters().length === 1,
      });
    } catch (e) {
      this.reportError(e as Error);
    } finally {
      this.pendingApplies--;
      this.refreshStatus();
      await this.stopXrayIfIdle();
    }
  }

  async removeCluster(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) {
      return;
    }
    await session.remove();
    this.sessions.delete(name);
    this.refreshStatus();
    await this.stopXrayIfIdle();
  }

  async restartCluster(name: string): Promise<void> {
    await this.removeCluster(name);
    await this.applyCluster(name);
  }

  async applyAll(): Promise<void> {
    const cfgs = this.clusters();
    if (cfgs.length === 0) {
      throw new Error('No clusters configured. Set ultraproxy.clusters or the SSH host/user.');
    }
    await Promise.allSettled(cfgs.map((c) => this.applyCluster(c.name)));
  }

  async removeAll(): Promise<void> {
    const names = [...this.sessions.keys()];
    await Promise.allSettled(names.map((n) => this.removeCluster(n)));
  }

  async testCluster(name: string): Promise<ProviderTest[]> {
    const session = this.sessions.get(name);
    if (!session || !session.isActive()) {
      throw new Error(`Cluster "${name}" is not active. Apply it first.`);
    }
    const s = readSettings();
    const anthKey = (await this.secrets.getAnthropicKey()) || undefined;
    const oaiKey = (await this.secrets.getOpenAIKey()) || undefined;
    this.logger.addSecret(anthKey);
    this.logger.addSecret(oaiKey);
    return session.testConnection({
      localHttpPort: this.xrayHttpPort,
      testEndpoints: s.testEndpoints,
      anthKey,
      oaiKey,
    });
  }

  // ---- status / notices -------------------------------------------------------------------

  private refreshStatus(): void {
    const sessions = [...this.sessions.values()];
    const total = this.clusters().length;
    const active = sessions.filter((s) => s.isActive()).length;
    const starting = this.pendingApplies > 0 || sessions.some((s) => s.state === 'starting');
    const error = active === 0 && sessions.some((s) => s.state === 'error');
    this.status.setSummary({ active, total, starting, error });
  }

  private notice(message: string, opts?: { reload?: boolean; warn?: boolean }): void {
    // Only offer the "Reload Window" button for a single cluster (it reloads THIS window, which
    // helps at most one cluster). With several clusters, just advise reloading each in the text.
    const buttons = opts?.reload && this.clusters().length === 1 ? ['Reload Window'] : [];
    const p = opts?.warn
      ? vscode.window.showWarningMessage(`UltraProxy: ${message}`, ...buttons)
      : vscode.window.showInformationMessage(`UltraProxy: ${message}`, ...buttons);
    p.then((choice) => {
      if (choice === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  }

  private reportError(err: Error): void {
    this.logger.error('UltraProxy error', err);
    this.refreshStatus();
    vscode.window.showErrorMessage(`UltraProxy: ${err.message}`, 'Show Log').then((c) => {
      if (c === 'Show Log') {
        this.logger.show();
      }
    });
  }

  describeStatus(): string {
    const cfgs = this.clusters();
    if (cfgs.length === 0) {
      return 'No clusters configured.';
    }
    return cfgs
      .map((c) => {
        const s = this.sessions.get(c.name);
        return `${c.name}: ${s ? s.describe() : 'off'}`;
      })
      .join('\n');
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.disposeLocal()));
    this.sessions.clear();
    await this.xEnqueue(async () => {
      if (this.xray) {
        this.xray.stop();
        this.xray = undefined;
        this.xrayHttpPort = 0;
      }
    });
  }
}
