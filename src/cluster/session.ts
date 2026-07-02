import { Client } from 'ssh2';
import { Secrets } from '../config/secrets';
import { ClusterConfig, parseJumpSpec } from '../config/settings';
import { detectRemote, RemoteInfo } from '../remote/detect';
import { applyInjection, InjectResult, removeInjection } from '../remote/injector';
import { RemoteExecProfile, wrapExec } from '../remote/scripts';
import { makeConnectConfig, SshAuth } from '../ssh/connect';
import { CmdWrap, exec } from '../ssh/exec';
import { SshTunnel } from '../ssh/tunnel';
import { Logger } from '../util/logger';
import { extractModelIds, probeViaHttpProxy } from '../util/probe';

export type SessionState = 'off' | 'starting' | 'on' | 'error';

export interface ProviderTest {
  name: string;
  url: string;
  local: { ok: boolean; label: string };
  remote: { ok: boolean; label: string };
  models?: string[];
}

export interface SessionApplyParams {
  localHttpPort: number;
  noProxy: string[];
  /** Allow the pre-multi-cluster legacy secret fallback (only safe when there is a single cluster). */
  allowLegacySecret: boolean;
}

export interface SessionTestParams {
  localHttpPort: number;
  testEndpoints: string[];
  anthKey?: string;
  oaiKey?: string;
}

export interface SessionHooks {
  onStateChange: () => void;
  onNotice: (message: string, opts?: { reload?: boolean; warn?: boolean }) => void;
}

interface TestTarget {
  name: string;
  url: string;
  headers: Record<string, string>;
  parseModels: boolean;
}

const FIRST_TIMEOUT_MS = 45000;

/**
 * Manages one cluster: a reverse SSH tunnel to a SHARED local Xray HTTP port, plus remote injection.
 * Owns the same race-safety guarantees as the top-level lifecycle (serial queue, generation token,
 * first-injection wait with timeout) but does NOT own the Xray process.
 */
export class ClusterSession {
  private tunnel?: SshTunnel;
  private remoteInfo?: RemoteInfo;
  private boundPort = 0;
  private lastBoundPort = 0;
  private localHttpPort = 0;
  private stateVal: SessionState = 'off';
  private applying = false;
  private lastError?: string;
  private generation = 0;
  private opQueue: Promise<unknown> = Promise.resolve();
  private pendingCfg?: ClusterConfig;

  constructor(
    private cfg: ClusterConfig,
    private readonly logger: Logger,
    private readonly secrets: Secrets,
    private readonly hooks: SessionHooks,
  ) {}

  get name(): string {
    return this.cfg.name;
  }
  get state(): SessionState {
    return this.stateVal;
  }
  isActive(): boolean {
    return this.stateVal === 'on';
  }
  isBusy(): boolean {
    return this.applying;
  }
  /** True whenever a tunnel exists (connecting, on, OR reconnecting) — i.e. still needs the Xray port. */
  needsXray(): boolean {
    return this.tunnel !== undefined;
  }
  get connection(): Client | null {
    return this.tunnel?.connection ?? null;
  }
  get boundRemotePort(): number {
    return this.boundPort;
  }

  /**
   * Stage a new config. It is NOT applied to this.cfg immediately (that would race an in-flight
   * apply reading this.cfg across await points); it is swapped in at the head of the next doApply.
   */
  updateConfig(cfg: ClusterConfig): void {
    this.pendingCfg = cfg;
  }

  describe(): string {
    switch (this.stateVal) {
      case 'on':
        return `on — cluster ${this.cfg.host} 127.0.0.1:${this.boundPort}`;
      case 'starting':
        return this.applying ? 'connecting…' : 'reconnecting…';
      case 'error':
        return `error: ${this.lastError ?? 'unknown'}`;
      default:
        return 'off';
    }
  }

  private tag(): string {
    return `[${this.cfg.name}]`;
  }

