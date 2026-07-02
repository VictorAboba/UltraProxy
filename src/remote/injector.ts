import { Client } from 'ssh2';
import { expandNoProxyForEnv } from '../config/settings';
import { CmdWrap, execChecked } from '../ssh/exec';
import { Logger } from '../util/logger';
import { RemoteInfo } from './detect';
import {
  PY_PATCH,
  cmdEnsureGuard,
  cmdRemoveGuard,
  cmdRunPatch,
  cmdUnwrapClaude,
  cmdWrapClaude,
  cmdWriteFileB64,
  cmdRemoveServerEnv,
  cmdWriteServerEnv,
  renderEnvFile,
  renderServerEnvBlock,
} from './scripts';

export interface InjectParams {
  proxyUrl: string; // http://127.0.0.1:<boundRemotePort>
  noProxy: string[]; // canonical NO_PROXY list (used for VSCode http.noProxy)
  patchSettings: boolean;
  injectTerminal: boolean;
  /** Also export the proxy env from ~/.vscode-server/server-env-setup (reaches the ext-host tree). */
  injectServerEnv: boolean;
  /** Wrap the bundled Claude Code binary so it inherits the proxy env even under a stripped env. */
  wrapClaudeCode: boolean;
}

export interface InjectResult {
  envWritten: boolean;
  settingsPatched: string[];
  settingsSkippedReason?: string;
  serverEnvWritten: boolean;
  claudeWrapped: boolean;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function managedDir(home: string): string {
  return `${home}/.ultraproxy`;
}

function machineSettingsPath(serverDir: string): string {
  return `${serverDir}/data/Machine/settings.json`;
}

/** Write env.sh + rc guards + (optionally) patch remote VSCode Machine settings. Idempotent. */
export async function applyInjection(
  client: Client,
  info: RemoteInfo,
  params: InjectParams,
  logger: Logger,
  wrap?: CmdWrap,
): Promise<InjectResult> {
  const home = info.home;
  const dir = managedDir(home);
  const result: InjectResult = { envWritten: false, settingsPatched: [], serverEnvWritten: false, claudeWrapped: false };

  const envNoProxy = expandNoProxyForEnv(params.noProxy);
  const envNoProxyCsv = envNoProxy.join(',');

  // 1. env.sh (uses the CIDR-expanded list env-var consumers can actually match)
  const envBody = renderEnvFile(params.proxyUrl, envNoProxyCsv);
  await execChecked(client, cmdWriteFileB64(`${dir}/env.sh`, b64(envBody)), wrap);
  result.envWritten = true;

  // 2. rc guard lines
  await execChecked(client, cmdEnsureGuard(`${home}/.bashrc`), wrap);
  await execChecked(client, cmdEnsureGuard(`${home}/.profile`), wrap);

  // 3. remote VSCode Machine settings (for Copilot & terminal env)
  if (!params.patchSettings) {
    result.settingsSkippedReason = 'disabled by setting';
  } else if (!info.hasPython3) {
    result.settingsSkippedReason = 'python3 not found on cluster';
  } else if (info.serverDirs.length === 0) {
    result.settingsSkippedReason = 'no .vscode-server directory found';
  } else {
    await execChecked(client, cmdWriteFileB64(`${dir}/patch.py`, b64(PY_PATCH)), wrap);
    const injectJson = JSON.stringify({
      proxy: params.proxyUrl,
      noProxy: params.noProxy, // http.noProxy (VSCode)
      noProxyEnv: envNoProxy, // terminal.integrated.env.linux NO_PROXY
      injectTerminal: params.injectTerminal,
    });
    await execChecked(client, cmdWriteFileB64(`${dir}/inject.json`, b64(injectJson)), wrap);
    for (const serverDir of info.serverDirs) {
      const settings = machineSettingsPath(serverDir);
      await execChecked(client, cmdRunPatch(`${dir}/patch.py`, settings, 'apply', `${dir}/inject.json`), wrap);
      result.settingsPatched.push(settings);
      logger.info(`Patched remote settings: ${settings}`);
    }
  }

  // 4. server-env-setup: export proxy env to the whole VSCode Server extension-host process tree.
  if (params.injectServerEnv && info.serverDirs.length > 0) {
    const block = renderServerEnvBlock(params.proxyUrl, envNoProxyCsv);
    for (const serverDir of info.serverDirs) {
      await execChecked(client, cmdWriteServerEnv(`${serverDir}/server-env-setup`, b64(block)), wrap);
      logger.info(`Wrote server-env-setup: ${serverDir}/server-env-setup`);
    }
    result.serverEnvWritten = true;
  }

  // 5. Claude Code binary wrap (opt-in): shim reads the live proxy from state on every launch.
  if (params.wrapClaudeCode && info.serverDirs.length > 0) {
    await execChecked(client, cmdWriteFileB64(`${dir}/proxy_url`, b64(params.proxyUrl)), wrap);
    await execChecked(client, cmdWriteFileB64(`${dir}/no_proxy`, b64(envNoProxyCsv)), wrap);
    for (const serverDir of info.serverDirs) {
      await execChecked(client, cmdWrapClaude(`${serverDir}/extensions`), wrap);
    }
    result.claudeWrapped = true;
    logger.info('Wrapped Claude Code binary (if present) to inherit the proxy env.');
  }

  return result;
}

/** Remove all UltraProxy remote state: settings keys, rc guards, and the managed dir. */
export async function removeInjection(
  client: Client,
  info: RemoteInfo,
  patchSettings: boolean,
  logger: Logger,
  wrap?: CmdWrap,
): Promise<void> {
  const home = info.home;
  const dir = managedDir(home);
  let revertFailed = false;

  if (patchSettings && info.hasPython3 && info.serverDirs.length > 0) {
    try {
      await execChecked(client, cmdWriteFileB64(`${dir}/patch.py`, b64(PY_PATCH)), wrap);
      for (const serverDir of info.serverDirs) {
        const settings = machineSettingsPath(serverDir);
        await execChecked(client, cmdRunPatch(`${dir}/patch.py`, settings, 'remove'), wrap);
        logger.info(`Reverted remote settings: ${settings}`);
      }
    } catch (e) {
      revertFailed = true;
      logger.error('Failed to revert remote VSCode settings; leaving UltraProxy state in place for retry', e);
    }
  }

  // Restore the Claude Code binary and strip the server-env-setup block (always attempted, so a
  // toggled-off setting still cleans up; both are no-ops when nothing was written). Best-effort: a
  // failure here (e.g. a docker-exec wrap whose container is gone) must NOT abort the rc-guard
  // removal and managed-dir cleanup below.
  for (const serverDir of info.serverDirs) {
    try {
      await execChecked(client, cmdUnwrapClaude(`${serverDir}/extensions`), wrap);
      await execChecked(client, cmdRemoveServerEnv(`${serverDir}/server-env-setup`), wrap);
    } catch (e) {
      logger.warn(`Claude/server-env cleanup failed for ${serverDir}: ${(e as Error).message}`);
    }
  }

  await execChecked(client, cmdRemoveGuard(`${home}/.bashrc`), wrap);
  await execChecked(client, cmdRemoveGuard(`${home}/.profile`), wrap);

  // Only delete the managed dir (which holds patch.py + backups needed to retry) if the settings
  // revert actually succeeded; otherwise keep it so the user can re-run Remove.
  if (!revertFailed) {
    await execChecked(client, `rm -rf ${shq(dir)}`, wrap);
    logger.info('Removed remote UltraProxy state.');
  } else {
    logger.warn(`Remote settings revert incomplete; kept ${dir}. Re-run "Remove Proxy from Remote" once python3 is available.`);
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
