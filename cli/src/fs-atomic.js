import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { sleepSync } from './proc.js';

// Writes text to file via a tmp file + rename: a reader never sees half a file. On Windows a reader holding
// the target open for a moment makes rename fail with EPERM/EACCES: retried up to 20 times, 25ms apart.
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 20 || (err.code !== 'EPERM' && err.code !== 'EACCES')) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(25);
    }
  }
}
