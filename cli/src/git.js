import { spawnSync } from 'node:child_process';
import { FAILED, NosError } from './exit-codes.js';

// Runs git and never throws: { code, stdout, stderr }. code -1 when git could not be started.
export function git(args, { cwd } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.error) return { code: -1, stdout: '', stderr: res.error.message };
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// Trimmed stdout of a git command that must succeed, else a NosError (FAILED) with git's message.
export function gitOut(args, { cwd } = {}) {
  const res = git(args, { cwd });
  if (res.code !== 0) {
    throw new NosError(FAILED, `git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`, {
      cwd,
      code: res.code,
    });
  }
  return res.stdout.trim();
}

let available;
export function gitAvailable() {
  available ??= git(['--version']).code === 0;
  return available;
}
