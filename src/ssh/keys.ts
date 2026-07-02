import * as fs from 'fs';
import { utils } from 'ssh2';

/**
 * Read and validate an OpenSSH/PEM private key file. Returns the raw key bytes to hand to ssh2.
 * CRLF is normalized only for text key formats (never PPK/DER).
 */
export function loadPrivateKey(filePath: string, passphrase?: string): Buffer {
  let raw = fs.readFileSync(filePath);
  const head = raw.subarray(0, 40).toString('ascii');
  if (head.includes('-----BEGIN')) {
    raw = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  }
  const parsed = utils.parseKey(raw, passphrase);
  if (parsed instanceof Error) {
    throw new Error(`Invalid private key (${filePath}): ${parsed.message}`);
  }
  return raw;
}

/** Resolve the SSH agent endpoint (named pipe on Windows, $SSH_AUTH_SOCK elsewhere). */
export function resolveAgentPath(override?: string): string | undefined {
  if (override) {
    return override;
  }
  if (process.platform === 'win32') {
    return process.env.SSH2_AGENT || '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return process.env.SSH_AUTH_SOCK || undefined;
}
