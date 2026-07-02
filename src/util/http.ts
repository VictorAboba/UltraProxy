import * as https from 'https';
import * as http from 'http';

export interface HttpGetOptions {
  headers?: Record<string, string>;
  redirects?: number;
  timeoutMs?: number;
}

/**
 * Minimal GET that follows redirects and returns the raw body.
 * TLS verification is intentionally NOT disabled (SIP008/subscription spec requirement,
 * and binary downloads must be authentic).
 */
export function httpGet(url: string, opts: HttpGetOptions = {}): Promise<Buffer> {
  const redirects = opts.redirects ?? 6;
  const timeoutMs = opts.timeoutMs ?? 30000;
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      parsed,
      { headers: { 'User-Agent': 'UltraProxy', ...(opts.headers ?? {}) } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) {
            return reject(new Error(`Too many redirects for ${url}`));
          }
          const next = new URL(res.headers.location, parsed).toString();
          resolve(httpGet(next, { ...opts, redirects: redirects - 1 }));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${status} for ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timeout: ${url}`)));
  });
}
