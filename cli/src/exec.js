import { spawn } from 'node:child_process';
import { FAILED, NosError, USAGE } from './exit-codes.js';
import { gitEnv } from './git.js';
import { killTree } from './proc.js';
import { projectCommands } from './project-config.js';
import { runIdOf, runOfWorktree } from './runs.js';
import { withSlot } from './slots.js';

// nos exec <name>: a project command of work's nos.config.json, run in a shell in the work root.
// dev holds a slot lease until the server exits (NOS_SLOT in its env). Abilities run project commands only
// through nos exec / nos gate.
export const EXEC_COMMANDS = Object.freeze(['install', 'dev', 'deploy-test']);
const SLOTTED = new Set(['dev']);
const SIGNALS = ['SIGINT', 'SIGTERM'];

// Runs cmd and resolves with its exit code. SIGINT/SIGTERM of this process (signals) kill the child's tree.
function runChild(cmd, { cwd, env, stdio, signals }) {
  return new Promise((resolve) => {
    // a process group of its own off Windows, so killTree reaches the shell's children
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env,
      stdio,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const forward = () => killTree(child);
    for (const signal of SIGNALS) signals.on(signal, forward);
    const done = (code) => {
      for (const signal of SIGNALS) signals.off(signal, forward);
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`nos: could not start "${cmd}": ${err.message}\n`);
      done(FAILED);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? FAILED : 0)));
  });
}

// Runs project command name and resolves with the child's exit code. Unknown name -> NosError USAGE,
// null command -> NosError FAILED, dev without a free slot in time -> NosError SLOT_TIMEOUT.
// options: stdio (default 'inherit'), slot options for withSlot (pollMs, waitMs), signals (the emitter whose
// SIGINT/SIGTERM stop the child, default process).
export async function execCommand(roots, name, { stdio = 'inherit', slot: slotOptions = {}, signals = process } = {}) {
  if (!EXEC_COMMANDS.includes(name)) {
    throw new NosError(USAGE, `Unknown project command "${name}". Use one of: ${EXEC_COMMANDS.join(', ')}`);
  }
  const cmd = projectCommands(roots)[name];
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new NosError(FAILED, `project-commands.${name} is not configured in nos.config.json. Run setup`);
  }
  const env = { ...gitEnv(process.env), NOS_HOME: roots.home };
  delete env.NOS_SLOT;
  const options = { cwd: roots.work, env, stdio, signals };
  if (!SLOTTED.has(name)) return runChild(cmd, options);
  const run = runOfWorktree(roots);
  return withSlot(roots, (slot) => runChild(cmd, { ...options, env: { ...env, NOS_SLOT: String(slot) } }), {
    label: `exec ${name}`,
    holder: { run: run ? runIdOf(run) : null },
    ...slotOptions,
  });
}
