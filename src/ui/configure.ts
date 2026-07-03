import * as vscode from 'vscode';
import { Secrets } from '../config/secrets';
import { ExecProfile, getClusters, RawClusterConfig, readSettings, resolvedClusterName } from '../config/settings';
import { SshAuthMethod } from '../ssh/connect';

type Item = vscode.QuickPickItem & { id: string };

const NS = 'ultraproxy';

function conf(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(NS);
}
function getVal<T>(key: string, def: T): T {
  return conf().get<T>(key, def);
}
async function setVal(key: string, value: unknown): Promise<void> {
  await conf().update(key, value, vscode.ConfigurationTarget.Global);
}

async function menu(title: string, items: Item[]): Promise<string | undefined> {
  const chosen = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true, matchOnDescription: true });
  return chosen?.id;
}

async function askText(prompt: string, value?: string, opts: { required?: boolean; password?: boolean } = {}): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    password: opts.password,
    ignoreFocusOut: true,
    validateInput: opts.required ? (v) => (v.trim() ? undefined : 'Required') : undefined,
  });
}

async function askNumber(prompt: string, value: number): Promise<number | undefined> {
  const v = await vscode.window.showInputBox({
    prompt,
    value: String(value),
    ignoreFocusOut: true,
    validateInput: (x) => (x.trim() === '' || /^\d+$/.test(x.trim()) ? undefined : 'Must be a whole number'),
  });
  if (v === undefined) {
    return undefined;
  }
  return v.trim() === '' ? 0 : Number.parseInt(v.trim(), 10);
}

/**
 * Ask for an OPTIONAL number: blank clears the field (inherit the global default), a value sets it.
 * Returns undefined on cancel, otherwise { value } where value === undefined means "inherit".
 * Needed for fields like remoteProxyPort where 0 is itself meaningful (auto) and must stay
 * distinguishable from "not set" — an explicit 0 would silently shadow a global fixed port.
 */
async function askOptionalNumber(prompt: string, current: number | undefined): Promise<{ value?: number } | undefined> {
  const v = await vscode.window.showInputBox({
    prompt,
    value: current !== undefined ? String(current) : '',
    ignoreFocusOut: true,
    validateInput: (x) => (x.trim() === '' || /^\d+$/.test(x.trim()) ? undefined : 'Whole number, or blank to inherit'),
  });
  if (v === undefined) {
    return undefined;
  }
  const t = v.trim();
  return { value: t === '' ? undefined : Number.parseInt(t, 10) };
}

/** Menu label for a cluster's remoteProxyPort: inherit (with the resolved global) / auto / fixed. */
function describeRemotePort(v: number | undefined): string {
  if (v === undefined) {
    const g = readSettings().remoteProxyPort;
    return g ? `(inherit: ${g})` : '(inherit: auto)';
  }
  return v === 0 ? '0 (auto — overrides global)' : String(v);
}

async function confirm(message: string): Promise<boolean> {
  const c = await vscode.window.showWarningMessage(message, { modal: true }, 'Yes');
  return c === 'Yes';
}

function onOff(v: boolean): string {
  return v ? 'on' : 'off';
}

/** Button-driven configuration so nothing needs to be edited in settings.json by hand. */
export class ConfigUI {
  constructor(private readonly secrets: Secrets) {}

