import { ExecProfile } from '../config/settings';

/** POSIX single-quote a string for safe interpolation into a remote shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The cluster exec-profile inputs needed to wrap a remote command. */
export interface RemoteExecProfile {
  profile: ExecProfile;
  dockerContainer: string;
  execTemplate: string;
}

/**
 * Wrap a remote command per the cluster's exec profile so injection can target a container or a
 * custom launcher instead of the SSH host directly:
 *   direct — the command runs as-is on the SSH host (default; no change).
 *   docker — `docker exec <container> bash -lc '<cmd>'` (injects into the container's $HOME).
 *   custom — a user template whose `{{CMD}}` expands to `bash -lc '<cmd>'` (e.g. `sudo {{CMD}}`).
 */
export function wrapExec(cmd: string, p: RemoteExecProfile): string {
  switch (p.profile) {
    case 'docker': {
      const c = p.dockerContainer.trim();
      if (!c) {
        throw new Error("execProfile is 'docker' but no dockerContainer is configured.");
      }
      return `docker exec ${shQuote(c)} bash -lc ${shQuote(cmd)}`;
    }
    case 'custom': {
      const t = p.execTemplate.trim();
      if (!t) {
        throw new Error("execProfile is 'custom' but no execTemplate is configured.");
      }
      if (!t.includes('{{CMD}}')) {
        throw new Error("execTemplate must contain the {{CMD}} placeholder (e.g. 'sudo {{CMD}}').");
      }
      return t.replace(/\{\{CMD\}\}/g, `bash -lc ${shQuote(cmd)}`);
    }
    case 'direct':
    default:
      return cmd;
  }
}

/** Command that writes base64 content to an absolute path (dirs created). */
export function cmdWriteFileB64(absPath: string, contentB64: string): string {
  const dir = absPath.replace(/\/[^/]*$/, '') || '/';
  return `mkdir -p ${shQuote(dir)} && printf '%s' ${shQuote(contentB64)} | base64 -d > ${shQuote(absPath)}`;
}

/** The exact marker appended to the guard line; unique so removal never touches user lines. */
const GUARD_MARKER = '# ULTRAPROXY-MANAGED-LINE';

/** Idempotently append the source-guard line to an rc file. */
export function cmdEnsureGuard(rcAbsPath: string): string {
  const line = `[ -f "$HOME/.ultraproxy/env.sh" ] && . "$HOME/.ultraproxy/env.sh"  ${GUARD_MARKER}`;
  return `touch ${shQuote(rcAbsPath)} && (grep -qF ${shQuote(GUARD_MARKER)} ${shQuote(rcAbsPath)} || printf '%s\\n' ${shQuote(line)} >> ${shQuote(rcAbsPath)})`;
}

/** Remove the guard line from an rc file (anchored to our unique marker at end of line). */
export function cmdRemoveGuard(rcAbsPath: string): string {
  return `[ -f ${shQuote(rcAbsPath)} ] && sed -i ${shQuote(`/${GUARD_MARKER}$/d`)} ${shQuote(rcAbsPath)} || true`;
}

/** Run the settings patcher: `python3 <py> <settings> <mode> [<dataJson>]`. */
export function cmdRunPatch(pyAbsPath: string, settingsAbsPath: string, mode: 'apply' | 'remove', dataAbsPath?: string): string {
  const parts = ['python3', shQuote(pyAbsPath), shQuote(settingsAbsPath), mode];
  if (dataAbsPath) {
    parts.push(shQuote(dataAbsPath));
  }
  return parts.join(' ');
}

/** The env.sh body written verbatim between managed sentinels. */
export function renderEnvFile(proxyUrl: string, noProxy: string): string {
  return [
    '# >>> UltraProxy (managed) >>>',
    `export HTTPS_PROXY=${JSON.stringify(proxyUrl)}`,
    `export HTTP_PROXY=${JSON.stringify(proxyUrl)}`,
    `export NO_PROXY=${JSON.stringify(noProxy)}`,
    `export https_proxy=${JSON.stringify(proxyUrl)}`,
    `export http_proxy=${JSON.stringify(proxyUrl)}`,
    `export no_proxy=${JSON.stringify(noProxy)}`,
    'export NODE_USE_ENV_PROXY=1',
    '# <<< UltraProxy (managed) <<<',
    '',
  ].join('\n');
}

