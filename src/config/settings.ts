import * as vscode from 'vscode';
import { SshAuthMethod } from '../ssh/connect';

export interface UltraProxySettings {
  shareLink: string;
  subscriptionServerName: string;
  whitelistExtras: string[];
  vllmHost: string[];
  noProxy: string[];
  strictWhitelist: boolean;
  allowInsecureTls: boolean;
  allowUnverifiedBinary: boolean;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  sshAuthMethod: SshAuthMethod;
  sshPrivateKeyPath: string;
  sshAgentPath: string;
  remoteProxyPort: number;
  localSocksPort: number;
  localHttpPort: number;
  xrayPath: string;
  xrayVersion: string;
  patchCopilotSettings: boolean;
  injectTerminalEnv: boolean;
  autoStart: boolean;
  testEndpoints: string[];
  clusters: RawClusterConfig[];
}

/** A cluster entry as authored in settings.json (fields fall back to the flat top-level settings). */
export interface RawClusterConfig {
  name?: string;
  host: string;
  user: string;
  port?: number;
  authMethod?: SshAuthMethod;
  privateKeyPath?: string;
  agentPath?: string;
  remoteProxyPort?: number;
  vllmHost?: string[];
  patchCopilotSettings?: boolean;
  injectTerminalEnv?: boolean;
}

/** A fully-resolved cluster (all defaults applied). */
export interface ClusterConfig {
  name: string;
  host: string;
  user: string;
  port: number;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  agentPath?: string;
  remoteProxyPort: number;
  vllmHost: string[];
  patchCopilotSettings: boolean;
  injectTerminalEnv: boolean;
}

/**
 * Hosts kept OFF the proxy so the cluster uses its own internet for them (localhost, private
 * networks, and the heavy package/registry hosts a cluster normally reaches directly).
 */
const DEFAULT_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  // Common package/registry hosts — keep big downloads on the cluster's own link.
  'pypi.org',
  '.pythonhosted.org',
  'huggingface.co',
  '.hf.co',
  'cdn-lfs.huggingface.co',
  'conda.anaconda.org',
  '.anaconda.com',
  'registry-1.docker.io',
  '.docker.io',
];

export function readSettings(): UltraProxySettings {
  const c = vscode.workspace.getConfiguration('ultraproxy');
  return {
    shareLink: c.get('shareLink', ''),
    subscriptionServerName: c.get('subscriptionServerName', ''),
    whitelistExtras: c.get('whitelistExtras', []),
    vllmHost: c.get('vllmHost', []),
    noProxy: c.get('noProxy', DEFAULT_NO_PROXY),
    strictWhitelist: c.get('strictWhitelist', false),
    allowInsecureTls: c.get('allowInsecureTls', false),
    allowUnverifiedBinary: c.get('allowUnverifiedBinary', false),
    sshHost: c.get('sshHost', ''),
    sshUser: c.get('sshUser', ''),
    sshPort: c.get('sshPort', 22),
    sshAuthMethod: c.get('sshAuthMethod', 'agent') as SshAuthMethod,
    sshPrivateKeyPath: c.get('sshPrivateKeyPath', ''),
    sshAgentPath: c.get('sshAgentPath', ''),
    remoteProxyPort: c.get('remoteProxyPort', 0),
    localSocksPort: c.get('localSocksPort', 0),
    localHttpPort: c.get('localHttpPort', 0),
    xrayPath: c.get('xrayPath', ''),
    xrayVersion: c.get('xrayVersion', 'v26.3.27'),
    patchCopilotSettings: c.get('patchCopilotSettings', true),
    injectTerminalEnv: c.get('injectTerminalEnv', true),
    autoStart: c.get('autoStart', false),
    testEndpoints: c.get('testEndpoints', []),
    clusters: c.get('clusters', []),
  };
}

/**
 * The runtime name (trimmed + de-duplicated) that getClusters() assigns to the raw cluster at
 * `rawIndex`. Used by the config UI to key per-cluster secrets under the SAME name the runtime reads.
 */
export function resolvedClusterName(raw: RawClusterConfig[], rawIndex: number): string | undefined {
  const used = new Set<string>();
  let k = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!c || !c.host || !c.user) {
      continue;
    }
    const name = uniqueName((c.name || c.host || `cluster-${k + 1}`).trim(), used);
    if (i === rawIndex) {
      return name;
    }
    k++;
  }
  return undefined;
}