  async open(): Promise<void> {
    for (;;) {
      const s = readSettings();
      const clusterCount = getClusters(s).length;
      const linkSet = (s.shareLink || (await this.secrets.getShareLink())) ? 'set' : 'not set';
      const id = await menu('UltraProxy — Configure', [
        { label: '$(key) Proxy key (share link)', description: linkSet, id: 'shareLink' },
        { label: '$(server-process) Clusters', description: `${clusterCount} configured`, id: 'clusters' },
        { label: '$(lock) Credentials', description: 'SSH passwords / API keys', id: 'creds' },
        { label: '$(globe) Routing & privacy', description: `strict=${onOff(s.strictWhitelist)}`, id: 'routing' },
        { label: '$(gear) Advanced options', id: 'advanced' },
        { label: '$(rocket) Apply now', id: 'apply' },
        { label: '$(check) Done', id: 'done' },
      ]);
      if (!id || id === 'done') {
        return;
      }
      switch (id) {
        case 'shareLink':
          await this.editShareLink();
          break;
        case 'clusters':
          await this.manageClusters();
          break;
        case 'creds':
          await vscode.commands.executeCommand('ultraproxy.setSecrets');
          break;
        case 'routing':
          await this.routingMenu();
          break;
        case 'advanced':
          await this.advancedMenu();
          break;
        case 'apply':
          await vscode.commands.executeCommand('ultraproxy.apply');
          return;
      }
    }
  }

  // ---- share link ----

  private async editShareLink(): Promise<void> {
    const id = await menu('Proxy key', [
      { label: '$(edit) Enter share link (store in settings)', id: 'settings' },
      { label: '$(lock) Enter share link (store as secret)', id: 'secret' },
      { label: '$(list-selection) Pick server from subscription', id: 'pick' },
      { label: '$(trash) Clear share link', id: 'clear' },
      { label: '$(arrow-left) Back', id: 'back' },
    ]);
    if (!id || id === 'back') {
      return;
    }
    if (id === 'pick') {
      await vscode.commands.executeCommand('ultraproxy.pickServer');
      return;
    }
    if (id === 'clear') {
      await setVal('shareLink', '');
      await this.secrets.setShareLink('');
      vscode.window.showInformationMessage('UltraProxy: cleared share link.');
      return;
    }
    const link = await askText('Proxy share link (ss:// / vless:// / ssconf:// / subscription URL)', getVal('shareLink', ''), {
      password: id === 'secret',
    });
    if (link === undefined) {
      return;
    }
    if (id === 'secret') {
      await this.secrets.setShareLink(link.trim());
      await setVal('shareLink', '');
    } else {
      await setVal('shareLink', link.trim());
    }
    vscode.window.showInformationMessage('UltraProxy: saved share link.');
  }

  // ---- clusters ----

  private async manageClusters(): Promise<void> {
    for (;;) {
      const raw = getVal<RawClusterConfig[]>('clusters', []);
      const items: Item[] = [{ label: '$(add) Add cluster', id: 'add' }];
      raw.forEach((c, i) => {
        items.push({
          label: `$(server) ${resolvedClusterName(raw, i) ?? c.name ?? c.host}`,
          description: `${c.user}@${c.host}:${c.port ?? getVal('sshPort', 22)} · ${c.authMethod ?? 'default'}`,
          id: `edit:${i}`,
        });
      });
      const s = readSettings();
      if (raw.length === 0 && s.sshHost) {
        items.push({ label: `$(server) ${s.sshHost} (flat single-cluster)`, description: 'edit fallback SSH settings', id: 'flat' });
      } else {
        items.push({ label: '$(settings-gear) Flat single-cluster SSH (fallback)', description: 'used only when no clusters above', id: 'flat' });
      }
      items.push({ label: '$(arrow-left) Back', id: 'back' });

      const id = await menu('Clusters', items);
      if (!id || id === 'back') {
        return;
      }
      if (id === 'add') {
        await this.addCluster();
      } else if (id === 'flat') {
        await this.editFlatSsh();
      } else if (id.startsWith('edit:')) {
        await this.editCluster(Number.parseInt(id.slice(5), 10));
      }
    }
  }

