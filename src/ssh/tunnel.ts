import * as net from 'net';
import { Client, ConnectConfig } from 'ssh2';
import { Logger } from '../util/logger';

export interface TunnelOptions {
  connectConfig: ConnectConfig;
  keyboardPassword?: string;
  /** Optional bastion (ssh -J): connect here first, then reach the target host through it. */
  jump?: {
    connectConfig: ConnectConfig;
    keyboardPassword?: string;
  };
  /** Remote bind address; 127.0.0.1 keeps the forwarded port loopback-only on the cluster. */
  remoteBindAddr: string;
  /** Requested remote port; 0 = auto-assign (recommended on shared clusters). */
  remotePort: number;
  /** Local xray HTTP inbound port that remote connections are piped to. */
  localPort: number;
}

export interface TunnelHooks {
  /** Called after each successful forward (initial + every reconnect) with the bound remote port and live client. */
  onUp: (boundRemotePort: number, client: Client) => void | Promise<void>;
  /** Called whenever the SSH connection drops. */
  onDown: () => void;
  /** Called on an unrecoverable error (e.g. auth failure, forward rejected). */
  onFatal: (err: Error) => void;
}

const MAX_BACKOFF_MS = 30000;
// Start the first reconnect attempt quickly: a transient reset (ECONNRESET) usually re-establishes
// immediately, and every second of gap is a window where a cluster request (e.g. a Claude token
// refresh) can fail. Subsequent attempts back off toward MAX so a genuinely-down host isn't hammered.
const INITIAL_BACKOFF_MS = 250;

/**
 * A reverse SSH tunnel (equivalent to `ssh -R`) with auto-reconnect.
 * cluster 127.0.0.1:boundRemotePort -> local 127.0.0.1:localPort
 */
