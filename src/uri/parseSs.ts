import { decodeBase64Tolerant, isProbablyText } from './base64';
import { safeDecodeURIComponent, splitHostPort } from './hostport';
import { ShadowsocksProfile } from './types';

/**
 * Parse an ss:// share link (SIP002 form A/B + legacy base64 form).
 *   SIP002:  ss://base64(method:password)@host:port[/?plugin=...]#tag   (form A)
 *            ss://method:password@host:port[/?plugin=...]#tag           (form B, 2022 ciphers)
 *   legacy:  ss://base64(method:password@host:port)#tag
 */
export function parseSs(uri: string): ShadowsocksProfile {
  if (!uri.startsWith('ss://')) {
    throw new Error('Not an ss:// link');
  }
  let body = uri.slice('ss://'.length);

  // 1. fragment (#tag)
  let tag: string | undefined;
  const hashIdx = body.indexOf('#');
  if (hashIdx >= 0) {
    tag = safeDecodeURIComponent(body.slice(hashIdx + 1));
    body = body.slice(0, hashIdx);
  }

  // 2. query (?plugin=...)
  let plugin: string | undefined;
  let pluginOpts: string | undefined;
  const qIdx = body.indexOf('?');
  if (qIdx >= 0) {
    const params = new URLSearchParams(body.slice(qIdx + 1));
    body = body.slice(0, qIdx);
    const pluginRaw = params.get('plugin');
    if (pluginRaw) {
      const semi = pluginRaw.indexOf(';');
      if (semi >= 0) {
        plugin = pluginRaw.slice(0, semi);
        pluginOpts = pluginRaw.slice(semi + 1);
      } else {
        plugin = pluginRaw;
      }
    }
  }

  let method: string;
  let password: string;
  let host: string;
  let port: number;

  if (body.includes('@')) {
    // SIP002
    const at = body.lastIndexOf('@');
    const userinfoRaw = body.slice(0, at);
    ({ host, port } = splitHostPort(body.slice(at + 1)));
    ({ method, password } = splitCreds(decodeUserinfo(userinfoRaw)));
  } else {
    // legacy base64 of the whole "method:password@host:port"
    const decoded = decodeBase64Tolerant(body).toString('utf8');
    const at = decoded.lastIndexOf('@');
    if (at < 0) {
      throw new Error('Malformed legacy ss:// link (no @ after base64 decode)');
    }
    ({ host, port } = splitHostPort(decoded.slice(at + 1)));
    ({ method, password } = splitCreds(decoded.slice(0, at)));
  }

  if (!method || !password) {
    throw new Error('ss:// link missing method or password');
  }
  return { kind: 'shadowsocks', host, port, method, password, tag, plugin, pluginOpts };
}

function decodeUserinfo(raw: string): string {
  // Form A: userinfo is base64(method:password). Form B: percent-encoded method:password.
  try {
    const decoded = decodeBase64Tolerant(raw).toString('utf8');
    if (decoded.includes(':') && isProbablyText(decoded) && /^[\w.+-]+:/.test(decoded)) {
      return decoded;
    }
  } catch {
    /* not base64; fall through to percent-decode */
  }
  return safeDecodeURIComponent(raw);
}

function splitCreds(creds: string): { method: string; password: string } {
  const idx = creds.indexOf(':');
  if (idx < 0) {
    throw new Error('Malformed ss credentials (expected method:password)');
  }
  return { method: creds.slice(0, idx), password: creds.slice(idx + 1) };
}