  private async addCluster(): Promise<void> {
    const host = await askText('SSH host', '', { required: true });
    if (!host) {
      return;
    }
    const user = await askText('SSH user', '', { required: true });
    if (!user) {
      return;
    }
    const name = await askText('Display name (optional)', host);
    if (name === undefined) {
      return;
    }
    const auth = await this.pickAuth();
    if (auth === undefined) {
      return;
    }
    const entry: RawClusterConfig = { host: host.trim(), user: user.trim() };
    if (name.trim() && name.trim() !== host.trim()) {
      entry.name = name.trim();
    }
    if (auth) {
      entry.authMethod = auth;
    }
    if (auth === 'key') {
      const key = await askText('Private key path', '');
      if (key) {
        entry.privateKeyPath = key.trim();
      }
    }
    const raw = getVal<RawClusterConfig[]>('clusters', []);
    raw.push(entry);
    await setVal('clusters', raw);

    const label = resolvedClusterName(raw, raw.length - 1) ?? entry.name ?? entry.host;
    if (auth === 'password') {
      const pw = await askText(`SSH password for "${label}" (stored securely)`, '', { password: true });
      if (pw) {
        await this.secrets.setSshPassword(label, pw);
      }
    }
    vscode.window.showInformationMessage(`UltraProxy: added cluster "${label}".`);
  }

  private async editCluster(index: number): Promise<void> {
    for (;;) {
      const raw = getVal<RawClusterConfig[]>('clusters', []);
      const c = raw[index];
      if (!c) {
        return;
      }
      const label = resolvedClusterName(raw, index) ?? c.name ?? c.host;
      const id = await menu(`Edit "${label}"`, [
        { label: `Name: ${c.name ?? '(host)'}`, id: 'name' },
        { label: `Host: ${c.host}`, id: 'host' },
        { label: `User: ${c.user}`, id: 'user' },
        { label: `Port: ${c.port ?? '(default)'}`, id: 'port' },
        { label: `Auth method: ${c.authMethod ?? '(default)'}`, id: 'auth' },
        { label: `Private key path: ${c.privateKeyPath ?? '(none)'}`, id: 'key' },
        { label: `SSH agent path: ${c.agentPath ?? '(auto)'}`, id: 'agentpath' },
        { label: `vLLM hosts: ${(c.vllmHost ?? []).join(', ') || '(none)'}`, id: 'vllm' },
        { label: `Remote proxy port: ${describeRemotePort(c.remoteProxyPort)}`, id: 'rport' },
        { label: `Patch Copilot settings: ${c.patchCopilotSettings ?? '(default on)'}`, id: 'patch' },
        { label: `Inject terminal env: ${c.injectTerminalEnv ?? '(default on)'}`, id: 'inject' },
        { label: `Inject server-env: ${c.injectServerEnv ?? '(default)'}`, id: 'serverenv' },
        { label: `Wrap Claude Code: ${c.wrapClaudeCode ?? '(default)'}`, id: 'claudewrap' },
        { label: `ProxyJump (bastion): ${c.proxyJump ?? '(none)'}`, id: 'jump' },
        { label: `Exec profile: ${c.execProfile ?? '(default)'}`, id: 'execprofile' },
        { label: `Docker container: ${c.dockerContainer ?? '(none)'}`, id: 'dockercontainer' },
        { label: `Exec template: ${c.execTemplate ?? '(none)'}`, id: 'exectemplate' },
        { label: '$(key) Set SSH password / passphrase', id: 'secret' },
        { label: '$(trash) Remove this cluster', id: 'remove' },
        { label: '$(arrow-left) Back', id: 'back' },
      ]);
      if (!id || id === 'back') {
        return;
      }
      if (id === 'remove') {
        if (await confirm(`Remove cluster "${label}"?`)) {
          raw.splice(index, 1);
          await setVal('clusters', raw);
          vscode.window.showInformationMessage(`UltraProxy: removed "${label}".`);
          return;
        }
        continue;
      }
      if (id === 'secret') {
        await this.setClusterSecret(label);
        continue;
      }
      const oldName = resolvedClusterName(raw, index);
      const changed = await this.editClusterField(c, id);
      if (changed) {
        await setVal('clusters', raw);
        if (id === 'name' || id === 'host') {
          const newName = resolvedClusterName(raw, index);
          if (oldName && newName && oldName !== newName) {
            await this.secrets.moveClusterSecrets(oldName, newName);
          }
        }
      }
    }
  }

