import { httpGet } from '../util/http';
import { decodeBase64Tolerant } from './base64';

/**
 * Fetch a subscription URL and return the individual share links it contains.
 * Subscriptions are typically base64 of a newline-separated list of ss://.../vless://... links.
 */
export async function fetchSubscriptionLinks(url: string): Promise<string[]> {
  const body = await httpGet(url);
  return decodeSubscription(body.toString('utf8'));
}

export function decodeSubscription(raw: string): string[] {
  let text = raw;
  if (!text.includes('://')) {
    try {
      text = decodeBase64Tolerant(text).toString('utf8');
    } catch {
      /* keep original */
    }
  }
  return text
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && l.includes('://'));
}
