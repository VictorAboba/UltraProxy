export type ProxyKind = 'shadowsocks' | 'vless';

export interface ShadowsocksProfile {
  kind: 'shadowsocks';
  host: string;
  port: number;
  method: string;
  password: string;
  tag?: string;
  /** SIP003 plugin name, if present (e.g. obfs-local). Xray-core cannot run most plugins natively. */
  plugin?: string;
  pluginOpts?: string;
}

export interface VlessTransport {
  /** Xray streamSettings.network: tcp | ws | grpc | http | httpupgrade | xhttp | kcp | quic */
  network: string;
  /** Xray streamSettings.security: none | tls | reality */
  security: string;
  sni?: string;
  fingerprint?: string;
  alpn?: string[];
  allowInsecure?: boolean;
  /** REALITY public key (share-link param `pbk`). */
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
  path?: string;
  host?: string;
  serviceName?: string;
  mode?: string;
  headerType?: string;
  seed?: string;
  authority?: string;
}

export interface VlessProfile {
  kind: 'vless';
  host: string;
  port: number;
  uuid: string;
  encryption: string; // must be 'none'
  flow?: string;
  transport: VlessTransport;
  tag?: string;
}

export type ProxyProfile = ShadowsocksProfile | VlessProfile;

/** SIP008 online-config server entry. */
export interface Sip008Server {
  id?: string;
  remarks?: string;
  server: string;
  server_port: number;
  password: string;
  method: string;
  plugin?: string;
  plugin_opts?: string;
}

export function describeProfile(p: ProxyProfile): string {
  if (p.kind === 'shadowsocks') {
    return `shadowsocks ${p.method} @ ${p.host}:${p.port}${p.tag ? ` (${p.tag})` : ''}`;
  }
  return `vless ${p.transport.network}/${p.transport.security} @ ${p.host}:${p.port}${p.tag ? ` (${p.tag})` : ''}`;
}
