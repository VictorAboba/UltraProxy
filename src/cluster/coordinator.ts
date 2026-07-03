import * as fs from 'fs';
import * as path from 'path';

export interface OwnershipEntry {
  /** Opaque per-activation instance id of the owning extension host. */
  owner: string;
  /** Owning extension-host pid (informational, shown in status). */
  pid: number;
  /** Reverse-tunnel bound remote port, for display in other windows. */
  boundPort?: number;
  /** ms-epoch of the owner's last heartbeat; liveness is derived from this. */
  heartbeatAt: number;
}

type State = Record<string, OwnershipEntry>;

export interface CoordinatorOptions {
  id?: string;
  pid?: number;
  /** How often the owner refreshes its heartbeats (ms). */
  heartbeatMs?: number;
  /** An owner is considered dead once its heartbeat is older than this (ms). */
  staleMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

const FILE = 'instances.json';

/**
 * Cross-window ownership of clusters.
 *
 * UltraProxy is a `ui` extension, so every VSCode window runs its own extension host with
 * INDEPENDENT in-memory state. Without coordination, two windows each start a tunnel + Xray for the
 * same cluster (port conflicts, double injection) and each reports the other's work as "off". This
 * persists a tiny ownership record to the shared globalStorage dir so an instance can:
 *   - claim a cluster and SKIP applying one another live window already owns,
 *   - surface an accurate "managed by another window" status,
 *   - take over a cluster whose owner window died (stale heartbeat).
 *
 * It is intentionally FAIL-OPEN: any filesystem error degrades to "no coordination" (allow the
 * apply) rather than blocking the user.
 */
export class InstanceCoordinator {
  readonly id: string;
  private readonly pid: number;
  private readonly file: string;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly clock: () => number;
  private timer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly dir: string, opts: CoordinatorOptions = {}) {
    this.pid = opts.pid ?? process.pid;
    this.id = opts.id ?? `${this.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.file = path.join(dir, FILE);
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.staleMs = opts.staleMs ?? 30_000;
    this.clock = opts.now ?? (() => Date.now());
  }

  /** Begin the heartbeat that keeps this instance's claims fresh (and prunes dead peers). */
  start(): void {
    if (this.timer || this.disposed) {
      return;
    }
    this.timer = setInterval(() => this.beat(), this.heartbeatMs);
    // Don't keep the host process alive just for the heartbeat.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private isLive(e: OwnershipEntry): boolean {
    return this.clock() - e.heartbeatAt < this.staleMs;
  }

  private read(): State {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as State) : {};
    } catch {
      return {};
    }
  }

  private write(state: State): void {
    fs.mkdirSync(this.dir, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file (atomic on one volume).
    const tmp = `${this.file}.${this.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Drop entries whose owner heartbeat is stale (dead windows). Mutates and returns `state`. */
  private prune(state: State): State {
    for (const [name, e] of Object.entries(state)) {
      if (!this.isLive(e)) {
        delete state[name];
      }
    }
    return state;
  }

  /**
   * Try to become the owner of `name`. Returns true if this instance may proceed to apply, or false
   * if a LIVE different window already owns it (caller should skip, not start a duplicate tunnel).
   * A free slot, a slot already owned by this instance, or a stale (dead) owner are all claimable.
   */
  claim(name: string): boolean {
    if (this.disposed) {
      return true; // coordination off -> fail open
    }
    try {
      const state = this.prune(this.read());
      const cur = state[name];
      if (cur && cur.owner !== this.id && this.isLive(cur)) {
        return false;
      }
      state[name] = {
        owner: this.id,
        pid: this.pid,
        boundPort: cur?.owner === this.id ? cur.boundPort : undefined,
        heartbeatAt: this.clock(),
      };
      this.write(state);
      return true;
    } catch {
      return true; // fail open
    }
  }

  /** Record the bound remote port for display in other windows. No-op unless this instance owns it. */
  setBoundPort(name: string, port: number): void {
    if (this.disposed) {
      return;
    }
    try {
      const state = this.read();
      const cur = state[name];
      if (cur && cur.owner === this.id) {
        cur.boundPort = port || undefined;
        cur.heartbeatAt = this.clock();
        this.write(state);
      }
    } catch {
      /* ignore */
    }
  }

  /** Release this instance's ownership of a cluster (on Remove). */
  release(name: string): void {
    try {
      const state = this.read();
      if (state[name]?.owner === this.id) {
        delete state[name];
        this.write(state);
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * If a LIVE different window owns `name`, return its record (for "managed by another window"
   * status). Returns undefined if this instance owns it, it's free, or the owner is stale/dead.
   */
  foreignOwner(name: string): OwnershipEntry | undefined {
    if (this.disposed) {
      return undefined;
    }
    try {
      const e = this.read()[name];
      if (e && e.owner !== this.id && this.isLive(e)) {
        return e;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  /** Refresh heartbeats for clusters this instance owns; prune dead peers. */
  private beat(): void {
    try {
      const state = this.read();
      let changed = false;
      for (const [name, e] of Object.entries(state)) {
        if (!this.isLive(e)) {
          delete state[name];
          changed = true;
        }
      }
      for (const e of Object.values(state)) {
        if (e.owner === this.id) {
          e.heartbeatAt = this.clock();
          changed = true;
        }
      }
      if (changed) {
        this.write(state);
      }
    } catch {
      /* ignore */
    }
  }

  /** Release every cluster owned by this instance and stop the heartbeat. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      const state = this.read();
      let changed = false;
      for (const [name, e] of Object.entries(state)) {
        if (e.owner === this.id) {
          delete state[name];
          changed = true;
        }
      }
      if (changed) {
        this.write(state);
      }
    } catch {
      /* ignore */
    }
  }
}
