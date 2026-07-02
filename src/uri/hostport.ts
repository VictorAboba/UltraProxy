export interface HostPort {
  host: string;
  port: number;
}

/**
 * Split "host:port" or "[ipv6]:port" into components.
 * Missing/invalid port is rejected (share links carry no scheme default).
 */
export function splitHostPort(input: string): HostPort {
  let s = input.trim().replace(/\/+$/, '');
  let host: string;
  let portStr: string;

  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) {
      throw new Error(`Malformed IPv6 host: ${input}`);
    }
    host = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (!rest.startsWith(':')) {
      throw new Error(`Missing port for host: ${input}`);
    }
    portStr = rest.slice(1);
  } else {
    const idx = s.lastIndexOf(':');
    if (idx < 0) {
      throw new Error(`Missing port for host: ${input}`);
    }
    host = s.slice(0, idx);
    portStr = s.slice(idx + 1);
  }

  const port = Number.parseInt(portStr, 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid host:port: ${input}`);
  }
  return { host, port };
}

export function safeDecodeURIComponent(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
