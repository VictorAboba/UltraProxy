import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { httpGet } from '../util/http';
import { Logger } from '../util/logger';
import { extractEntries } from './unzip';

const RELEASE_BASE = 'https://github.com/XTLS/Xray-core/releases/download';

/** Map process.platform + arch to the Xray-core release asset name. */
export function assetForPlatform(platform: NodeJS.Platform, arch: string): string {
  const key = `${platform}-${arch}`;
  const table: Record<string, string> = {
    'win32-x64': 'Xray-windows-64.zip',
    'win32-arm64': 'Xray-windows-arm64-v8a.zip',
    'win32-ia32': 'Xray-windows-32.zip',
    'linux-x64': 'Xray-linux-64.zip',
    'linux-arm64': 'Xray-linux-arm64-v8a.zip',
    'linux-arm': 'Xray-linux-arm32-v7a.zip',
    'linux-ia32': 'Xray-linux-32.zip',
    'darwin-x64': 'Xray-macos-64.zip',
    'darwin-arm64': 'Xray-macos-arm64-v8a.zip',
  };
  const asset = table[key];
  if (!asset) {
    throw new Error(`No Xray asset for platform ${key}`);
  }
  return asset;
}

function binName(): string {
  return process.platform === 'win32' ? 'xray.exe' : 'xray';
}

/**
 * If the user configured an explicit path (a binary or a v2rayN root), resolve the actual
 * xray executable from it. Returns undefined if nothing usable is found.
 */
export function resolveConfiguredPath(configured: string): string | undefined {
  if (!configured) {
    return undefined;
  }
  const candidates: string[] = [];
  try {
    const stat = fs.statSync(configured);
    if (stat.isFile()) {
      return configured;
    }
    if (stat.isDirectory()) {
      // Direct executable in the dir, plus the v2rayN layout (bin/xray/xray.exe).
      candidates.push(path.join(configured, binName()));
      candidates.push(path.join(configured, 'bin', 'xray', binName()));
      candidates.push(path.join(configured, 'xray', binName()));
    }
  } catch {
    return undefined;
  }
  return candidates.find((c) => fs.existsSync(c));
}

/** Parse the SHA-256 from a `.dgst` sidecar (line format: `SHA2-256= <lowercasehex>`). */
export function parseDgstSha256(dgst: string): string | undefined {
  for (const line of dgst.split(/\r?\n/)) {
    const m = line.match(/^\s*SHA2-256\s*=\s*([0-9a-fA-F]{64})\s*$/);
    if (m) {
      return m[1].toLowerCase();
    }
  }
  return undefined;
}

export interface ResolveOptions {
  configuredPath: string;
  version: string;
  cacheRoot: string; // context.globalStorageUri.fsPath
  /** Extension install dir; a bundled binary at bin/<platform>-<arch>/ is used first (no download). */
  bundledRoot?: string;
  /** Permit running a downloaded binary that could not be checksum-verified (default: false). */
  allowUnverified?: boolean;
}

/** Path to a binary bundled inside the extension (.vsix), if present. */
export function bundledBinaryPath(bundledRoot: string): string {
  return path.join(bundledRoot, 'bin', `${process.platform}-${process.arch}`, binName());
}

/** The bundle carries a `.xray-version` marker; only use it when it matches the requested version. */
function bundledMatchesVersion(bundledRoot: string, version: string): boolean {
  try {
    const marker = path.join(bundledRoot, 'bin', `${process.platform}-${process.arch}`, '.xray-version');
    if (!fs.existsSync(marker)) {
      return true; // no marker (older bundle): trust it
    }
    return fs.readFileSync(marker, 'utf8').trim() === version;
  } catch {
    return true;
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a path to a runnable xray binary, downloading + verifying the pinned release if needed.
 */
export async function resolveXrayBinary(opts: ResolveOptions, logger: Logger): Promise<string> {
  const configured = resolveConfiguredPath(opts.configuredPath);
  if (configured) {
    logger.info(`Using configured xray binary: ${configured}`);
    return configured;
  }

  const version = opts.version || 'v26.3.27';

  // Prefer a binary bundled inside the .vsix — nothing is fetched externally at runtime.
  if (opts.bundledRoot) {
    const bundled = bundledBinaryPath(opts.bundledRoot);
    if (fs.existsSync(bundled) && bundledMatchesVersion(opts.bundledRoot, version)) {
      if (process.platform === 'win32') {
        logger.info(`Using bundled xray binary: ${bundled}`);
        return bundled;
      }
      try {
        fs.chmodSync(bundled, 0o755);
      } catch {
        /* install dir may be read-only; verify below */
      }
      if (isExecutable(bundled)) {
        logger.info(`Using bundled xray binary: ${bundled}`);
        return bundled;
      }
      logger.warn(`Bundled xray is present but not executable (${bundled}); falling back to download.`);
    }
  }
  const cacheDir = path.join(opts.cacheRoot, 'xray', version);
  const binPath = path.join(cacheDir, binName());
  if (fs.existsSync(binPath)) {
    logger.info(`Using cached xray ${version}: ${binPath}`);
    return binPath;
  }

  const asset = assetForPlatform(process.platform, process.arch);
  const zipUrl = `${RELEASE_BASE}/${version}/${asset}`;
  const dgstUrl = `${zipUrl}.dgst`;

  logger.info(`Downloading Xray ${version} (${asset})...`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const zipBytes = await httpGet(zipUrl);

  // Fail closed: a downloaded binary that cannot be verified is NOT written or executed
  // unless the user explicitly opted in via ultraproxy.allowUnverifiedBinary.
  try {
    const dgst = (await httpGet(dgstUrl)).toString('utf8');
    const expected = parseDgstSha256(dgst);
    if (!expected) {
      throw new Error('could not parse a SHA2-256 line from the .dgst sidecar');
    }
    const actual = crypto.createHash('sha256').update(zipBytes).digest('hex');
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for ${asset} (expected ${expected}, got ${actual})`);
    }
    logger.info('Checksum verified.');
  } catch (e) {
    const msg = (e as Error).message;
    if (!opts.allowUnverified) {
      throw new Error(
        `Refusing to run unverified Xray binary: ${msg}. ` +
          `Retry later, set ultraproxy.xrayPath to a trusted binary, or set ultraproxy.allowUnverifiedBinary to override.`,
      );
    }
    logger.warn(`Checksum verification skipped (allowUnverifiedBinary=true): ${msg}`);
  }

  const zipPath = path.join(cacheDir, asset);
  fs.writeFileSync(zipPath, zipBytes);
  const extracted = await extractEntries(zipPath, [binName()], cacheDir);
  fs.unlinkSync(zipPath);

  const finalPath = extracted[binName()];
  if (!finalPath || !fs.existsSync(finalPath)) {
    throw new Error(`Xray binary not found inside ${asset}`);
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(finalPath, 0o755);
  }
  logger.info(`Xray ready: ${finalPath}`);
  return finalPath;
}