  /** A per-command wrapper reflecting this cluster's exec profile (direct / docker / custom). */
  private execWrap(): CmdWrap {
    const p: RemoteExecProfile = {
      profile: this.cfg.execProfile,
      dockerContainer: this.cfg.dockerContainer,
      execTemplate: this.cfg.execTemplate,
    };
    return (cmd) => wrapExec(cmd, p);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opQueue.then(fn, fn);
    this.opQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  apply(params: SessionApplyParams): Promise<void> {
    return this.enqueue(() => this.doApply(params));
  }

  remove(): Promise<void> {
    return this.enqueue(() => this.doRemove());
  }

  /** Stop the tunnel locally without remote cleanup (used on extension deactivate). */
  disposeLocal(): Promise<void> {
    return this.enqueue(async () => {
      await this.teardown(false);
      this.setState('off');
    });
  }

  private setState(s: SessionState, detail?: string): void {
    this.stateVal = s;
    if (s === 'error') {
      this.lastError = detail;
    }
    this.hooks.onStateChange();
  }

  private async doApply(params: SessionApplyParams): Promise<void> {
    if (this.isActive()) {
      await this.teardown(true);
    }
    // Swap in a staged config now (synchronously) so this apply reads a single, stable config.
    if (this.pendingCfg) {
      this.cfg = this.pendingCfg;
      this.pendingCfg = undefined;
    }
    const gen = ++this.generation;
    this.applying = true;
    this.lastError = undefined;
    this.lastBoundPort = 0;
    this.localHttpPort = params.localHttpPort;
    this.setState('starting');

    try {
      await this.startTunnel(params, gen);
    } catch (e) {
      await this.teardown(false);
      this.reportError(e as Error);
    } finally {
      this.applying = false;
      this.hooks.onStateChange();
    }
  }

  private async startTunnel(params: SessionApplyParams, gen: number): Promise<void> {
    const password = (await this.secrets.getSshPassword(this.cfg.name, params.allowLegacySecret)) || undefined;
    const passphrase = (await this.secrets.getSshKeyPassphrase(this.cfg.name, params.allowLegacySecret)) || undefined;
    this.logger.addSecret(password);
    this.logger.addSecret(passphrase);

    const auth: SshAuth = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.user,
      authMethod: this.cfg.authMethod,
      privateKeyPath: this.cfg.privateKeyPath,
      passphrase,
      password,
      agentPath: this.cfg.agentPath,
    };
    const { config: connectConfig, keyboardPassword } = makeConnectConfig(auth);

    // ProxyJump: build a bastion connection reusing the cluster's own credentials. The bastion's own
    // port defaults to 22 (like `ssh -J`), independent of the cluster's SSH port, unless the spec
    // carries an explicit :port.
    let jump: { connectConfig: typeof connectConfig; keyboardPassword?: string } | undefined;
    const jumpSpec = this.cfg.proxyJump ? parseJumpSpec(this.cfg.proxyJump, this.cfg.user, 22) : undefined;
    if (jumpSpec) {
      const built = makeConnectConfig({ ...auth, host: jumpSpec.host, username: jumpSpec.user, port: jumpSpec.port });
      jump = { connectConfig: built.config, keyboardPassword: built.keyboardPassword };
      this.logger.info(`${this.tag()} using ProxyJump ${jumpSpec.user}@${jumpSpec.host}:${jumpSpec.port}`);
    }

    return new Promise<void>((resolve, reject) => {
      let firstSettled = false;
      let firstTimer: NodeJS.Timeout | undefined;
      const settleOk = () => {
        if (!firstSettled) {
          firstSettled = true;
          if (firstTimer) {
            clearTimeout(firstTimer);
          }
          resolve();
        }
      };
      const settleErr = (e: Error) => {
        if (!firstSettled) {
          firstSettled = true;
          if (firstTimer) {
            clearTimeout(firstTimer);
          }
          reject(e);
        }
      };
      firstTimer = setTimeout(
        () =>
          settleErr(
            new Error(
              `Timed out establishing the reverse tunnel to ${this.cfg.host} (45s). ` +
                'Check SSH connectivity and that the server permits TCP port forwarding.',
            ),
          ),
        FIRST_TIMEOUT_MS,
      );

      this.tunnel = new SshTunnel(
        {
          connectConfig,
          keyboardPassword,
          jump,
          remoteBindAddr: '127.0.0.1',
          remotePort: this.cfg.remoteProxyPort,
          localPort: this.localHttpPort,
        },
        this.logger,
        {
          onUp: async (boundPort, client) => {
            if (gen !== this.generation) {
              return;
            }
            try {
              const wrap = this.execWrap();
              this.boundPort = boundPort;
              if (!this.remoteInfo) {
                this.remoteInfo = await detectRemote(client, wrap);
                this.logger.info(
                  `${this.tag()} remote home=${this.remoteInfo.home} python3=${this.remoteInfo.hasPython3} servers=[${this.remoteInfo.serverDirs.join(', ')}]`,
                );
              }
              const proxyUrl = `http://127.0.0.1:${boundPort}`;
              const res = await applyInjection(
                client,
                this.remoteInfo,
                {
                  proxyUrl,
                  noProxy: params.noProxy,
                  patchSettings: this.cfg.patchCopilotSettings,
                  injectTerminal: this.cfg.injectTerminalEnv,
                  injectServerEnv: this.cfg.injectServerEnv,
                  wrapClaudeCode: this.cfg.wrapClaudeCode,
                },
                this.logger,
                wrap,
              );
              if (gen !== this.generation) {
                return;
              }
              const isFirst = !firstSettled;
              const portChanged = this.lastBoundPort !== 0 && this.lastBoundPort !== boundPort;
              this.lastBoundPort = boundPort;
              this.setState('on');
              this.announce(res, proxyUrl, isFirst, portChanged);
              settleOk();
            } catch (e) {
              if (gen !== this.generation) {
                return;
              }
              if (!firstSettled) {
                settleErr(e as Error);
              } else {
                this.logger.error(`${this.tag()} re-injection failed after reconnect`, e);
                this.setState('error', (e as Error).message);
              }
            }
          },
          onDown: () => {
            if (gen !== this.generation) {
              return;
            }
            if (this.isActive()) {
              this.setState('starting');
            }
          },
          onFatal: (err) => {
            if (gen !== this.generation) {
              return;
            }
            if (!firstSettled) {
              settleErr(err);
            } else {
              void this.enqueue(() => this.failInner(err, gen));
            }
          },
        },
      );
      this.tunnel.start();
    });
  }

