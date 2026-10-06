import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError, USAGE } from './exit-codes.js';
import { logDirOf } from './gate.js';
import { gitEnv } from './git.js';
import { killTree } from './proc.js';
import { projectCommands } from './project-config.js';
import { slash } from './roots.js';
import { withSlot } from './slots.js';

// nos exec <name>: a project command of work's nos.config.json, run in a shell in the work root.
// dev holds a slot lease until the server exits (NOS_SLOT in its env). Abilities run project commands only
// through nos exec / nos gate.
export const EXEC_COMMANDS = Object.freeze(['install', 'dev', 'deploy-test']);
const SLOTTED = new Set(['dev']);
const SIGNALS = ['SIGINT', 'SIGTERM'];
// the shell convention 128 + signal number
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

// Runs cmd and resolves with its exit code. SIGINT/SIGTERM of signals kill the child's tree; the exit code is
// then 130 / 143 (also for a child ended by such a signal; another signal -> 1).
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
    let received = null;
    const handlers = SIGNALS.map((signal) => [
      signal,
      () => {
        received ??= signal;
        killTree(child);
      },
    ]);
    for (const [signal, handler] of handlers) signals.on(signal, handler);
    const done = (code) => {
      for (const [signal, handler] of handlers) signals.off(signal, handler);
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`nos: could not start "${cmd}": ${err.message}\n`);
      done(FAILED);
    });
    child.on('exit', (code, signal) => {
      const by = received ?? signal;
      done(by ? (SIGNAL_EXIT[by] ?? FAILED) : (code ?? FAILED));
    });
  });
}

// Runs project command name. Unknown name -> NosError USAGE, null command -> NosError FAILED, dev without a
// free slot in time -> NosError SLOT_TIMEOUT.
// options: stdio ('inherit' default, any spawn stdio, or 'log': output to <specs>/.runs/logs/<run>/<name>.log),
// run (run id for the log folder; default the run of this worktree, else 'main'), slot options for withSlot
// (pollMs, waitMs), signals (the emitter whose SIGINT/SIGTERM stop the child, default process).
// Resolves with the exit code; with stdio 'log' with { code, log, reclaimed? }. A dead dev lease taken over
// is reported on stderr (and as reclaimed: { slot, holder } with 'log').
export async function execCommand(
  roots,
  name,
  { stdio = 'inherit', run, slot: slotOptions = {}, signals = process } = {},
) {
  if (!EXEC_COMMANDS.includes(name)) {
    throw new NosError(USAGE, `Unknown project command "${name}". Use one of: ${EXEC_COMMANDS.join(', ')}`);
  }
  const cmd = projectCommands(roots)[name];
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new NosError(FAILED, `project-commands.${name} is not configured in nos.config.json. Run setup`);
  }
  const env = { ...gitEnv(process.env), NOS_HOME: roots.home };
  delete env.NOS_SLOT;
  const toLog = stdio === 'log';
  const { runId, logDir } = logDirOf(roots, run, { create: toLog });
  const log = toLog ? path.join(logDir, `${name}.log`) : null;
  let reclaimed = null;

  const start = async (extraEnv) => {
    const fd = toLog ? openSync(log, 'w') : null;
    try {
      const childStdio = toLog ? ['ignore', fd, fd] : stdio;
      return await runChild(cmd, { cwd: roots.work, env: { ...env, ...extraEnv }, stdio: childStdio, signals });
    } finally {
      if (fd !== null) closeSync(fd);
    }
  };

  const code = !SLOTTED.has(name)
    ? await start({})
    : await withSlot(
        roots,
        (slot, lease) => {
          reclaimed = lease.reclaimed;
          if (reclaimed) {
            const h = reclaimed.holder;
            process.stderr.write(
              `nos: reclaimed slot-${slot} from a lease whose process is gone (pid ${h.pid}, ${h.command ?? '?'})\n`,
            );
          }
          return start({ NOS_SLOT: String(slot) });
        },
        { label: `exec ${name}`, holder: { run: runId === 'main' ? null : runId }, ...slotOptions },
      );
  return toLog ? { code, log: slash(log), ...(reclaimed && { reclaimed }) } : code;
}
