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
} = require(path.join(OUT, 'config/settings'));
const { extractModelIds } = require(path.join(OUT, 'util/probe'));

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

// ---- probe helper ----
check('extractModelIds', (extractModelIds(JSON.stringify({ data: [{ id: 'claude-opus-4' }, { id: 'gpt-5' }] })) || []).length === 2);
check('extractModelIds non-json', extractModelIds('<html>') === undefined);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