const SERVER_ENV_BEGIN = '# >>> UltraProxy server-env BEGIN <<<';
const SERVER_ENV_END = '# >>> UltraProxy server-env END <<<';
// awk program that drops any prior UltraProxy block (idempotent write / clean removal).
const SERVER_ENV_STRIP = `awk '/^${SERVER_ENV_BEGIN}$/{s=1;next} /^${SERVER_ENV_END}$/{s=0;next} !s{print}'`;

/** The proxy block written into ~/.vscode-server/server-env-setup (sourced by VSCode Server). */
export function renderServerEnvBlock(proxyUrl: string, noProxyCsv: string): string {
  return [
    SERVER_ENV_BEGIN,
    `export HTTPS_PROXY=${JSON.stringify(proxyUrl)}`,
    `export HTTP_PROXY=${JSON.stringify(proxyUrl)}`,
    `export NO_PROXY=${JSON.stringify(noProxyCsv)}`,
    `export https_proxy=${JSON.stringify(proxyUrl)}`,
    `export http_proxy=${JSON.stringify(proxyUrl)}`,
    `export no_proxy=${JSON.stringify(noProxyCsv)}`,
    'export NODE_USE_ENV_PROXY=1',
    SERVER_ENV_END,
    '',
  ].join('\n');
}

/** Strip any prior UltraProxy block, then append the given (base64-encoded) block. Idempotent. */
export function cmdWriteServerEnv(absPath: string, blockB64: string): string {
  const dir = absPath.replace(/\/[^/]*$/, '') || '/';
  const tmp = `${absPath}.up`;
  return (
    `mkdir -p ${shQuote(dir)} && touch ${shQuote(absPath)} && ` +
    `${SERVER_ENV_STRIP} ${shQuote(absPath)} > ${shQuote(tmp)} && mv ${shQuote(tmp)} ${shQuote(absPath)} && ` +
    `printf '%s' ${shQuote(blockB64)} | base64 -d >> ${shQuote(absPath)}`
  );
}

/** Remove the UltraProxy block from server-env-setup; delete the file if it becomes empty. */
export function cmdRemoveServerEnv(absPath: string): string {
  const tmp = `${absPath}.up`;
  return (
    `if [ -f ${shQuote(absPath)} ]; then ` +
    `${SERVER_ENV_STRIP} ${shQuote(absPath)} > ${shQuote(tmp)} && mv ${shQuote(tmp)} ${shQuote(absPath)}; ` +
    `if [ ! -s ${shQuote(absPath)} ]; then rm -f ${shQuote(absPath)}; fi; ` +
    `fi; true`
  );
}

// Unique marker embedded in the shim so wrap/unwrap only ever touch our own replacement.
const CLAUDE_SHIM_MARKER = 'ultraproxy-claude-wrapper';
// The shim re-reads the live proxy URL from state on every launch, so a reconnect that changes the
// port is picked up automatically. $HOME resolves to the same context the injection wrote into.
const CLAUDE_SHIM = [
  '#!/usr/bin/env bash',
  `# ${CLAUDE_SHIM_MARKER}: injected by UltraProxy`,
  'UP_STATE="$HOME/.ultraproxy"',
  'if [ -f "$UP_STATE/proxy_url" ]; then',
  '  UP_URL="$(cat "$UP_STATE/proxy_url" 2>/dev/null || true)"',
  '  if [ -n "$UP_URL" ]; then',
  '    export HTTPS_PROXY="$UP_URL" HTTP_PROXY="$UP_URL" https_proxy="$UP_URL" http_proxy="$UP_URL"',
  '    if [ -f "$UP_STATE/no_proxy" ]; then',
  '      UP_NP="$(cat "$UP_STATE/no_proxy" 2>/dev/null || true)"',
  '      export NO_PROXY="$UP_NP" no_proxy="$UP_NP"',
  '    fi',
  '    export NODE_USE_ENV_PROXY=1',
  '  fi',
  'fi',
  'exec "$(dirname "$0")/claude.real" "$@"',
  '',
].join('\n');

// The shim is written via base64 decode (not a heredoc): a quoted heredoc delimiter does NOT survive
// being re-wrapped as `bash -lc '<script>'` by the docker/custom exec profiles (shQuote mangles the
// delimiter into an unquoted one, which would expand $HOME/$(...) at install time). A base64 blob has
// no shell-significant characters, so it round-trips through any nesting unchanged.
const CLAUDE_SHIM_B64 = Buffer.from(CLAUDE_SHIM, 'utf8').toString('base64');