  private async editClusterField(c: RawClusterConfig, field: string): Promise<boolean> {
    switch (field) {
      case 'name': {
        const v = await askText('Display name (blank = use host)', c.name ?? '');
        if (v === undefined) {
          return false;
        }
        c.name = v.trim() || undefined;
        return true;
      }
      case 'host': {
        const v = await askText('SSH host', c.host, { required: true });
        if (!v) {
          return false;
        }
        c.host = v.trim();
        return true;
      }
      case 'user': {
        const v = await askText('SSH user', c.user, { required: true });
        if (!v) {
          return false;
        }
        c.user = v.trim();
        return true;
      }
      case 'port': {
        const v = await askNumber('SSH port (0 = default)', c.port ?? 22);
        if (v === undefined) {
          return false;
        }
        c.port = v || undefined;
        return true;
      }
      case 'auth': {
        const a = await this.pickAuth();
        if (a === undefined) {
          return false;
        }
        c.authMethod = a || undefined;
        return true;
      }
      case 'key': {
        const v = await askText('Private key path (blank = none)', c.privateKeyPath ?? '');
        if (v === undefined) {
          return false;
        }
        c.privateKeyPath = v.trim() || undefined;
        return true;
      }
      case 'agentpath': {
        const v = await askText('SSH agent socket/pipe override (blank = auto)', c.agentPath ?? '');
        if (v === undefined) {
          return false;
        }
        c.agentPath = v.trim() || undefined;
        return true;
      }
      case 'vllm': {
        const v = await askText('vLLM hosts for this cluster (comma-separated)', (c.vllmHost ?? []).join(', '));
        if (v === undefined) {
          return false;
        }
        c.vllmHost = splitList(v);
        return true;
      }
      case 'rport': {
        const g = readSettings().remoteProxyPort;
        const r = await askOptionalNumber(
          `Remote proxy port — fixed number, 0 = auto, blank = inherit global (${g || 'auto'})`,
          c.remoteProxyPort,
        );
        if (r === undefined) {
          return false;
        }
        c.remoteProxyPort = r.value;
        return true;
      }
      case 'patch':
        c.patchCopilotSettings = !(c.patchCopilotSettings ?? true);
        return true;
      case 'inject':
        c.injectTerminalEnv = !(c.injectTerminalEnv ?? true);
        return true;
      case 'serverenv':
        // Cycle default(inherit) -> on -> off -> default so inheritance stays reachable.
        c.injectServerEnv = cycleTri(c.injectServerEnv);
        return true;
      case 'claudewrap':
        c.wrapClaudeCode = cycleTri(c.wrapClaudeCode);
        return true;
      case 'jump': {
        const v = await askText('ProxyJump bastion — [user@]host[:port] (blank = none)', c.proxyJump ?? '');
        if (v === undefined) {
          return false;
        }
        c.proxyJump = v.trim() || undefined;
        return true;
      }
      case 'execprofile': {
        const p = await this.pickExecProfile();
        if (p === undefined || p === '') {
          return false; // cancelled or "keep current" — leave the field untouched
        }
        c.execProfile = p as ExecProfile;
        return true;
      }
      case 'dockercontainer': {
        const v = await askText('Docker container name/ID (used when exec profile is docker)', c.dockerContainer ?? '');
        if (v === undefined) {
          return false;
        }
        c.dockerContainer = v.trim() || undefined;
        return true;
      }
      case 'exectemplate': {
        const v = await askText('Custom exec template with {{CMD}} (e.g. sudo {{CMD}})', c.execTemplate ?? '');
        if (v === undefined) {
          return false;
        }
        c.execTemplate = v.trim() || undefined;
        return true;
      }
      default:
        return false;
    }
  }

