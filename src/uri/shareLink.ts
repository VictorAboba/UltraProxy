import { decodeBase64Tolerant } from './base64';
import { parseSs } from './parseSs';
import { parseSsconf } from './parseSsconf';
import { decodeSubscription, fetchSubscriptionLinks } from './parseSubscription';
import { parseVless } from './parseVless';
import { ProxyProfile } from './types';

export interface ResolveOptions {
  /** Server remark/id to pick from a SIP008 config or subscription (empty = first supported). */
  serverName?: string;
}

/** True if the string is a single, directly-parseable link (not a subscription/http). */
function isDirectLink(s: string): boolean {
  return s.startsWith('ss://') || s.startsWith('vless://') || s.startsWith('ssconf://');
}

/**
 * Turn any supported share link into a concrete ProxyProfile.
 * Supports ss://, vless://, ssconf:// (SIP008), http(s):// subscription, and bare base64 subscription blobs.
 */
export async function resolveShareLink(link: string, opts: ResolveOptions = {}): Promise<ProxyProfile> {
  const s = link.trim();
  if (!s) {
    throw new Error('Empty share link');
  }

  if (s.startsWith('ss://')) {
    return parseSs(s);
  }
  if (s.startsWith('vless://')) {
    return parseVless(s);
  }
  if (s.startsWith('ssconf://')) {
    return parseSsconf(s, opts.serverName);
  }
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const links = await fetchSubscriptionLinks(s);
    return pickFromList(links, opts);
  }

  // Possibly a raw base64 subscription blob pasted directly.
  try {
    const decoded = decodeBase64Tolerant(s).toString('utf8');
    if (decoded.includes('://')) {
      return pickFromList(decodeSubscription(decoded), opts);
    }
  } catch {
    /* not base64 */
  }

  throw new Error('Unrecognized share link (expected ss:// / vless:// / ssconf:// / subscription URL)');
}

async function pickFromList(links: string[], opts: ResolveOptions): Promise<ProxyProfile> {
  const usable = links.filter(isDirectLink);
  if (usable.length === 0) {
    throw new Error('Subscription contained no supported (ss/vless) links');
  }
  let chosen = usable[0];
  if (opts.serverName) {
    const enc = encodeURIComponent(opts.serverName);
    const match = usable.find((l) => {
      const hash = l.indexOf('#');
      if (hash < 0) {
        return false;
      }
      const tag = l.slice(hash + 1);
      return tag === opts.serverName || tag === enc || decodeURIComponentSafe(tag) === opts.serverName;
    });
    if (match) {
      chosen = match;
    }
  }
  // serverName no longer needed once a specific link is chosen.
  return resolveShareLink(chosen);
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
