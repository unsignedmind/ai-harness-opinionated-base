import { spawnSync } from 'node:child_process';
import { FAILED, NosError } from './exit-codes.js';

// Set by git for hooks; inherited they would point every git -C <dir> at the hook's repo.
export const REPO_ENV = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']);

// env without REPO_ENV, the env of every git child
export function gitEnv(env = process.env) {
  const clean = { ...env };
  for (const name of REPO_ENV) delete clean[name];
  return clean;
}

// git never asks: no terminal prompt, no credential manager dialog (a push without credentials fails instead)
export const NO_PROMPT_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });

// Runs git and never throws: { code, stdout, stderr, timedOut }. code -1 when git could not be started or
// ran longer than timeout ms (then killed, timedOut true). env: extra variables on top of gitEnv().
export function git(args, { cwd, timeout, env } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    env: { ...gitEnv(), ...env },
    encoding: 'utf8',
    windowsHide: true,
    ...(timeout && { timeout }),
  });
  if (res.error) {
    const timedOut = res.error.code === 'ETIMEDOUT';
    const stderr = timedOut ? `git ${args.join(' ')} timed out after ${timeout / 1000}s` : res.error.message;
    return { code: -1, stdout: res.stdout ?? '', stderr, timedOut };
  }
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut: false };
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