  private async pickExecProfile(): Promise<ExecProfile | '' | undefined> {
    const id = await menu('Exec profile', [
      { label: 'direct', description: 'run on the SSH host (default)', id: 'direct' },
      { label: 'docker', description: 'docker exec into a container', id: 'docker' },
      { label: 'custom', description: 'custom {{CMD}} wrapper', id: 'custom' },
      { label: '(keep current / default)', id: '' },
    ]);
    if (id === undefined) {
      return undefined;
    }
    return id as ExecProfile | '';
  }

  private async setClusterSecret(clusterName: string): Promise<void> {
    const which = await menu(`Credentials for "${clusterName}"`, [
      { label: 'SSH password', id: 'pw' },
      { label: 'SSH key passphrase', id: 'pp' },
      { label: '$(arrow-left) Back', id: 'back' },
    ]);
    if (!which || which === 'back') {
      return;
    }
    const value = await askText(which === 'pw' ? 'SSH password' : 'SSH key passphrase', '', { password: true });
    if (value === undefined) {
      return;
    }
    if (which === 'pw') {
      await this.secrets.setSshPassword(clusterName, value);
    } else {
      await this.secrets.setSshKeyPassphrase(clusterName, value);
    }
    vscode.window.showInformationMessage(`UltraProxy: saved credentials for "${clusterName}".`);
  }

  private async editFlatSsh(): Promise<void> {
    for (;;) {
      const s = readSettings();
      const id = await menu('Flat single-cluster SSH', [
        { label: `Host: ${s.sshHost || '(none)'}`, id: 'sshHost' },
        { label: `User: ${s.sshUser || '(none)'}`, id: 'sshUser' },
        { label: `Port: ${s.sshPort}`, id: 'sshPort' },
        { label: `Auth method: ${s.sshAuthMethod}`, id: 'sshAuthMethod' },
        { label: `Private key path: ${s.sshPrivateKeyPath || '(none)'}`, id: 'sshPrivateKeyPath' },
        { label: `SSH agent path: ${s.sshAgentPath || '(auto)'}`, id: 'sshAgentPath' },
        { label: '$(arrow-left) Back', id: 'back' },
      ]);
      if (!id || id === 'back') {
        return;
      }
      if (id === 'sshPort') {
        const v = await askNumber('SSH port', s.sshPort);
        if (v !== undefined) {
          await setVal('sshPort', v || 22);
        }
      } else if (id === 'sshAuthMethod') {
        const a = await this.pickAuth();
        if (a) {
          await setVal('sshAuthMethod', a);
        }
      } else {
        const v = await askText(id, getVal(id, ''));
        if (v !== undefined) {
          await setVal(id, v.trim());
        }
      }
    }
  }

  private async pickAuth(): Promise<SshAuthMethod | '' | undefined> {
    const id = await menu('SSH auth method', [
      { label: 'agent', description: 'SSH agent (default)', id: 'agent' },
      { label: 'key', description: 'private key file', id: 'key' },
      { label: 'password', description: 'password (stored securely)', id: 'password' },
      { label: '(keep current / default)', id: '' },
    ]);
    if (id === undefined) {
      return undefined;
    }
    return id as SshAuthMethod | '';
  }

  // ---- routing & privacy ----

  private async routingMenu(): Promise<void> {
    for (;;) {
      const s = readSettings();
      const id = await menu('Routing & privacy', [
        { label: `$(law) Strict whitelist: ${onOff(s.strictWhitelist)}`, description: 'block non-whitelisted vs. direct', id: 'strict' },
        { label: `$(add) Whitelist extras (${s.whitelistExtras.length})`, description: 'extra domains via the proxy', id: 'whitelistExtras' },
        { label: `$(circle-slash) vLLM / LAN hosts by NAME (${s.vllmHost.length})`, description: 'usually NOT needed — private LAN IPs already bypass; add only hostname-addressed vLLM', id: 'vllmHost' },
        { label: `$(list-unordered) NO_PROXY list (${s.noProxy.length})`, id: 'noProxy' },
        { label: `$(shield) Allow insecure TLS: ${onOff(s.allowInsecureTls)}`, id: 'allowInsecureTls' },
        { label: '$(arrow-left) Back', id: 'back' },
      ]);
      if (!id || id === 'back') {
        return;
      }
      if (id === 'strict') {
        await setVal('strictWhitelist', !s.strictWhitelist);
      } else if (id === 'allowInsecureTls') {
        await setVal('allowInsecureTls', !s.allowInsecureTls);
      } else {
        await this.editList(id, id);
      }
    }
  }