  private announce(res: InjectResult, proxyUrl: string, isFirst: boolean, portChanged: boolean): void {
    if (res.settingsSkippedReason && isFirst) {
      this.logger.warn(`${this.tag()} remote settings not patched: ${res.settingsSkippedReason}`);
    }
    if (isFirst) {
      this.logger.info(`${this.tag()} proxy ready at ${proxyUrl}`);
      const extra = res.serverEnvWritten
        ? ' For extension-host tools, also run "Remote-SSH: Kill VS Code Server on Host" and reconnect.'
        : '';
      this.hooks.onNotice(
        `Cluster "${this.cfg.name}" ready (${proxyUrl}). Reload that cluster's VSCode window and open a new terminal so tools pick up the proxy.${extra}`,
        { reload: true },
      );
    } else if (portChanged) {
      this.hooks.onNotice(
        `Cluster "${this.cfg.name}" reconnected on a NEW port (${proxyUrl}). Reload its window and reopen terminals.`,
        { reload: true, warn: true },
      );
    } else {
      this.logger.info(`${this.tag()} reconnected; ${proxyUrl} re-applied.`);
    }
  }

  private async failInner(err: Error, gen: number): Promise<void> {
    if (gen !== this.generation || !this.tunnel) {
      return;
    }
    await this.teardown(false);
    this.reportError(err);
  }

  private async doRemove(): Promise<void> {
    await this.teardown(true);
    this.setState('off');
    this.logger.info(`${this.tag()} stopped.`);
  }

  private async teardown(removeRemote: boolean): Promise<void> {
    if (removeRemote && this.tunnel?.connection && this.remoteInfo) {
      try {
        await removeInjection(this.tunnel.connection, this.remoteInfo, this.cfg.patchCopilotSettings, this.logger, this.execWrap());
      } catch (e) {
        this.logger.warn(`${this.tag()} remote cleanup failed: ${(e as Error).message}`);
      }
    }
    if (this.tunnel) {
      await this.tunnel.stop();
      this.tunnel = undefined;
    }
    this.remoteInfo = undefined;
    this.boundPort = 0;
    this.lastBoundPort = 0;
    this.generation++; // invalidate any in-flight callbacks from the torn-down generation
  }

