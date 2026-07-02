import { ProxyProfile, ShadowsocksProfile, VlessProfile } from '../uri/types';

export interface BuildOptions {
  socksPort: number;
  httpPort: number;
  /** Destinations routed through the proxy server (the ones the cluster cannot reach directly). */
  whitelistDomains: string[];
  /**
   * When true, non-whitelisted traffic is blocked (strict isolation).
   * When false (default), it is sent `direct` via the local machine so nothing on the cluster breaks.
   */
  strict?: boolean;
}

const DEFAULT_WHITELIST = [
  // Anthropic
  'domain:anthropic.com',
  'domain:claude.ai',
  // OpenAI
  'domain:openai.com',
  // Shared telemetry the SDKs/CLI may hit
  'domain:sentry.io',
  'domain:statsig.com',
  // GitHub Copilot backend (only GitHub hosts; safe to route via proxy)
  'domain:githubcopilot.com',
  'domain:githubusercontent.com',
  'domain:github.com',
  'domain:exp-tas.com',
];

/** Bare hostnames become `domain:<host>`; known matcher prefixes pass through verbatim. */
export function normalizeWhitelist(extras: string[]): string[] {
  const known = ['domain:', 'full:', 'regexp:', 'geosite:', 'geoip:', 'ext:'];
  const mapped = extras
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => (known.some((k) => e.startsWith(k)) ? e : `domain:${e}`));
  return dedupe([...DEFAULT_WHITELIST, ...mapped]);
}

/** True if the whitelist references geosite/geoip data files (which must then be shipped). */
export function whitelistNeedsGeoData(domains: string[]): boolean {
  return domains.some((d) => d.startsWith('geosite:') || d.startsWith('geoip:'));
}

export function buildXrayConfig(profile: ProxyProfile, opts: BuildOptions): unknown {
  const proxyOutbound = profile.kind === 'shadowsocks'
    ? buildShadowsocksOutbound(profile)
    : buildVlessOutbound(profile);

  return {
    log: { loglevel: 'warning' },
    inbounds: [socksInbound(opts.socksPort), httpInbound(opts.httpPort)],
    outbounds: [proxyOutbound, directOutbound(), blockOutbound()],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        {
          ruleTag: 'whitelist-to-proxy',
          type: 'field',
          domain: opts.whitelistDomains.length ? opts.whitelistDomains : DEFAULT_WHITELIST,
          outboundTag: 'proxy',
        },
        {
          ruleTag: 'default-route',
          type: 'field',
          network: 'tcp,udp',
          outboundTag: opts.strict ? 'block' : 'direct',
        },
      ],
    },
  };
}

function socksInbound(port: number): unknown {
  return {
    tag: 'socks-in',
    listen: '127.0.0.1',
    port,
    protocol: 'socks',
    settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
  };
}

function httpInbound(port: number): unknown {
  return {
    tag: 'http-in',
    listen: '127.0.0.1',
    port,
    protocol: 'http',
    settings: { allowTransparent: false },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
  };
}

function directOutbound(): unknown {
  return { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'AsIs' } };
}

function blockOutbound(): unknown {
  return { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'none' } } };
}

function buildShadowsocksOutbound(p: ShadowsocksProfile): unknown {
  return {
    tag: 'proxy',
    protocol: 'shadowsocks',
    settings: {
      servers: [
        {
          address: p.host,
          port: p.port,
          method: p.method,
          password: p.password,
          level: 0,
        },
      ],
    },
  };
}

function buildVlessOutbound(p: VlessProfile): unknown {
  const t = p.transport;

  const user: Record<string, unknown> = {
    id: p.uuid,
    encryption: p.encryption || 'none',
    level: 0,
  };
  // flow is only valid with tls/reality and never over ws.
  if (p.flow && t.network !== 'ws' && (t.security === 'tls' || t.security === 'reality')) {
    user.flow = p.flow;
  }

  const network = mapNetwork(t.network);
  const stream: Record<string, unknown> = { network, security: t.security || 'none' };

  if (t.security === 'tls') {
    stream.tlsSettings = {
      serverName: t.sni || p.host,
      fingerprint: t.fingerprint || 'chrome',
      allowInsecure: !!t.allowInsecure,
      ...(t.alpn && t.alpn.length ? { alpn: t.alpn } : {}),
    };
  } else if (t.security === 'reality') {
    stream.realitySettings = {
      serverName: t.sni || '',
      fingerprint: t.fingerprint || 'chrome',
      publicKey: t.publicKey,
      shortId: t.shortId || '',
      spiderX: t.spiderX || '/',
    };
  }

  applyTransport(stream, network, t);

  return {
    tag: 'proxy',
    protocol: 'vless',
    settings: { vnext: [{ address: p.host, port: p.port, users: [user] }] },
    streamSettings: stream,
  };
}

function applyTransport(stream: Record<string, unknown>, network: string, t: import('../uri/types').VlessTransport): void {
  switch (network) {
    case 'ws':
      stream.wsSettings = {
        path: t.path || '/',
        ...(t.host ? { headers: { Host: t.host } } : {}),
      };
      break;
    case 'grpc':
      stream.grpcSettings = {
        serviceName: t.serviceName || '',
        multiMode: t.mode === 'multi',
        ...(t.authority ? { authority: t.authority } : {}),
      };
      break;
    case 'httpupgrade':
      stream.httpupgradeSettings = {
        path: t.path || '/',
        ...(t.host ? { host: t.host } : {}),
      };
      break;
    case 'http':
      stream.httpSettings = {
        path: t.path || '/',
        ...(t.host ? { host: [t.host] } : {}),
      };
      break;
    case 'tcp':
      if (t.headerType === 'http') {
        stream.tcpSettings = {
          header: {
            type: 'http',
            request: {
              path: [t.path || '/'],
              headers: t.host ? { Host: [t.host] } : {},
            },
          },
        };
      }
      break;
    default:
      break;
  }
}

function mapNetwork(n: string): string {
  const v = (n || 'tcp').toLowerCase();
  if (v === 'websocket') {
    return 'ws';
  }
  if (v === 'raw') {
    return 'tcp';
  }
  return v;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