/** Ensure each cluster name is unique so it maps to its own session + secret key. */
function uniqueName(base: string, used: Set<string>): string {
  let name = base || 'cluster';
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n++}`;
  }
  used.add(name);
  return name;
}

/**
 * The list of clusters to manage. Uses `ultraproxy.clusters` when set; otherwise falls back to the
 * flat single-cluster settings (backward compatible). Each field defaults from the flat settings.
 */
export function getClusters(s: UltraProxySettings): ClusterConfig[] {
  if (s.clusters && s.clusters.length) {
    const used = new Set<string>();
    return s.clusters
      .filter((c) => c && c.host && c.user)
      .map((c, i) => ({
        name: uniqueName((c.name || c.host || `cluster-${i + 1}`).trim(), used),
        host: c.host,
        user: c.user,
        port: c.port ?? s.sshPort,
        authMethod: c.authMethod ?? s.sshAuthMethod,
        privateKeyPath: c.privateKeyPath ?? (s.sshPrivateKeyPath || undefined),
        agentPath: c.agentPath ?? (s.sshAgentPath || undefined),
        remoteProxyPort: c.remoteProxyPort ?? s.remoteProxyPort,
        vllmHost: c.vllmHost ?? [],
        patchCopilotSettings: c.patchCopilotSettings ?? s.patchCopilotSettings,
        injectTerminalEnv: c.injectTerminalEnv ?? s.injectTerminalEnv,
      }));
  }
  if (s.sshHost && s.sshUser) {
    return [
      {
        name: s.sshHost,
        host: s.sshHost,
        user: s.sshUser,
        port: s.sshPort,
        authMethod: s.sshAuthMethod,
        privateKeyPath: s.sshPrivateKeyPath || undefined,
        agentPath: s.sshAgentPath || undefined,
        remoteProxyPort: s.remoteProxyPort,
        vllmHost: [],
        patchCopilotSettings: s.patchCopilotSettings,
        injectTerminalEnv: s.injectTerminalEnv,
      },
    ];
  }
  return [];
}

/** Extract clean hostname(s) from a user-entered value that may include a scheme, path, or port. */
export function cleanHost(raw: string): string | undefined {
  let h = raw.trim();
  if (!h) {
    return undefined;
  }
  const scheme = h.indexOf('://');
  if (scheme >= 0) {
    h = h.slice(scheme + 3);
  }
  const slash = h.indexOf('/');
  if (slash >= 0) {
    h = h.slice(0, slash);
  }
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return close >= 0 ? h.slice(1, close) : h.slice(1);
  }
  // A single colon means host:port; strip the port. Multiple colons = bare IPv6 (keep as-is).
  const colons = (h.match(/:/g) || []).length;
  if (colons === 1) {
    h = h.slice(0, h.indexOf(':'));
  }
  return h || undefined;
}

function isIpLiteral(h: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');
}

/** Merge a base NO_PROXY list with vLLM hosts (sanitized: scheme/port stripped; with `.host` suffix). */
export function resolveNoProxyList(baseNoProxy: string[], vllmHosts: string[]): string[] {
  const set = new Set<string>(baseNoProxy);
  for (const raw of vllmHosts) {
    const host = cleanHost(raw);
    if (!host) {
      continue;
    }
    set.add(host);
    if (!isIpLiteral(host) && !host.startsWith('.')) {
      set.add(`.${host}`); // NO_PROXY suffix-matches on a leading dot for subdomains
    }
  }
  return [...set];
}

export function resolveNoProxy(s: UltraProxySettings): string[] {
  return resolveNoProxyList(s.noProxy, s.vllmHost);
}

/** NO_PROXY for a specific cluster: global base + global vLLM hosts + this cluster's vLLM hosts. */
export function resolveNoProxyForCluster(s: UltraProxySettings, cfg: ClusterConfig): string[] {
  return resolveNoProxyList(s.noProxy, [...s.vllmHost, ...cfg.vllmHost]);
}

/**
 * Expand CIDR entries into dotted-prefix tokens that env-var NO_PROXY consumers (curl / requests /
 * undici) can actually match, since not all of them do CIDR math. The original entries are kept
 * (modern curl/requests DO honor CIDR) and prefixes are added alongside.
 */
export function expandNoProxyForEnv(list: string[]): string[] {
  const out = new Set<string>();
  for (const entry of list) {
    out.add(entry);
    for (const p of cidrToPrefixes(entry)) {
      out.add(p);
    }
  }
  return [...out];
}

function cidrToPrefixes(cidr: string): string[] {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.\d+\/(\d+)$/);
  if (!m) {
    return [];
  }
  const [, a, b, c, bitsStr] = m;
  const bits = Number.parseInt(bitsStr, 10);
  if (bits === 8) {
    return [`${a}.`];
  }
  if (bits === 16) {
    return [`${a}.${b}.`];
  }
  if (bits === 24) {
    return [`${a}.${b}.${c}.`];
  }
  if (bits === 12 && a === '172') {
    const out: string[] = [];
    for (let i = 16; i <= 31; i++) {
      out.push(`172.${i}.`);
    }
    return out;
  }
  return [];
}
