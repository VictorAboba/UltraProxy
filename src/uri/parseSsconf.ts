import { httpGet } from '../util/http';
import { ShadowsocksProfile, Sip008Server } from './types';

function ssconfToHttps(uri: string): string {
  if (uri.startsWith('ssconf://')) {
    return 'https://' + uri.slice('ssconf://'.length);
  }
  return uri;
}

/** Fetch and parse a SIP008 online-config document, returning all servers. */
export async function fetchSsconfServers(uri: string): Promise<Sip008Server[]> {
  const url = ssconfToHttps(uri);
  const body = await httpGet(url, { headers: { Accept: 'application/json' } });
  let json: any;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch (e) {
    throw new Error(`SIP008: response was not valid JSON (${(e as Error).message})`);
  }
  const servers = json?.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error('SIP008: document has no servers');
  }
  return servers as Sip008Server[];
}

function serverToProfile(s: Sip008Server): ShadowsocksProfile {
  if (!s.server || !s.server_port || !s.method || s.password === undefined) {
    throw new Error('SIP008 server entry missing required fields');
  }
  return {
    kind: 'shadowsocks',
    host: s.server,
    port: Number(s.server_port),
    method: s.method,
    password: s.password,
    tag: s.remarks,
    plugin: s.plugin || undefined,
    pluginOpts: s.plugin_opts || undefined,
  };
}

/** Fetch a SIP008 config and pick a server by remarks/id (or the first one). */
export async function parseSsconf(uri: string, serverName?: string): Promise<ShadowsocksProfile> {
  const servers = await fetchSsconfServers(uri);
  let chosen = servers[0];
  if (serverName) {
    const match = servers.find((s) => s.remarks === serverName || s.id === serverName);
    if (match) {
      chosen = match;
    }
  }
  return serverToProfile(chosen);
}

export { serverToProfile as ssconfServerToProfile };
