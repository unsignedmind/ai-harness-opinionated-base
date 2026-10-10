import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError } from './exit-codes.js';
import { deployProvider } from './deploy/index.js';
import { runChild } from './exec.js';
import { logDirOf, TAIL_LINES } from './gate.js';
import { toolEnv } from './proc.js';
import { slash } from './roots.js';

// nos deploy: build (deploy.build) and deploy work to a test environment of deploy.provider, one env per run
// (env id default = the run id of this worktree = its branch, else 'main'). Parallel runs deploy to different
// envs. Output of build and provider goes to <specs>/.runs/logs/<run>/deploy[-remove|-check].log.

const tailOf = (file) => {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.slice(-TAIL_LINES).join('\n');
};

// Runs cmd with stdout + stderr into fd; resolves with { code, stdout }.
async function runLogged(cmd, { roots, fd, env, signals }) {
  let stdout = '';
  writeSync(fd, `$ ${cmd}\n`);
  const code = await runChild(cmd, {
    cwd: roots.work,
    env: { ...toolEnv(roots.home), ...env },
    stdio: ['ignore', 'pipe', fd],
    signals,
    onSpawn: (child) =>
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        writeSync(fd, chunk);
      }),
  });
  return { code, stdout };
}

// mode: 'deploy' (default), 'remove' or 'check'. env: the env id, default the run id.
// Resolves with the JSON result. Not configured -> NosError NOT_CONFIGURED; a failed build, deploy, remove or
// check -> NosError FAILED marked report, details { provider, env, step, exit, tail, log }.
export async function runDeploy(roots, { env: rawEnv, mode = 'deploy', signals = process } = {}) {
  const { provider, build } = deployProvider(roots);
  const { runId, logDir } = logDirOf(roots);
  const env = provider.envId(rawEnv ?? runId);
  const action = mode === 'deploy' ? 'deploy' : `deploy-${mode}`;
  const base = { action, provider: provider.id, env };

  const steps =
    mode === 'check'
      ? [['check', provider.checkCmd()]]
      : mode === 'remove'
        ? [['remove', provider.removeCmd(env)]]
        : [
            ['build', build],
            ['deploy', provider.deployCmd(env)],
          ];
  const todo = steps.filter(([, cmd]) => cmd);
  if (mode !== 'deploy' && todo.length === 0) {
    return { ...base, ...(mode === 'remove' ? { removed: false } : { ok: true }), reason: 'provider has none' };
  }

  const log = path.join(logDir, `${action}.log`);
  const fd = openSync(log, 'w');
  let last = { code: 0, stdout: '' };
  let failed = null;
  try {
    for (const [step, cmd] of todo) {
      last = await runLogged(cmd, { roots, fd, env: provider.env(env), signals });
      if (last.code !== 0) {
        failed = step;
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  const fail = (message, details) => {
    const err = new NosError(FAILED, message, { ...base, ...details, tail: tailOf(log), log: slash(log) });
    err.report = true;
    return err;
  };
  if (failed) throw fail(`${action}: ${failed} failed with exit ${last.code}`, { step: failed, exit: last.code });
  if (mode === 'remove') return { ...base, removed: true, log: slash(log) };
  if (mode === 'check') return { ...base, ok: true, log: slash(log) };
  try {
    return { ...base, ...provider.parse(last.stdout), log: slash(log) };
  } catch (err) {
    throw fail(err.message, { step: 'deploy', exit: 0 });
  }
}
