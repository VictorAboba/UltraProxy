import * as net from 'net';
import { Client, ConnectConfig } from 'ssh2';
import { Logger } from '../util/logger';

export interface TunnelOptions {
  connectConfig: ConnectConfig;
  keyboardPassword?: string;
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

/**
 * A reverse SSH tunnel (equivalent to `ssh -R`) with auto-reconnect.
 * cluster 127.0.0.1:boundRemotePort -> local 127.0.0.1:localPort
 */
export class SshTunnel {
  private client: Client | null = null;
  private stopped = false;
  private everReady = false;
  private backoff = 1000;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly opts: TunnelOptions,
    private readonly logger: Logger,
    private readonly hooks: TunnelHooks,
  ) {}

  start(): void {
    this.stopped = false;
    this.backoff = 1000;
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

  /** The live client (valid only while connected); used to run remote injection commands. */
  get connection(): Client | null {
    return this.client;
  }

  private connect(): void {
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
      this.backoff = 1000;
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

    // 'close' is the single terminal event; reconnect only here to avoid multi-firing.
    client.on('close', () => {
      this.hooks.onDown();
      if (this.stopped) {
        return;
      }
      if (!this.everReady) {
        // Initial connection never succeeded; onFatal already fired from 'error'. Do not reconnect.
        this.logger.warn('Initial SSH connection failed; not reconnecting.');
        return;
      }
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.logger.warn(`SSH closed; reconnecting in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    try {
      client.connect(this.opts.connectConfig);
    } catch (e) {
      this.hooks.onFatal(e as Error);
    }
  }
}
