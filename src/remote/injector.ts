import { Client } from 'ssh2';
import { expandNoProxyForEnv } from '../config/settings';
import { execChecked } from '../ssh/exec';
import { Logger } from '../util/logger';
import { RemoteInfo } from './detect';
import {
  PY_PATCH,
  cmdEnsureGuard,
  cmdRemoveGuard,
  cmdRunPatch,
  cmdWriteFileB64,
  renderEnvFile,
} from './scripts';

export interface InjectParams {
  proxyUrl: string; // http://127.0.0.1:<boundRemotePort>
  noProxy: string[]; // canonical NO_PROXY list (used for VSCode http.noProxy)
  patchSettings: boolean;
  injectTerminal: boolean;
}

export interface InjectResult {
  envWritten: boolean;
  settingsPatched: string[];
  settingsSkippedReason?: string;
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
): Promise<InjectResult> {
  const home = info.home;
  const dir = managedDir(home);
  const result: InjectResult = { envWritten: false, settingsPatched: [] };

  const envNoProxy = expandNoProxyForEnv(params.noProxy);

  // 1. env.sh (uses the CIDR-expanded list env-var consumers can actually match)
  const envBody = renderEnvFile(params.proxyUrl, envNoProxy.join(','));
  await execChecked(client, cmdWriteFileB64(`${dir}/env.sh`, b64(envBody)));
  result.envWritten = true;

  // 2. rc guard lines
  await execChecked(client, cmdEnsureGuard(`${home}/.bashrc`));
  await execChecked(client, cmdEnsureGuard(`${home}/.profile`));

  // 3. remote VSCode Machine settings (for Copilot & terminal env)
  if (!params.patchSettings) {
    result.settingsSkippedReason = 'disabled by setting';
  } else if (!info.hasPython3) {
    result.settingsSkippedReason = 'python3 not found on cluster';
  } else if (info.serverDirs.length === 0) {
    result.settingsSkippedReason = 'no .vscode-server directory found';
  } else {
    await execChecked(client, cmdWriteFileB64(`${dir}/patch.py`, b64(PY_PATCH)));
    const injectJson = JSON.stringify({
      proxy: params.proxyUrl,
      noProxy: params.noProxy, // http.noProxy (VSCode)
      noProxyEnv: envNoProxy, // terminal.integrated.env.linux NO_PROXY
      injectTerminal: params.injectTerminal,
    });
    await execChecked(client, cmdWriteFileB64(`${dir}/inject.json`, b64(injectJson)));
    for (const serverDir of info.serverDirs) {
      const settings = machineSettingsPath(serverDir);
      await execChecked(client, cmdRunPatch(`${dir}/patch.py`, settings, 'apply', `${dir}/inject.json`));
      result.settingsPatched.push(settings);
      logger.info(`Patched remote settings: ${settings}`);
    }
  }

  return result;
}

/** Remove all UltraProxy remote state: settings keys, rc guards, and the managed dir. */
export async function removeInjection(
  client: Client,
  info: RemoteInfo,
  patchSettings: boolean,
  logger: Logger,
): Promise<void> {
  const home = info.home;
  const dir = managedDir(home);
  let revertFailed = false;

  if (patchSettings && info.hasPython3 && info.serverDirs.length > 0) {
    try {
      await execChecked(client, cmdWriteFileB64(`${dir}/patch.py`, b64(PY_PATCH)));
      for (const serverDir of info.serverDirs) {
        const settings = machineSettingsPath(serverDir);
        await execChecked(client, cmdRunPatch(`${dir}/patch.py`, settings, 'remove'));
        logger.info(`Reverted remote settings: ${settings}`);
      }
    } catch (e) {
      revertFailed = true;
      logger.error('Failed to revert remote VSCode settings; leaving UltraProxy state in place for retry', e);
    }
  }

  await execChecked(client, cmdRemoveGuard(`${home}/.bashrc`));
  await execChecked(client, cmdRemoveGuard(`${home}/.profile`));

  // Only delete the managed dir (which holds patch.py + backups needed to retry) if the settings
  // revert actually succeeded; otherwise keep it so the user can re-run Remove.
  if (!revertFailed) {
    await execChecked(client, `rm -rf ${shq(dir)}`);
    logger.info('Removed remote UltraProxy state.');
  } else {
    logger.warn(`Remote settings revert incomplete; kept ${dir}. Re-run "Remove Proxy from Remote" once python3 is available.`);
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
