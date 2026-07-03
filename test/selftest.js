/* Behavioral self-test against the compiled extension modules. Run: npm test (after npm run compile). */
const path = require('path');
const Module = require('module');

// Stub 'vscode' so modules that import it can load in plain Node.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
  }
  return origLoad.call(this, request, ...rest);
};

const OUT = path.join(__dirname, '..', 'out');
const { parseSs } = require(path.join(OUT, 'uri/parseSs'));
const { parseVless } = require(path.join(OUT, 'uri/parseVless'));
const { decodeSubscription } = require(path.join(OUT, 'uri/parseSubscription'));
const { buildXrayConfig, normalizeWhitelist } = require(path.join(OUT, 'xray/configBuilder'));
const {
  resolveNoProxy,
  expandNoProxyForEnv,
  cleanHost,
  getClusters,
  resolveNoProxyForCluster,
  resolvedClusterName,
  parseJumpSpec,
} = require(path.join(OUT, 'config/settings'));
const {
  wrapExec,
  renderServerEnvBlock,
  cmdWriteServerEnv,
  cmdRemoveServerEnv,
  cmdWrapClaude,
  cmdUnwrapClaude,
} = require(path.join(OUT, 'remote/scripts'));
const { extractModelIds } = require(path.join(OUT, 'util/probe'));
const { makeConnectConfig } = require(path.join(OUT, 'ssh/connect'));

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + extra : ''}`);
}

// ---- ss parsing ----
const ssA = parseSs('ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@1.2.3.4:8388#My%20SS');
check('ss form-A', ssA.method === 'aes-256-gcm' && ssA.password === 'password' && ssA.host === '1.2.3.4' && ssA.port === 8388 && ssA.tag === 'My SS');
const ssB = parseSs('ss://2022-blake3-aes-256-gcm:c29tZXBzaw==@server.example:8388#ss2022');
check('ss form-B (2022)', ssB.method === '2022-blake3-aes-256-gcm' && ssB.password === 'c29tZXBzaw==');
const ssL = parseSs('ss://' + Buffer.from('aes-128-gcm:pw@10.0.0.1:1080').toString('base64') + '#legacy');
check('ss legacy', ssL.method === 'aes-128-gcm' && ssL.host === '10.0.0.1' && ssL.port === 1080);

// ---- vless parsing ----
const vTls = parseVless('vless://u1@vless.example.com:443?security=tls&type=tcp&flow=xtls-rprx-vision&sni=sni.example.com&fp=chrome&alpn=h2,http%2F1.1#tls');
check('vless tls', vTls.flow === 'xtls-rprx-vision' && vTls.transport.sni === 'sni.example.com' && vTls.transport.alpn.join(',') === 'h2,http/1.1');
const vWs = parseVless('vless://u3@cdn.example.com:443?type=ws&security=tls&flow=xtls-rprx-vision&path=%2Fws&host=cdn.example.com&sni=cdn.example.com#ws');
check('vless ws drops flow', vWs.flow === undefined && vWs.transport.path === '/ws');
let threwSni = false;
try {
  parseVless('vless://u@h:443?security=reality&type=tcp&pbk=K');
} catch {
  threwSni = true;
}
check('vless reality requires sni', threwSni);

// ---- subscription ----
const sub = Buffer.from('ss://YWVzLTI1Ni1nY206cA==@1.1.1.1:80#a\nvless://u@h:443?type=tcp#b\n# comment\n').toString('base64');
check('subscription decode', decodeSubscription(sub).length === 2);

// ---- config builder ----
const cfg = buildXrayConfig(ssA, { socksPort: 1, httpPort: 2, whitelistDomains: normalizeWhitelist(['api.foo.com']) });
check('cfg default-route direct', cfg.routing.rules.find((r) => r.ruleTag === 'default-route').outboundTag === 'direct');
check('cfg whitelist copilot+anthropic', cfg.routing.rules[0].domain.includes('domain:anthropic.com') && cfg.routing.rules[0].domain.includes('domain:githubcopilot.com'));
const cfgStrict = buildXrayConfig(ssA, { socksPort: 1, httpPort: 2, whitelistDomains: [], strict: true });
check('cfg strict blocks', cfgStrict.routing.rules.find((r) => r.ruleTag === 'default-route').outboundTag === 'block');

// ---- NO_PROXY ----
const np = resolveNoProxy({ noProxy: ['localhost'], vllmHost: ['vllm.internal:8000', '10.1.2.3'] });
check('vllm host:port sanitized', np.includes('vllm.internal') && np.includes('.vllm.internal') && np.includes('10.1.2.3') && !np.includes('vllm.internal:8000'));
check('cleanHost', cleanHost('a.b:1234') === 'a.b');
const env = expandNoProxyForEnv(['10.0.0.0/8', '172.16.0.0/12']);
check('env CIDR expand', env.includes('10.') && env.includes('172.16.') && env.includes('172.31.'));

// ---- clusters ----
const flatDefaults = {
  sshPort: 22,
  sshAuthMethod: 'agent',
  sshPrivateKeyPath: '',
  sshAgentPath: '',
  remoteProxyPort: 0,
  patchCopilotSettings: true,
  injectTerminalEnv: true,
  injectServerEnv: false,
  wrapClaudeCode: false,
  sshProxyJump: '',
  execProfile: 'direct',
  dockerContainer: '',
  execTemplate: '',
  sshHost: '',
  sshUser: '',
  noProxy: ['localhost'],
  vllmHost: ['global.lan'],
};
const multi = getClusters({ ...flatDefaults, clusters: [{ host: 'gpu1.edu', user: 'v', vllmHost: ['10.0.0.5:8000'] }, { name: 'big', host: 'gpu2.edu', user: 'v', authMethod: 'password' }, { user: 'bad' }] });
check('getClusters filters invalid + defaults', multi.length === 2 && multi[0].port === 22 && multi[1].authMethod === 'password');
const flat = getClusters({ ...flatDefaults, sshHost: 'solo.edu', sshUser: 'v', clusters: [] });
check('getClusters flat fallback', flat.length === 1 && flat[0].name === 'solo.edu');
const cnp = resolveNoProxyForCluster({ ...flatDefaults }, multi[0]);
check('cluster noProxy merges vllm', cnp.includes('global.lan') && cnp.includes('10.0.0.5'));

const rawDup = [{ host: 'gpu1', user: 'a' }, { host: 'gpu1', user: 'b' }, { name: 'prod', host: 'x', user: 'a' }];
check('resolvedClusterName dedups', resolvedClusterName(rawDup, 0) === 'gpu1' && resolvedClusterName(rawDup, 1) === 'gpu1-2' && resolvedClusterName(rawDup, 2) === 'prod');
check('resolvedClusterName == getClusters names', getClusters({ ...flatDefaults, clusters: rawDup }).map((c) => c.name).join(',') === [0, 1, 2].map((i) => resolvedClusterName(rawDup, i)).join(','));

// ---- borrowed features: exec profile + proxyJump on clusters ----
const multi2 = getClusters({ ...flatDefaults, clusters: [{ host: 'c1', user: 'v', execProfile: 'docker', dockerContainer: 'box' }, { host: 'c2', user: 'v' }] });
check('cluster execProfile override + default', multi2[0].execProfile === 'docker' && multi2[0].dockerContainer === 'box' && multi2[1].execProfile === 'direct');
check('cluster proxyJump inherits flat default', getClusters({ ...flatDefaults, sshProxyJump: 'bastion', clusters: [{ host: 'c', user: 'v' }] })[0].proxyJump === 'bastion');
check('cluster proxyJump per-cluster overrides', getClusters({ ...flatDefaults, sshProxyJump: 'bastion', clusters: [{ host: 'c', user: 'v', proxyJump: 'own.edu' }] })[0].proxyJump === 'own.edu');

// ---- parseJumpSpec ----
check('parseJumpSpec host only', (() => { const j = parseJumpSpec('bastion.edu', 'me', 22); return j && j.host === 'bastion.edu' && j.user === 'me' && j.port === 22; })());
check('parseJumpSpec user@host:port', (() => { const j = parseJumpSpec('ju@bastion.edu:2222', 'me', 22); return j && j.host === 'bastion.edu' && j.user === 'ju' && j.port === 2222; })());
check('parseJumpSpec ipv6 bracket', (() => { const j = parseJumpSpec('[2001:db8::1]:2200', 'me', 22); return j && j.host === '2001:db8::1' && j.port === 2200; })());
check('parseJumpSpec bare ipv6 keeps host', (() => { const j = parseJumpSpec('2001:db8::1', 'me', 22); return j && j.host === '2001:db8::1' && j.port === 22; })());
check('parseJumpSpec unclosed bracket strips [', (() => { const j = parseJumpSpec('[::1', 'me', 22); return j && j.host === '::1'; })());
check('parseJumpSpec empty', parseJumpSpec('  ', 'me', 22) === undefined);

// ---- exec wrapper ----
check('wrapExec direct identity', wrapExec('echo hi', { profile: 'direct', dockerContainer: '', execTemplate: '' }) === 'echo hi');
const dk = wrapExec("echo 'a'", { profile: 'docker', dockerContainer: 'ml', execTemplate: '' });
check('wrapExec docker', dk.startsWith('docker exec ') && dk.includes("'ml'") && dk.includes('bash -lc'), dk);
const ct = wrapExec('echo hi', { profile: 'custom', dockerContainer: '', execTemplate: 'sudo {{CMD}}' });
check('wrapExec custom', ct.startsWith('sudo bash -lc ') && ct.includes("'echo hi'"), ct);
check('wrapExec docker requires container', (() => { try { wrapExec('x', { profile: 'docker', dockerContainer: '', execTemplate: '' }); return false; } catch { return true; } })());
check('wrapExec custom requires placeholder', (() => { try { wrapExec('x', { profile: 'custom', dockerContainer: '', execTemplate: 'sudo' }); return false; } catch { return true; } })());

// ---- server-env-setup + claude wrap builders ----
const seb = renderServerEnvBlock('http://127.0.0.1:1080', 'localhost,10.');
check('renderServerEnvBlock', seb.includes('UltraProxy server-env BEGIN') && seb.includes('export HTTPS_PROXY="http://127.0.0.1:1080"') && seb.includes('UltraProxy server-env END'));
const wcmd = cmdWriteServerEnv('/home/u/.vscode-server/server-env-setup', Buffer.from(seb).toString('base64'));
check('cmdWriteServerEnv strips+appends', wcmd.includes('mkdir -p') && wcmd.includes('base64 -d') && wcmd.includes('server-env BEGIN'));
check('cmdRemoveServerEnv strips block', cmdRemoveServerEnv('/x/server-env-setup').includes('server-env BEGIN'));
const wc = cmdWrapClaude('/home/u/.vscode-server/extensions');
check('cmdWrapClaude', wc.includes('anthropic.claude-code-*') && wc.includes('claude.real') && wc.includes('ultraproxy-claude-wrapper'));
check('cmdWrapClaude base64 not heredoc (wrap-safe)', wc.includes('base64 -d') && !wc.includes('UPWRAP') && !wc.includes('<<'));
check('cmdUnwrapClaude restores', cmdUnwrapClaude('/x/extensions').includes('mv "$real" "$bin"'));

// ---- ssh auth config (makeConnectConfig): an explicit method must NOT silently fall back to agent ----
const FAKE_AGENT = '\\\\.\\pipe\\fake-agent'; // stand-in for the always-present Windows agent pipe
const built = (auth) => makeConnectConfig({ host: 'h', port: 22, username: 'u', ...auth });
const throwsWith = (fn, needle) => {
  try { fn(); return false; } catch (e) { return String(e.message).includes(needle); }
};
const pwCfg = built({ authMethod: 'password', password: 's3cret', agentPath: FAKE_AGENT });
check('connect password: password+keyboard order, agent NOT offered',
  Array.isArray(pwCfg.config.authHandler) &&
  pwCfg.config.authHandler.join(',') === 'password,keyboard-interactive' &&
  pwCfg.config.agent === undefined && pwCfg.keyboardPassword === 's3cret',
  pwCfg.config.authHandler);
// The actual rost_dev bug: password chosen, none stored, agent pipe present -> must throw, not use agent.
check('connect password missing throws (no silent agent fallback)',
  throwsWith(() => built({ authMethod: 'password', agentPath: FAKE_AGENT }), 'Set SSH password'));
check('connect key missing throws (no silent agent fallback)',
  throwsWith(() => built({ authMethod: 'key', agentPath: FAKE_AGENT }), 'no private key'));
const agCfg = built({ authMethod: 'agent', agentPath: FAKE_AGENT });
check('connect agent: agent offered when chosen',
  Array.isArray(agCfg.config.authHandler) && agCfg.config.authHandler.join(',') === 'agent' &&
  agCfg.config.agent === FAKE_AGENT);

// ---- probe helper ----
check('extractModelIds', (extractModelIds(JSON.stringify({ data: [{ id: 'claude-opus-4' }, { id: 'gpt-5' }] })) || []).length === 2);
check('extractModelIds non-json', extractModelIds('<html>') === undefined);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
