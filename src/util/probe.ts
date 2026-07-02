import * as net from 'net';
import * as tls from 'tls';

export interface ProbeResult {
  /** True if we got any HTTP response back from the target through the proxy. */
  ok: boolean;
  /** Status of the proxy CONNECT response (200 expected). */
  proxyStatus?: number;
  /** HTTP status returned by the target server. */
  status?: number;
  /** Response body (de-chunked) when available. */
  body?: string;
  error?: string;
}

/**
 * Make an HTTPS GET to `targetUrl` through a local HTTP proxy (Xray's http inbound) by issuing a
 * CONNECT, upgrading to TLS, and reading one response. Dependency-free; used for connection tests.
 */
export function probeViaHttpProxy(
  proxyPort: number,
  targetUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      return resolve({ ok: false, error: `invalid url: ${targetUrl}` });
    }
    const host = url.hostname;
    const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;

    let settled = false;
    let socket: net.Socket;
    let tlsSock: tls.TLSSocket | undefined;
    const done = (r: ProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        tlsSock?.destroy();
      } catch {
        /* ignore */
      }
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);

    socket = net.connect(proxyPort, '127.0.0.1');
    socket.on('error', (e) => done({ ok: false, error: e.message }));
    socket.on('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });

    let connectBuf = '';
    const onConnectData = (chunk: Buffer) => {
      connectBuf += chunk.toString('latin1');
      const idx = connectBuf.indexOf('\r\n\r\n');
      if (idx < 0) {
        return;
      }
      socket.removeListener('data', onConnectData);
      const proxyStatus = parseStatus(connectBuf);
      if (proxyStatus !== 200) {
        return done({ ok: false, proxyStatus, error: `proxy CONNECT returned ${proxyStatus}` });
      }
      tlsSock = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] }, () => {
        const path = `${url.pathname}${url.search}` || '/';
        let req = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: UltraProxy\r\nAccept: application/json\r\nConnection: close\r\n`;
        for (const [k, v] of Object.entries(headers)) {
          req += `${k}: ${v}\r\n`;
        }
        req += '\r\n';
        tlsSock!.write(req);
      });
      const chunks: Buffer[] = [];
      tlsSock.on('data', (d: Buffer) => chunks.push(d));
      tlsSock.on('error', (e) => done({ ok: false, proxyStatus, error: e.message }));
      tlsSock.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const headEnd = text.indexOf('\r\n\r\n');
        const status = parseStatus(text);
        const rawBody = headEnd >= 0 ? text.slice(headEnd + 4) : '';
        const isChunked = /transfer-encoding:\s*chunked/i.test(headEnd >= 0 ? text.slice(0, headEnd) : text);
        done({ ok: true, proxyStatus, status, body: isChunked ? dechunk(rawBody) : rawBody });
      });
    };
    socket.on('data', onConnectData);
  });
}

function parseStatus(response: string): number {
  const line = response.slice(0, response.indexOf('\r\n'));
  const m = line.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function dechunk(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf('\r\n', i);
    if (nl < 0) {
      break;
    }
    const size = Number.parseInt(body.slice(i, nl).trim(), 16);
    if (Number.isNaN(size) || size === 0) {
      break;
    }
    const start = nl + 2;
    out += body.slice(start, start + size);
    i = start + size + 2;
  }
  return out;
}

/** Extract model ids from an Anthropic/OpenAI `{ data: [{ id }] }` models response. */
export function extractModelIds(body: string): string[] | undefined {
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json?.data)) {
      return json.data.map((m: { id?: string }) => m.id).filter((x: unknown): x is string => typeof x === 'string');
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}