/**
 * Wrap the Anthropic Claude Code extension's bundled `claude` binary under `extRoot` so it inherits
 * the proxy env even when the extension host spawns it with a stripped environment. Idempotent:
 * renames the real binary to `claude.real` once, then installs the shim.
 */
export function cmdWrapClaude(extRoot: string): string {
  const glob = `${shQuote(extRoot)}/anthropic.claude-code-*`;
  return [
    `for d in ${glob}; do`,
    '  [ -d "$d" ] || continue;',
    '  bin="$d/resources/native-binary/claude";',
    '  real="$d/resources/native-binary/claude.real";',
    '  [ -f "$bin" ] || continue;',
    `  if [ -f "$real" ] && grep -q ${CLAUDE_SHIM_MARKER} "$bin" 2>/dev/null; then continue; fi;`,
    '  if [ ! -f "$real" ]; then mv "$bin" "$real"; else rm -f "$bin"; fi;',
    `  printf '%s' ${shQuote(CLAUDE_SHIM_B64)} | base64 -d > "$bin";`,
    '  chmod +x "$bin";',
    'done; true',
  ].join('\n');
}

/** Restore any Claude Code binaries we wrapped under `extRoot` (moves claude.real back). */
export function cmdUnwrapClaude(extRoot: string): string {
  const glob = `${shQuote(extRoot)}/anthropic.claude-code-*`;
  return [
    `for d in ${glob}; do`,
    '  [ -d "$d" ] || continue;',
    '  bin="$d/resources/native-binary/claude";',
    '  real="$d/resources/native-binary/claude.real";',
    '  [ -f "$real" ] || continue;',
    `  if [ -f "$bin" ] && grep -q ${CLAUDE_SHIM_MARKER} "$bin" 2>/dev/null; then`,
    '    rm -f "$bin"; mv "$real" "$bin"; chmod +x "$bin";',
    '  fi;',
    'done; true',
  ].join('\n');
}

/**
 * Python patcher for the remote VSCode Machine settings.json (JSONC-tolerant read, backup once,
 * idempotent apply/remove of only UltraProxy-managed keys).
 */
export const PY_PATCH = String.raw`import json, os, sys

settings_path = sys.argv[1]
mode = sys.argv[2]
data_path = sys.argv[3] if len(sys.argv) > 3 else None

MANAGED_KEYS = ['http.proxy', 'http.noProxy', 'http.proxySupport', 'http.useLocalProxyConfiguration']
ENV_KEY = 'terminal.integrated.env.linux'
ENV_SUBKEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']

def load(path):
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception:
        return {}

os.makedirs(os.path.dirname(settings_path), exist_ok=True)
data = load(settings_path)
if not isinstance(data, dict):
    data = {}

if mode == 'apply':
    with open(data_path) as f:
        cfg = json.load(f)
    proxy = cfg['proxy']
    noproxy = cfg['noProxy']
    noproxy_env = cfg.get('noProxyEnv', noproxy)
    inject_terminal = cfg.get('injectTerminal', True)
    bak = settings_path + '.ultraproxy.bak'
    if os.path.exists(settings_path) and not os.path.exists(bak):
        try:
            with open(settings_path) as f:
                raw = f.read()
            with open(bak, 'w') as f:
                f.write(raw)
        except Exception:
            pass
    data['http.proxy'] = proxy
    data['http.noProxy'] = noproxy
    data['http.proxySupport'] = 'override'
    data['http.useLocalProxyConfiguration'] = False
    if inject_terminal:
        env = data.get(ENV_KEY)
        if not isinstance(env, dict):
            env = {}
        env.update({
            'HTTPS_PROXY': proxy, 'HTTP_PROXY': proxy, 'NO_PROXY': ','.join(noproxy_env),
            'https_proxy': proxy, 'http_proxy': proxy, 'no_proxy': ','.join(noproxy_env),
            'NODE_USE_ENV_PROXY': '1',
        })
        data[ENV_KEY] = env
elif mode == 'remove':
    for k in MANAGED_KEYS:
        data.pop(k, None)
    env = data.get(ENV_KEY)
    if isinstance(env, dict):
        for k in ENV_SUBKEYS:
            env.pop(k, None)
        if env:
            data[ENV_KEY] = env
        else:
            data.pop(ENV_KEY, None)

with open(settings_path, 'w') as f:
    json.dump(data, f, indent=2)
`;
