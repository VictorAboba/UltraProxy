import { Client } from 'ssh2';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string;
}

/** Run a remote command and collect its output. Resolves on stream close. */
export function exec(client: Client, cmd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) {
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      stream.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      stream.on('close', (code: number | null, signal?: string) => {
        resolve({ stdout, stderr, code, signal });
      });
      stream.on('error', reject);
    });
  });
}

/** Run a command and throw if it exits non-zero. Returns stdout. */
export async function execChecked(client: Client, cmd: string): Promise<string> {
  const r = await exec(client, cmd);
  if (r.code !== 0) {
    throw new Error(`Remote command failed (code=${r.code}): ${cmd}\n${r.stderr || r.stdout}`.trim());
  }
  return r.stdout;
}
