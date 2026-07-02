/** POSIX single-quote a string for safe interpolation into a remote shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
