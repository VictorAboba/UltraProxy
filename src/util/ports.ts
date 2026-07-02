import * as net from 'net';

/** Ask the OS for a free ephemeral TCP port on 127.0.0.1. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not determine free port')));
      }
    });
  });
}

/** Resolve a configured port (>0) or allocate a free one when the value is 0/undefined. */
export async function resolvePort(configured: number | undefined): Promise<number> {
  if (configured && configured > 0) {
    return configured;
  }
  return findFreePort();
}

/** Probe whether something is accepting TCP connections on 127.0.0.1:port. */
export function probeTcp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}
