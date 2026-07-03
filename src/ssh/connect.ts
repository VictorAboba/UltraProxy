import { ConnectConfig } from 'ssh2';
import { loadPrivateKey, resolveAgentPath } from './keys';

export type SshAuthMethod = 'agent' | 'key' | 'password';

export interface SshAuth {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  agentPath?: string;
}

export interface BuiltConnectConfig {
  config: ConnectConfig;
  /** Password to answer keyboard-interactive prompts with, if password auth is in play. */
  keyboardPassword?: string;
}

type Method = 'agent' | 'publickey' | 'password' | 'keyboard-interactive';

/**
 * Build an ssh2 ConnectConfig with an EXPLICIT authHandler ordering.
 *
 * ssh2's default handler tries a fixed order (password -> publickey -> agent -> keyboard),
 * and offering the agent enumerates every loaded key as a separate attempt, which trips a
 * server's MaxAuthTries ("Too many authentication failures"). So we drive an explicit method
 * list in the user's preferred precedence and only offer the agent when it was actually chosen
 * (or is the only credential available).
 */
export function makeConnectConfig(a: SshAuth): BuiltConnectConfig {
  if (!a.host || !a.username) {
    throw new Error('SSH host and user are required');
  }

  const config: ConnectConfig = {
    host: a.host,
    port: a.port || 22,
    username: a.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };

  const agentPath = resolveAgentPath(a.agentPath);
  const hasKey = !!a.privateKeyPath;
  const hasPassword = !!a.password;

  // When a credential method is chosen EXPLICITLY, require that credential — never silently fall
  // back to the SSH agent. On Windows resolveAgentPath() ALWAYS returns the default agent pipe, so a
  // missing password/key used to flip includeAgent on and collapse the auth order to ['agent']. An
  // empty/locked agent then fails with the misleading "All configured authentication methods failed"
  // even though the agent was never the user's choice. Fail loudly and actionably instead.
  if (a.authMethod === 'password' && !hasPassword) {
    throw new Error(
      `Auth method 'password' selected for "${a.host}" but no password is stored — ` +
        'set it in Clusters → Set SSH password.',
    );
  }
  if (a.authMethod === 'key' && !hasKey) {
    throw new Error(
      `Auth method 'key' selected for "${a.host}" but no private key is configured — ` +
        'set its key path in Clusters, or choose a different auth method.',
    );
  }

  // Offer the agent ONLY when it is the chosen method. (Offering it otherwise enumerates every loaded
  // key as a separate attempt and trips the server's MaxAuthTries.) With the guards above, an explicit
  // 'password'/'key' method has already thrown if its credential is missing, so this never masks one.
  const includeAgent = !!agentPath && a.authMethod === 'agent';

  if (includeAgent) {
    config.agent = agentPath;
  }
  if (hasKey) {
    config.privateKey = loadPrivateKey(a.privateKeyPath as string, a.passphrase);
    if (a.passphrase) {
      config.passphrase = a.passphrase;
    }
  }
  let keyboardPassword: string | undefined;
  if (hasPassword) {
    config.password = a.password;
    config.tryKeyboard = true;
    keyboardPassword = a.password;
  }

  if (!includeAgent && !hasKey && !hasPassword) {
    throw new Error('No SSH credentials available (need an agent, a key, or a password)');
  }

  config.authHandler = buildMethodOrder(a.authMethod, includeAgent, hasKey, hasPassword) as ConnectConfig['authHandler'];

  return { config, keyboardPassword };
}

function buildMethodOrder(pref: SshAuthMethod, agent: boolean, key: boolean, password: boolean): Method[] {
  const agentM: Method[] = agent ? ['agent'] : [];
  const keyM: Method[] = key ? ['publickey'] : [];
  const pwM: Method[] = password ? ['password', 'keyboard-interactive'] : [];

  switch (pref) {
    case 'agent':
      return [...agentM, ...keyM, ...pwM];
    case 'key':
      return [...keyM, ...pwM, ...agentM];
    case 'password':
      return [...pwM, ...keyM, ...agentM];
    default:
      return [...agentM, ...keyM, ...pwM];
  }
}
