/** Decode a possibly URL-safe, possibly unpadded base64 string into a Buffer. */
export function decodeBase64Tolerant(input: string): Buffer {
  let s = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const rem = s.length % 4;
  if (rem === 2) {
    s += '==';
  } else if (rem === 3) {
    s += '=';
  } else if (rem === 1) {
    throw new Error('Invalid base64 (length % 4 === 1)');
  }
  return Buffer.from(s, 'base64');
}

/** Decode tolerant base64 and interpret the bytes as UTF-8 text. */
export function decodeBase64Utf8(input: string): string {
  return decodeBase64Tolerant(input).toString('utf8');
}

/** Heuristic: does this string look like it is base64 rather than plaintext? */
export function looksLikeBase64(input: string): boolean {
  const s = input.replace(/\s+/g, '');
  if (s.length === 0) {
    return false;
  }
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(s);
}

/** True if a decoded string looks like human-printable text (no control/replacement chars). */
export function isProbablyText(s: string): boolean {
  if (s.length === 0) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd) {
      return false; // U+FFFD replacement char => invalid UTF-8
    }
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      return false; // C0 control char (tab/newline/CR allowed)
    }
  }
  return true;
}
