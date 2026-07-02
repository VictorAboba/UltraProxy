import * as vscode from 'vscode';
import { Secrets } from './config/secrets';
import { readSettings } from './config/settings';
import { Orchestrator } from './orchestrator';
import { Logger } from './util/logger';
import { ConfigUI } from './ui/configure';
import { inputSecret, pick, QuickItem } from './ui/prompts';
import { StatusBar } from './ui/statusBar';
import { fetchSsconfServers } from './uri/parseSsconf';
import { fetchSubscriptionLinks } from './uri/parseSubscription';

let logger: Logger;
let statusBar: StatusBar;
let orchestrator: Orchestrator;

export function activate(context: vscode.ExtensionContext): void {
  logger = new Logger();
  statusBar = new StatusBar();
  const secrets = new Secrets(context.secrets);
  orchestrator = new Orchestrator(context, logger, secrets, statusBar);
  const configUI = new ConfigUI(secrets);

  context.subscriptions.push(
    logger,
    statusBar,
    { dispose: () => orchestrator.dispose() },
    vscode.commands.registerCommand('ultraproxy.configure', () => configUI.open()),
    vscode.commands.registerCommand('ultraproxy.apply', () => applyCmd()),
    vscode.commands.registerCommand('ultraproxy.remove', () => removeCmd()),
    vscode.commands.registerCommand('ultraproxy.restart', () => restartCmd()),
    vscode.commands.registerCommand('ultraproxy.setSecrets', () => setSecrets(secrets)),
    vscode.commands.registerCommand('ultraproxy.pickServer', () => pickServer()),
    vscode.commands.registerCommand('ultraproxy.testConnection', () => testCmd()),
    vscode.commands.registerCommand('ultraproxy.showLog', () => logger.show()),
    vscode.commands.registerCommand('ultraproxy.status', () => showStatus()),
  );

  logger.info(`UltraProxy activated (remote: ${vscode.env.remoteName ?? 'none'}).`);

  const s = readSettings();
  if (s.autoStart) {
    if (orchestrator.clusters().length > 0) {
      run(() => orchestrator.applyAll());
    } else {
      logger.warn('autoStart enabled but no clusters are configured.');
    }
  }
}

export function deactivate(): Thenable<void> | void {
  return orchestrator ? orchestrator.dispose() : undefined;
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logger.error('Command failed', e);
  }
}

type Target = { all: true } | { name: string };

async function chooseTarget(
  candidates: string[],
  allLabel: string,
  describe?: (name: string) => string,
): Promise<Target | undefined> {
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return { name: candidates[0] };
  }
  const items: QuickItem<string>[] = [
    { label: `$(list-flat) ${allLabel}`, value: '__all__' },
    ...candidates.map((n) => ({ label: n, description: describe?.(n), value: n })),
  ];
  const chosen = await pick(items, 'Select a cluster');
  if (chosen === undefined) {
    return undefined;
  }
  return chosen === '__all__' ? { all: true } : { name: chosen };
}

async function applyCmd(): Promise<void> {
  const names = orchestrator.clusters().map((c) => c.name);
  if (names.length === 0) {
    vscode.window.showWarningMessage('UltraProxy: configure ultraproxy.clusters (or the SSH host/user) first.');
    return;
  }
  const t = await chooseTarget(names, 'Apply ALL clusters', (n) => orchestrator.sessionStateOf(n));
  if (!t) {
    return;
  }
  return 'all' in t ? run(() => orchestrator.applyAll()) : run(() => orchestrator.applyCluster(t.name));
}

async function removeCmd(): Promise<void> {
  const names = orchestrator.activeSessionNames();
  if (names.length === 0) {
    vscode.window.showInformationMessage('UltraProxy: no active clusters to remove.');
    return;
  }
  const t = await chooseTarget(names, 'Remove ALL clusters');
  if (!t) {
    return;
  }
  return 'all' in t ? run(() => orchestrator.removeAll()) : run(() => orchestrator.removeCluster(t.name));
}