  // ---- advanced ----

  private async advancedMenu(): Promise<void> {
    for (;;) {
      const s = readSettings();
      const id = await menu('Advanced options', [
        { label: `$(rocket) Auto-start on launch: ${onOff(s.autoStart)}`, id: 'autoStart' },
        { label: `$(comment-discussion) Patch Copilot settings (default): ${onOff(s.patchCopilotSettings)}`, id: 'patchCopilotSettings' },
        { label: `$(terminal) Inject terminal env (default): ${onOff(s.injectTerminalEnv)}`, id: 'injectTerminalEnv' },
        { label: `$(server-environment) Inject server-env (default): ${onOff(s.injectServerEnv)}`, description: 'reaches the ext-host process tree; needs Kill VS Code Server', id: 'injectServerEnv' },
        { label: `$(robot) Wrap Claude Code (default): ${onOff(s.wrapClaudeCode)}`, description: 'shim the bundled claude binary', id: 'wrapClaudeCode' },
        { label: `$(git-merge) ProxyJump (default): ${s.sshProxyJump || '(none)'}`, description: 'bastion for the flat single-cluster', id: 'sshProxyJump' },
        { label: `$(vm) Exec profile (default): ${s.execProfile}`, description: 'direct / docker / custom', id: 'execProfile' },
        { label: `$(verified) Allow unverified xray binary: ${onOff(s.allowUnverifiedBinary)}`, id: 'allowUnverifiedBinary' },
        { label: `$(file-binary) Xray path: ${s.xrayPath || '(auto-download)'}`, id: 'xrayPath' },
        { label: `$(tag) Xray version: ${s.xrayVersion}`, id: 'xrayVersion' },
        { label: `$(plug) Test endpoints (${s.testEndpoints.length})`, id: 'testEndpoints' },
        { label: `$(person) Subscription server name: ${s.subscriptionServerName || '(first)'}`, id: 'subscriptionServerName' },
        { label: `$(arrow-swap) Remote proxy port (default): ${s.remoteProxyPort || 'auto'}`, id: 'remoteProxyPort' },
        { label: `$(arrow-swap) Local SOCKS / HTTP port: ${s.localSocksPort || 'auto'} / ${s.localHttpPort || 'auto'}`, id: 'localPorts' },
        { label: '$(arrow-left) Back', id: 'back' },
      ]);
      if (!id || id === 'back') {
        return;
      }
      await this.handleAdvanced(id, s);
    }
  }