export class SshTunnel {
  private client: Client | null = null;
  private jumpClient: Client | null = null;
  private stopped = false;
  private everReady = false;
  /** True while a main client is connected (used to decide if a bastion error must self-reschedule). */
  private mainAlive = false;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly opts: TunnelOptions,
    private readonly logger: Logger,
    private readonly hooks: TunnelHooks,
  ) {}

  start(): void {
    this.stopped = false;
    this.backoff = INITIAL_BACKOFF_MS;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const c = this.client;
    this.client = null;
    this.endJump();
    if (!c) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      c.once('close', done);
      try {
        c.end();
      } catch {
        done();
      }
      setTimeout(done, 3000);
    });
  }

  /** Tear down the bastion connection (if any). Safe to call repeatedly. */
  private endJump(): void {
    const j = this.jumpClient;
    this.jumpClient = null;
    if (j) {
      try {
        j.end();
      } catch {
        /* ignore */
      }
    }
  }

  /** The live client (valid only while connected); used to run remote injection commands. */
  get connection(): Client | null {
    return this.client;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    // Every (re)connect starts from a clean bastion so a dropped tunnel re-establishes the full chain.
    this.endJump();
    if (!this.opts.jump) {
      this.startMainClient(this.opts.connectConfig);
      return;
    }

    const jump = new Client();
    this.jumpClient = jump;
    const jumpPassword = this.opts.jump.keyboardPassword;
    if (jumpPassword !== undefined) {
      jump.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => jumpPassword ?? ''));
      });
    }
    jump.on('ready', () => {
      if (this.stopped) {
        try {
          jump.end();
        } catch {
          /* ignore */
        }
        return;
      }
      const targetHost = String(this.opts.connectConfig.host ?? '');
      const targetPort = this.opts.connectConfig.port ?? 22;
      this.logger.info(`ProxyJump ready; forwarding to ${targetHost}:${targetPort}.`);
      jump.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
        if (this.stopped) {
          return;
        }
        if (err || !stream) {
          const e = err ?? new Error('ProxyJump forward returned no stream');
          this.logger.error('ProxyJump forward failed', e);
          try {
            jump.end();
          } catch {
            /* ignore */
          }
          // Before first success: fatal. After: the main client isn't created here, so its 'close'
          // won't fire — reschedule the whole chain ourselves.
          if (!this.everReady) {
            this.hooks.onFatal(new Error(`ProxyJump forward failed: ${e.message}`));
          } else if (!this.stopped) {
            this.scheduleReconnect();
          }
          return;
        }
        this.startMainClient({ ...this.opts.connectConfig, sock: stream });
      });
    });
    jump.on('error', (e) => {
      this.logger.warn(`ProxyJump SSH error: ${e.message}`);
      if (this.stopped) {
        return;
      }
      if (!this.everReady) {
        this.hooks.onFatal(e);
      } else if (!this.mainAlive) {
        // Bastion dropped during a reconnect before a main client existed, so no main 'close' will
        // fire to retry. When a main client IS alive, its own 'close' handles the reschedule.
        this.scheduleReconnect();
      }
    });
    try {
      jump.connect(this.opts.jump.connectConfig);
    } catch (e) {
      this.hooks.onFatal(e as Error);
    }
  }

  private startMainClient(config: ConnectConfig): void {
    if (this.stopped) {
      return;
    }
    const client = new Client();
    this.client = client;

    if (this.opts.keyboardPassword !== undefined) {
      client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => this.opts.keyboardPassword ?? ''));
      });
    }

    client.on('ready', () => {
      this.logger.info('SSH connection ready.');
      this.everReady = true;
      this.mainAlive = true;
      this.backoff = INITIAL_BACKOFF_MS;
      client.forwardIn(this.opts.remoteBindAddr, this.opts.remotePort, (err, boundPort) => {
        if (err) {
          this.logger.error('Reverse forward failed', err);
          this.hooks.onFatal(new Error(`Reverse forward failed: ${err.message}`));
          try {
            client.end();
          } catch {
            /* ignore */
          }
          return;
        }
        const port = this.opts.remotePort === 0 ? boundPort : this.opts.remotePort;
        this.logger.info(
          `Reverse tunnel up: cluster ${this.opts.remoteBindAddr}:${port} -> local 127.0.0.1:${this.opts.localPort}`,
        );
        Promise.resolve(this.hooks.onUp(port, client)).catch((e) =>
          this.logger.error('onUp hook failed', e),
        );
      });
    });

    client.on('tcp connection', (_info, accept, reject) => {
      const local = net.connect(this.opts.localPort, '127.0.0.1');
      local.once('connect', () => {
        const stream = accept();
        stream.pipe(local);
        local.pipe(stream);
        const cleanup = () => {
          try {
            stream.destroy();
          } catch {
            /* ignore */
          }
          try {
            local.destroy();
          } catch {
            /* ignore */
          }
        };
        stream.on('error', cleanup);
        stream.on('close', cleanup);
        local.on('error', cleanup);
        local.on('close', cleanup);
      });
      local.once('error', (e) => {
        this.logger.warn(`Local proxy connect failed: ${e.message}`);
        try {
          reject();
        } catch {
          /* ignore */
        }
      });
    });

    client.on('error', (e) => {
      this.logger.warn(`SSH error: ${e.message}`);
      // A failure on the very first connection (bad host/credentials) is fatal — don't loop.
      if (!this.everReady && !this.stopped) {
        this.hooks.onFatal(e);
      }
    });

    // 'close' is the terminal event for the main client.
    client.on('close', () => {
      this.mainAlive = false;
      this.hooks.onDown();
      this.endJump();
      if (this.stopped) {
        return;
      }
      if (!this.everReady) {
        // Initial connection never succeeded; onFatal already fired from 'error'. Do not reconnect.
        this.logger.warn('Initial SSH connection failed; not reconnecting.');
        return;
      }
      this.scheduleReconnect();
    });

    try {
      client.connect(config);
    } catch (e) {
      this.hooks.onFatal(e as Error);
    }
  }

  /**
   * Schedule a single backoff reconnect. Guarded so overlapping triggers (e.g. the bastion erroring
   * AND the main client closing when the tunnel drops together) don't stack multiple timers.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.logger.warn(`SSH closed; reconnecting in ${delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