async function restartCmd(): Promise<void> {
  const names = orchestrator.clusters().map((c) => c.name);
  if (names.length === 0) {
    vscode.window.showWarningMessage('UltraProxy: no clusters configured.');
    return;
  }
  const t = await chooseTarget(names, 'Restart ALL clusters', (n) => orchestrator.sessionStateOf(n));
  if (!t) {
    return;
  }
  if ('all' in t) {
    return run(async () => {
      await orchestrator.removeAll();
      await orchestrator.applyAll();
    });
  }
  return run(() => orchestrator.restartCluster(t.name));
}

async function testCmd(): Promise<void> {
  const names = orchestrator.activeSessionNames();
  if (names.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      'UltraProxy is not active. Apply a cluster first, then test.',
      'Apply',
    );
    if (choice === 'Apply') {
      await applyCmd();
    }
    return;
  }
  const t = await chooseTarget(names, 'Test ALL active clusters');
  if (!t) {
    return;
  }
  const targets = 'all' in t ? names : [t.name];
  try {
    const { okPaths, totalPaths } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'UltraProxy: testing connection…' },
      async () => {
        let okPaths = 0;
        let totalPaths = 0;
        for (const name of targets) {
          try {
            const results = await orchestrator.testCluster(name);
            for (const r of results) {
              totalPaths++;
              if (r.remote.ok) {
                okPaths++;
              }
            }
          } catch (e) {
            // A cluster that went inactive mid-test shouldn't abort the others.
            logger.warn(`Test skipped for "${name}": ${(e as Error).message}`);
          }
        }
        return { okPaths, totalPaths };
      },
    );
    const msg = `UltraProxy: ${okPaths}/${totalPaths} provider paths reachable across ${targets.length} cluster(s). See log for details.`;
    const show = (c?: string) => {
      if (c === 'Show Log') {
        logger.show();
      }
    };
    if (okPaths === totalPaths) {
      vscode.window.showInformationMessage(msg, 'Show Log').then(show);
    } else {
      vscode.window.showWarningMessage(msg, 'Show Log').then(show);
    }
  } catch (e) {
    logger.error('Connection test failed', e);
    vscode.window.showErrorMessage(`UltraProxy: ${(e as Error).message}`);
  }
}

type SecretKind = 'password' | 'passphrase' | 'shareLink' | 'anthropicKey' | 'openaiKey' | 'clear';

async function setSecrets(secrets: Secrets): Promise<void> {
  const what = await pick<SecretKind>(
    [
      { label: 'SSH password', description: 'Per-cluster; stored securely', value: 'password' },
      { label: 'SSH key passphrase', description: 'Per-cluster; for an encrypted private key', value: 'passphrase' },
      { label: 'Proxy share link (secret)', description: 'ss:// / vless:// / ssconf:// / subscription', value: 'shareLink' },
      { label: 'Anthropic API key', description: 'Optional — only used locally by Test Connection', value: 'anthropicKey' },
      { label: 'OpenAI API key', description: 'Optional — only used locally by Test Connection', value: 'openaiKey' },
      { label: 'Clear all stored secrets', description: 'Password(s), passphrase(s), share link, API keys', value: 'clear' },
    ],
    'What do you want to set?',
  );
  if (!what) {
    return;
  }
  if (what === 'clear') {
    await secrets.clearAll(orchestrator.clusters().map((c) => c.name));
    vscode.window.showInformationMessage('UltraProxy: cleared stored secrets.');
    return;
  }

  if (what === 'password' || what === 'passphrase') {
    const clusters = orchestrator.clusters();
    if (clusters.length === 0) {
      vscode.window.showWarningMessage(
        'UltraProxy: configure a cluster (ultraproxy.clusters, or the SSH host/user) before setting its password.',
      );
      return;
    }
    let cluster = clusters[0].name;
    if (clusters.length > 1) {
      const chosen = await pick(clusters.map((c) => ({ label: c.name, description: c.host, value: c.name })), 'Which cluster?');
      if (chosen === undefined) {
        return;
      }
      cluster = chosen;
    }
    const label = what === 'password' ? 'SSH password' : 'SSH key passphrase';
    const value = await inputSecret(`${label} for "${cluster}"`);
    if (value === undefined) {
      return;
    }
    if (what === 'password') {
      await secrets.setSshPassword(cluster, value);
    } else {
      await secrets.setSshKeyPassphrase(cluster, value);
    }
    vscode.window.showInformationMessage(`UltraProxy: saved ${label} for "${cluster}".`);
    return;
  }

  const labels: Record<'shareLink' | 'anthropicKey' | 'openaiKey', string> = {
    shareLink: 'Proxy share link',
    anthropicKey: 'Anthropic API key',
    openaiKey: 'OpenAI API key',
  };
  const value = await inputSecret(labels[what]);
  if (value === undefined) {
    return;
  }
  if (what === 'shareLink') {
    await secrets.setShareLink(value);
  } else if (what === 'anthropicKey') {
    await secrets.setAnthropicKey(value);
  } else {
    await secrets.setOpenAIKey(value);
  }
  vscode.window.showInformationMessage(`UltraProxy: saved ${labels[what]}.`);
}

