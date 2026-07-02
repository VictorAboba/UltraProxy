import { safeDecodeURIComponent, splitHostPort } from './hostport';
import { VlessProfile, VlessTransport } from './types';

/**
 * Parse a vless:// share link: vless://uuid@host:port?<params>#tag
 * The authority is parsed manually (WHATWG URL mishandles non-special schemes on
 * some runtimes); only the query is handed to URLSearchParams.
 */
export function parseVless(uri: string): VlessProfile {
  if (!uri.startsWith('vless://')) {
    throw new Error('Not a vless:// link');
  }
  let rest = uri.slice('vless://'.length);

  let tag: string | undefined;
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) {
    tag = safeDecodeURIComponent(rest.slice(hashIdx + 1));
    rest = rest.slice(0, hashIdx);
  }

  let query = '';
  const qIdx = rest.indexOf('?');
  if (qIdx >= 0) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  // strip any path segment
  const slashIdx = rest.indexOf('/');
  if (slashIdx >= 0) {
    rest = rest.slice(0, slashIdx);
  }

  const at = rest.lastIndexOf('@');
  if (at < 0) {
    throw new Error('vless: missing uuid@host');
  }
  const uuid = safeDecodeURIComponent(rest.slice(0, at));
  if (!uuid) {
    throw new Error('vless: missing uuid');
  }
  const { host, port } = splitHostPort(rest.slice(at + 1));

  const p = new URLSearchParams(query);
  const get = (k: string): string | undefined => {
    const v = p.get(k);
    return v === null || v === '' ? undefined : v;
  };

  const network = (get('type') || 'tcp').toLowerCase();
  const security = (get('security') || 'none').toLowerCase();
  const encryption = get('encryption') || 'none';

  let flow = get('flow');
  if (network === 'ws') {
    flow = undefined; // xtls-rprx-vision flow is invalid over websocket
  }

  const alpnRaw = get('alpn');
  const transport: VlessTransport = {
    network,
    security,
    sni: get('sni'),
    fingerprint: get('fp'),
    alpn: alpnRaw ? alpnRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    allowInsecure: get('allowInsecure') === '1',
    publicKey: get('pbk'),
    shortId: get('sid'),
    spiderX: get('spx'),
    path: get('path'),
    host: get('host'),
    serviceName: get('serviceName') || get('path'),
    mode: get('mode'),
    headerType: get('headerType'),
    seed: get('seed'),
    authority: get('authority'),
  };

  if (security === 'reality') {
    if (!transport.publicKey) {
      throw new Error('vless reality: missing pbk (public key)');
    }
    // REALITY needs a real fronting SNI; the proxy host is not a valid fallback, so require it.
    if (!transport.sni) {
      throw new Error('vless reality: missing sni (server name to front)');
    }
  }

  return { kind: 'vless', host, port, uuid, encryption, flow, transport, tag };
}
