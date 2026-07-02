import * as vscode from 'vscode';

/**
 * Thin wrapper over an OutputChannel that redacts secrets before they hit the log.
 * Register secrets to redact via `addSecret` (passwords, passphrases, proxy creds).
 */
export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly secrets = new Set<string>();

  constructor(name = 'UltraProxy') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  addSecret(value: string | undefined): void {
    // Register any non-empty secret (short passwords/passphrases must still be redacted).
    if (value) {
      this.secrets.add(value);
    }
  }

  private redact(msg: string): string {
    let out = msg;
    for (const s of this.secrets) {
      out = out.split(s).join('***');
    }
    // Inline URL credentials (user:pass@host).
    out = out.replace(/(:\/\/)[^@/\s]+@/g, '$1***@');
    // Credential-bearing query params (token/key/password/secret/passwd) in any URL form.
    out = out.replace(/([?&](?:token|key|password|passwd|secret|access[_-]?key)=)[^&\s]+/gi, '$1***');
    return out;
  }

  private stamp(level: string, msg: string): string {
    return `[${level}] ${this.redact(msg)}`;
  }

  info(msg: string): void {
    this.channel.appendLine(this.stamp('info', msg));
  }

  warn(msg: string): void {
    this.channel.appendLine(this.stamp('warn', msg));
  }

  error(msg: string, err?: unknown): void {
    let full = msg;
    if (err instanceof Error) {
      full += `: ${err.message}`;
    } else if (err !== undefined) {
      full += `: ${String(err)}`;
    }
    this.channel.appendLine(this.stamp('error', full));
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