async function pickServer(): Promise<void> {
  const s = readSettings();
  const link = (s.shareLink || '').trim();
  if (!link) {
    vscode.window.showWarningMessage('Set ultraproxy.shareLink to an ssconf/subscription first.');
    return;
  }
  try {
    let items: QuickItem<string>[] = [];
    if (link.startsWith('ssconf://')) {
      const servers = await fetchSsconfServers(link);
      items = servers.map((srv, i) => ({
        label: srv.remarks || srv.id || `server ${i + 1}`,
        description: `${srv.server}:${srv.server_port} (${srv.method})`,
        value: srv.remarks || srv.id || '',
      }));
    } else if (link.startsWith('http://') || link.startsWith('https://')) {
      const links = await fetchSubscriptionLinks(link);
      items = links.map((l, i) => {
        const hash = l.indexOf('#');
        const tag = hash >= 0 ? safeDecode(l.slice(hash + 1)) : `server ${i + 1}`;
        return { label: tag, description: l.slice(0, Math.min(l.length, 48)) + '...', value: tag };
      });
    } else {
      vscode.window.showInformationMessage('The current share link is a single server; nothing to pick.');
      return;
    }
    if (items.length === 0) {
      vscode.window.showWarningMessage('No servers found in the subscription/config.');
      return;
    }
    const chosen = await pick(items, 'Pick a server (stored as subscriptionServerName)');
    if (chosen === undefined) {
      return;
    }
    await vscode.workspace
      .getConfiguration('ultraproxy')
      .update('subscriptionServerName', chosen, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`UltraProxy: selected server "${chosen}". Restart to use it.`);
  } catch (e) {
    logger.error('pickServer failed', e);
    vscode.window.showErrorMessage(`UltraProxy: ${(e as Error).message}`);
  }
}

async function showStatus(): Promise<void> {
  const action = await pick<'apply' | 'remove' | 'restart' | 'test' | 'configure' | 'log' | 'secrets'>(
    [
      { label: '$(play) Apply proxy (cluster / all)', value: 'apply' },
      { label: '$(debug-stop) Remove proxy (cluster / all)', value: 'remove' },
      { label: '$(plug) Test connection', description: 'Reachability + list models', value: 'test' },
      { label: '$(refresh) Restart', value: 'restart' },
      { label: '$(gear) Configure (all settings)', value: 'configure' },
      { label: '$(output) Show log', value: 'log' },
      { label: '$(key) Set credentials', value: 'secrets' },
    ],
    orchestrator.describeStatus().replace(/\n/g, '  •  ') || 'UltraProxy',
  );
  switch (action) {
    case 'apply':
      return applyCmd();
    case 'remove':
      return removeCmd();
    case 'restart':
      return restartCmd();
    case 'test':
      return testCmd();
    case 'configure':
      await vscode.commands.executeCommand('ultraproxy.configure');
      return;
    case 'log':
      return logger.show();
    case 'secrets':
      await vscode.commands.executeCommand('ultraproxy.setSecrets');
      return;
    default:
      return;
  }
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