  private async handleAdvanced(id: string, s: ReturnType<typeof readSettings>): Promise<void> {
    switch (id) {
      case 'autoStart':
        return setVal('autoStart', !s.autoStart);
      case 'patchCopilotSettings':
        return setVal('patchCopilotSettings', !s.patchCopilotSettings);
      case 'injectTerminalEnv':
        return setVal('injectTerminalEnv', !s.injectTerminalEnv);
      case 'injectServerEnv':
        return setVal('injectServerEnv', !s.injectServerEnv);
      case 'wrapClaudeCode':
        return setVal('wrapClaudeCode', !s.wrapClaudeCode);
      case 'sshProxyJump': {
        const v = await askText('Default ProxyJump bastion — [user@]host[:port] (blank = none)', s.sshProxyJump);
        if (v !== undefined) {
          await setVal('sshProxyJump', v.trim());
        }
        return;
      }
      case 'execProfile': {
        const p = await this.pickExecProfile();
        if (p === undefined || p === '') {
          return;
        }
        // Capture the dependent value BEFORE committing the profile, so cancelling (or leaving it
        // blank) writes nothing and can't leave e.g. execProfile=docker with no container.
        if (p === 'docker') {
          const c = await askText('Docker container name/ID', s.dockerContainer, { required: true });
          if (c === undefined || !c.trim()) {
            return;
          }
          await setVal('dockerContainer', c.trim());
          await setVal('execProfile', 'docker');
        } else if (p === 'custom') {
          const t = await askText('Custom exec template with {{CMD}} (e.g. sudo {{CMD}})', s.execTemplate, { required: true });
          if (t === undefined || !t.trim()) {
            return;
          }
          if (!t.includes('{{CMD}}')) {
            vscode.window.showWarningMessage('UltraProxy: exec template must contain {{CMD}} — not saved.');
            return;
          }
          await setVal('execTemplate', t.trim());
          await setVal('execProfile', 'custom');
        } else {
          await setVal('execProfile', p);
        }
        return;
      }
      case 'allowUnverifiedBinary':
        return setVal('allowUnverifiedBinary', !s.allowUnverifiedBinary);
      case 'testEndpoints':
        return this.editList('testEndpoints', 'testEndpoints');
      case 'xrayPath': {
        const v = await askText('Path to an existing xray binary or v2rayN root (blank = auto-download)', s.xrayPath);
        if (v !== undefined) {
          await setVal('xrayPath', v.trim());
        }
        return;
      }
      case 'xrayVersion': {
        const v = await askText('Pinned Xray release tag', s.xrayVersion);
        if (v !== undefined && v.trim()) {
          await setVal('xrayVersion', v.trim());
        }
        return;
      }
      case 'subscriptionServerName': {
        const v = await askText('Server remark/id to pick from a subscription (blank = first)', s.subscriptionServerName);
        if (v !== undefined) {
          await setVal('subscriptionServerName', v.trim());
        }
        return;
      }
      case 'remoteProxyPort': {
        const v = await askNumber('Default remote proxy port (0 = auto)', s.remoteProxyPort);
        if (v !== undefined) {
          await setVal('remoteProxyPort', v);
        }
        return;
      }
      case 'localPorts': {
        const socks = await askNumber('Local SOCKS port (0 = auto)', s.localSocksPort);
        if (socks === undefined) {
          return;
        }
        await setVal('localSocksPort', socks);
        const http = await askNumber('Local HTTP port (0 = auto)', s.localHttpPort);
        if (http === undefined) {
          return;
        }
        await setVal('localHttpPort', http);
        return;
      }
    }
  }

  // ---- shared string-list editor ----

  private async editList(key: string, label: string): Promise<void> {
    for (;;) {
      const list = getVal<string[]>(key, []);
      const items: Item[] = [{ label: '$(add) Add item', id: 'add' }];
      list.forEach((v, i) => items.push({ label: v, description: 'select to remove', id: `rm:${i}` }));
      items.push({ label: '$(arrow-left) Back', id: 'back' });
      const id = await menu(label, items);
      if (!id || id === 'back') {
        return;
      }
      if (id === 'add') {
        const v = await askText(`Add to ${label}`, '');
        if (v && v.trim()) {
          list.push(v.trim());
          await setVal(key, list);
        }
      } else if (id.startsWith('rm:')) {
        list.splice(Number.parseInt(id.slice(3), 10), 1);
        await setVal(key, list);
      }
    }
  }
}

function splitList(v: string): string[] {
  return v
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Cycle an optional per-cluster boolean: undefined (inherit default) -> true -> false -> undefined. */
function cycleTri(v: boolean | undefined): boolean | undefined {
  return v === undefined ? true : v === true ? false : undefined;
}
