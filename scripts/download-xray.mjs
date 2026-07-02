/**
 * Build-time bundler: downloads the pinned Xray-core binaries, verifies their SHA-256 against the
 * release `.dgst`, and extracts them into `bin/<platform>-<arch>/` so they can be shipped INSIDE the
 * .vsix. At runtime the extension then uses the bundled binary and never fetches anything external.
 *
 * Usage:  node scripts/download-xray.mjs            (default targets: win32-x64, linux-x64)
 *         XRAY_VERSION=v26.3.27 node scripts/download-xray.mjs
 *         XRAY_TARGETS=win32-x64,linux-x64,linux-arm64 node scripts/download-xray.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE_BASE = 'https://github.com/XTLS/Xray-core/releases/download';

const VERSION = process.env.XRAY_VERSION || readPinnedVersion() || 'v26.3.27';

// platform-arch -> release asset + binary name inside the zip
const ASSETS = {
  'win32-x64': { asset: 'Xray-windows-64.zip', bin: 'xray.exe' },
  'win32-arm64': { asset: 'Xray-windows-arm64-v8a.zip', bin: 'xray.exe' },
  'linux-x64': { asset: 'Xray-linux-64.zip', bin: 'xray' },
  'linux-arm64': { asset: 'Xray-linux-arm64-v8a.zip', bin: 'xray' },
  'darwin-x64': { asset: 'Xray-macos-64.zip', bin: 'xray' },
  'darwin-arm64': { asset: 'Xray-macos-arm64-v8a.zip', bin: 'xray' },
};

const targets = (process.env.XRAY_TARGETS || 'win32-x64,linux-x64')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

function readPinnedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg?.contributes?.configuration?.properties?.['ultraproxy.xrayVersion']?.default;
  } catch {
    return undefined;
  }
}

function get(url, redirects = 6) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'UltraProxy-build' } }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) {
            return reject(new Error(`Too many redirects for ${url}`));
          }
          return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${status} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

function parseDgstSha256(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*SHA2-256\s*=\s*([0-9a-fA-F]{64})\s*$/);
    if (m) {
      return m[1].toLowerCase();
    }
  }
  return undefined;
}

function extractBinary(zipBuffer, wantedBase, destFile) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        return reject(err ?? new Error('failed to open zip'));
      }
      let found = false;
      zip.on('entry', (entry) => {
        if (path.basename(entry.fileName) !== wantedBase || /\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) {
            return reject(e ?? new Error('failed to read entry'));
          }
          fs.mkdirSync(path.dirname(destFile), { recursive: true });
          const ws = fs.createWriteStream(destFile);
          rs.on('error', reject);
          ws.on('error', reject);
          ws.on('close', () => {
            found = true;
            resolve();
          });
          rs.pipe(ws);
        });
      });
      zip.on('end', () => {
        if (!found) {
          reject(new Error(`binary ${wantedBase} not found in zip`));
        }
      });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function main() {
  console.log(`Bundling Xray ${VERSION} for: ${targets.join(', ')}`);
  for (const target of targets) {
    const spec = ASSETS[target];
    if (!spec) {
      throw new Error(`Unknown target "${target}". Known: ${Object.keys(ASSETS).join(', ')}`);
    }
    const zipUrl = `${RELEASE_BASE}/${VERSION}/${spec.asset}`;
    const dgstUrl = `${zipUrl}.dgst`;
    console.log(`  ↓ ${spec.asset}`);
    const [zip, dgst] = await Promise.all([get(zipUrl), get(dgstUrl)]);

    const expected = parseDgstSha256(dgst.toString('utf8'));
    if (!expected) {
      throw new Error(`Could not parse SHA2-256 from ${spec.asset}.dgst`);
    }
    const actual = crypto.createHash('sha256').update(zip).digest('hex');
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for ${spec.asset} (expected ${expected}, got ${actual})`);
    }

    const destFile = path.join(ROOT, 'bin', target, spec.bin);
    await extractBinary(zip, spec.bin, destFile);
    if (!spec.bin.endsWith('.exe')) {
      fs.chmodSync(destFile, 0o755);
    }
    // Version marker so the runtime resolver only uses the bundle when it matches xrayVersion.
    fs.writeFileSync(path.join(ROOT, 'bin', target, '.xray-version'), VERSION);
    console.log(`  ✓ verified + extracted -> bin/${target}/${spec.bin} (${VERSION})`);
  }
  console.log('Done. bin/ is ready to be packaged into the .vsix.');
}

main().catch((e) => {
  console.error(`download-xray failed: ${e.message}`);
  process.exit(1);
});