  private reportError(err: Error): void {
    this.logger.error(`${this.tag()} error`, err);
    this.setState('error', err.message);
    this.hooks.onNotice(`Cluster "${this.cfg.name}": ${err.message}`, { warn: true });
  }

  /** Probe reachability from both sides (local Xray + remote curl); list models if a key is set. */
  async testConnection(params: SessionTestParams): Promise<ProviderTest[]> {
    if (!this.isActive() || !this.tunnel?.connection) {
      throw new Error(`Cluster "${this.cfg.name}" is not active.`);
    }
    const client = this.tunnel.connection;
    const proxyUrl = `http://127.0.0.1:${this.boundPort}`;
    const targets = buildTestTargets(params.testEndpoints, params.anthKey, params.oaiKey, this.logger);

    this.logger.info(`=== connection test ${this.tag()} ===`);
    const out: ProviderTest[] = [];
    for (const t of targets) {
      const local = await probeViaHttpProxy(params.localHttpPort, t.url, t.headers);
      const remoteCode = await remoteHttpCode(client, proxyUrl, t.url, this.execWrap());

      const localOk = local.ok && isReachable(local.status);
      const remoteOk = isReachable(Number.parseInt(remoteCode, 10));
      const models =
        t.parseModels && local.ok && local.status === 200 && local.body ? extractModelIds(local.body) : undefined;

      const localLabel = local.ok ? `HTTP ${local.status}` : local.error || 'failed';
      const remoteLabel =
        remoteCode === 'NOCURL' ? 'no curl on cluster' : remoteCode === '000' ? 'unreachable' : `HTTP ${remoteCode}`;

      this.logger.info(
        `${this.tag()} ${t.name}: local=${localLabel} remote=${remoteLabel}${models ? ` models=${models.length}` : ''}`,
      );
      if (models && models.length) {
        this.logger.info(`  models: ${models.slice(0, 30).join(', ')}${models.length > 30 ? ', …' : ''}`);
      }
      out.push({
        name: t.name,
        url: t.url,
        local: { ok: localOk, label: localLabel },
        remote: { ok: remoteOk, label: remoteLabel },
        models,
      });
    }
    return out;
  }
}

function buildTestTargets(extra: string[], anthKey: string | undefined, oaiKey: string | undefined, logger: Logger): TestTarget[] {
  const targets: TestTarget[] = [
    {
      name: 'Anthropic',
      url: 'https://api.anthropic.com/v1/models',
      parseModels: true,
      headers: anthKey ? { 'x-api-key': anthKey, 'anthropic-version': '2023-06-01' } : {},
    },
    {
      name: 'OpenAI',
      url: 'https://api.openai.com/v1/models',
      parseModels: true,
      headers: oaiKey ? { Authorization: `Bearer ${oaiKey}` } : {},
    },
  ];
  for (const url of extra) {
    try {
      const u = new URL(url);
      targets.push({ name: u.hostname, url, parseModels: false, headers: {} });
    } catch {
      logger.warn(`Ignoring invalid testEndpoints entry: ${url}`);
    }
  }
  return targets;
}

async function remoteHttpCode(client: Client, proxyUrl: string, url: string, wrap?: CmdWrap): Promise<string> {
  const cmd =
    `if command -v curl >/dev/null 2>&1; then ` +
    `curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -x ${shq(proxyUrl)} ${shq(url)} 2>/dev/null || echo 000; ` +
    `else echo NOCURL; fi`;
  try {
    const r = await exec(client, cmd, wrap);
    return r.stdout.trim() || '000';
  } catch {
    return '000';
  }
}

/** Any HTTP response (2xx–4xx) means the path to the provider works; 0/5xx-from-proxy means it doesn't. */
function isReachable(status?: number): boolean {
  return typeof status === 'number' && status >= 200 && status < 500;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
