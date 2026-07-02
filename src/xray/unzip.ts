import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';

/**
 * Extract selected entries (matched by basename) from a zip into destDir.
 * Returns a map of basename -> extracted absolute path. Pure-Node (yauzl).
 */
export function extractEntries(
  zipPath: string,
  wanted: string[],
  destDir: string,
): Promise<Record<string, string>> {
  const wantSet = new Set(wanted);
  const out: Record<string, string> = {};

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        return reject(err ?? new Error('Failed to open zip'));
      }
      fs.mkdirSync(destDir, { recursive: true });

      zip.on('entry', (entry: yauzl.Entry) => {
        const base = path.basename(entry.fileName);
        const isDir = /\/$/.test(entry.fileName);
        if (isDir || !wantSet.has(base)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            return reject(streamErr ?? new Error(`Failed to read ${entry.fileName}`));
          }
          const target = path.join(destDir, base);
          const ws = fs.createWriteStream(target);
          readStream.on('error', reject);
          ws.on('error', reject);
          ws.on('close', () => {
            out[base] = target;
            zip.readEntry();
          });
          readStream.pipe(ws);
        });
      });

      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
