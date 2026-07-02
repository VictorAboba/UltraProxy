import { ChildProcessByStdio, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { Logger } from '../util/logger';
import { probeTcp } from '../util/ports';

/** Manages one xray-core child process (config on disk, health detection, teardown). */
export class XrayProcess {
  private proc?: ChildProcessByStdio<null, Readable, Readable>;
  private configPath?: string;
  private stopped = false;

  constructor(private readonly binPath: string, private readonly logger: Logger) {}

  /** Write the config to a temp file and start xray, resolving once it is healthy. */
  async start(config: unknown, httpPort: number): Promise<void> {
    this.stopped = false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultraproxy-'));
    this.configPath = path.join(dir, 'config.json');
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

    const proc = spawn(this.binPath, ['run', '-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let sawStarted = false;
      const finishOk = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const finishErr = (msg: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error(msg));
      };

      const onLine = (chunk: Buffer, stream: string) => {
        const text = chunk.toString('utf8');
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) {
            continue;
          }
          this.logger.info(`[xray:${stream}] ${line}`);
          if (/Xray .* started/i.test(line)) {
            sawStarted = true;
          }
          if (/\[Error\]/i.test(line) || /failed to start/i.test(line)) {
            finishErr(`Xray failed to start: ${line}`);
          }
        }
      };

      proc.stdout.on('data', (c: Buffer) => onLine(c, 'out'));
      proc.stderr.on('data', (c: Buffer) => onLine(c, 'err'));

      proc.on('error', (e) => finishErr(`Failed to spawn xray: ${e.message}`));
      proc.on('exit', (code, signal) => {
        if (!settled) {
          finishErr(`xray exited early (code=${code}, signal=${signal})`);
        } else if (!this.stopped) {
          this.logger.warn(`xray process exited unexpectedly (code=${code}, signal=${signal})`);
        }
      });

      // Health = the "started" log line AND a successful TCP probe of the HTTP inbound.
      const poll = setInterval(async () => {
        if (settled) {
          clearInterval(poll);
          return;
        }
        if (sawStarted && (await probeTcp(httpPort))) {
          clearInterval(poll);
          finishOk();
        }
      }, 400);

      const timer = setTimeout(() => {
        clearInterval(poll);
        finishErr('Timed out waiting for xray to become healthy (15s)');
      }, 15000);
    });
  }

  isRunning(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  stop(): void {
    this.stopped = true;
    const proc = this.proc;
    this.proc = undefined;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
    if (this.configPath) {
      try {
        fs.rmSync(path.dirname(this.configPath), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.configPath = undefined;
    }
  }
}
