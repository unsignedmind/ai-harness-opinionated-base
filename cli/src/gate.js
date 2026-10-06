import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError } from './exit-codes.js';
import { gitEnv } from './git.js';
import { killTree } from './proc.js';
import { qualityTools } from './project-config.js';
import { slash } from './roots.js';
import { parseRunId, runIdOf, runOfWorktree, runsDir } from './runs.js';
import { withSlot } from './slots.js';

// nos gate: the quality tools of work's nos.config.json, in order test, lint, format-check, typecheck,
// additional[], then e2e (only with e2e: true). Every tool runs, also after a failure. Each runs in a shell
// in the work root with NOS_HOME (and NOS_SLOT for e2e, the only tool under a slot lease). Full output goes to
// <specs>/.runs/logs/<run|main>/<tool>.log, the result carries its last TAIL_LINES lines. A tool running longer
// than quality-tools.timeout minutes (default 30) is killed with its process tree and fails (timedOut).
export const GATE_TOOLS = Object.freeze(['test', 'lint', 'format-check', 'typecheck']);
export const TAIL_LINES = 60;
export const LOGS_DIR = 'logs';
export const DEFAULT_TIMEOUT_MIN = 30;
const SIGNALS = ['SIGINT', 'SIGTERM'];

const isSet = (cmd) => typeof cmd === 'string' && cmd.trim() !== '';

// [{ name, cmd }] in gate order; cmd null = not configured. additional: strings or { name, cmd }.
export function gateTools(tools, { e2e = false } = {}) {
  const list = GATE_TOOLS.map((name) => ({ name, cmd: isSet(tools[name]) ? tools[name] : null }));
  const additional = Array.isArray(tools.additional) ? tools.additional : [];
  additional.forEach((entry, i) => {
    const cmd = typeof entry === 'string' ? entry : entry?.cmd;
    const name =
      typeof entry?.name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(entry.name) ? entry.name : `additional-${i + 1}`;
    list.push({ name, cmd: isSet(cmd) ? cmd : null });
  });
  if (e2e) list.push({ name: 'e2e', cmd: isSet(tools.e2e) ? tools.e2e : null });
  return list;
}

// The log folder of a gate or exec: <specs>/.runs/logs/<run>, run = the given one, else the run of this
// worktree, else 'main'. Returns { runId, logDir } (logDir created unless create is false).
export function logDirOf(roots, run, { create = true } = {}) {
  const own = run ? null : runOfWorktree(roots);
  const runId = run ? parseRunId(run).runId : own ? runIdOf(own) : 'main';
  const logDir = path.join(runsDir(roots), LOGS_DIR, runId);
  if (create) mkdirSync(logDir, { recursive: true });
  return { runId, logDir };
}

const lastLines = (text, n) => {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.slice(-n).join('\n');
};

const notConfigured = (name) => ({
  name,
  cmd: null,
  status: 'not-configured',
  exit: null,
  signal: null,
  timedOut: false,
  tail: '',
  log: null,
});

// One tool, output (stdout + stderr interleaved) into its log file. ctx: { timeoutMs, running } where
// running.child is the tool in flight (the gate's signal handler kills it).
function runTool(roots, tool, logDir, ctx, slot) {
  if (!tool.cmd) return Promise.resolve(notConfigured(tool.name));
  const log = path.join(logDir, `${tool.name}.log`);
  const env = { ...gitEnv(process.env), NOS_HOME: roots.home };
  delete env.NOS_SLOT;
  if (slot != null) env.NOS_SLOT = String(slot);
  return new Promise((resolve) => {
    const fd = openSync(log, 'w');
    let child;
    let startError = null;
    let timedOut = false;
    try {
      // a process group of its own off Windows, so killTree reaches the shell's children
      child = spawn(tool.cmd, {
        shell: true,
        cwd: roots.work,
        env,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } finally {
      closeSync(fd);
    }
    ctx.running.child = child;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, ctx.timeoutMs);
    child.on('error', (err) => (startError = err));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ctx.running.child = null;
      let output = readFileSync(log, 'utf8');
      if (startError) output += `\nnos: could not start: ${startError.message}\n`;
      if (timedOut) output += `\nnos: killed after the timeout of ${ctx.timeoutMs / 60000} min\n`;
      const exit = startError ? -1 : code;
      resolve({
        name: tool.name,
        cmd: tool.cmd,
        status: exit === 0 && !timedOut ? 'pass' : 'fail',
        exit,
        signal: signal ?? null,
        timedOut,
        tail: lastLines(output, TAIL_LINES),
        log: slash(log),
      });
    });
  });
}

const timeoutOf = (tools) =>
  (typeof tools.timeout === 'number' && tools.timeout > 0 ? tools.timeout : DEFAULT_TIMEOUT_MIN) * 60_000;

// Runs the gate. options: e2e (also run e2e under a slot lease), run (run id for the log folder; default the
// run of this worktree, else 'main'), timeoutMs (per tool; default quality-tools.timeout minutes), slot options
// for withSlot (pollMs, waitMs), signals (emitter whose SIGINT/SIGTERM stop the gate, default process).
// Returns { action: 'gate', pass, tools: [{ name, cmd, status: 'pass'|'fail'|'not-configured', exit, signal,
// timedOut, tail, log }], reclaimed? } (reclaimed: { slot, holder } of a dead lease e2e took over).
// Not set up (no command configured; e2e counts only with e2e) -> NosError FAILED. No slot -> NosError
// SLOT_TIMEOUT, details.tools / details.pass of the tools run so far. SIGINT/SIGTERM -> the running tool's tree
// is killed, the lease released, NosError FAILED "gate interrupted" (details.tools).
export async function runGate(roots, { e2e = false, run, timeoutMs, slot: slotOptions = {}, signals = process } = {}) {
  const config = qualityTools(roots);
  const tools = gateTools(config, { e2e });
  if (tools.every((tool) => !tool.cmd)) {
    throw new NosError(
      FAILED,
      'quality tools are not set up: no "quality-tools" command in nos.config.json. Run setup',
    );
  }
  const { runId, logDir } = logDirOf(roots, run);
  const ctx = { timeoutMs: timeoutMs ?? timeoutOf(config), running: { child: null } };
  let interrupted = null;
  const abort = new AbortController();
  const stop = (signal) => {
    interrupted ??= signal;
    abort.abort(signal);
    if (ctx.running.child) killTree(ctx.running.child);
  };
  const handlers = SIGNALS.map((signal) => [signal, () => stop(signal)]);
  for (const [signal, handler] of handlers) signals.on(signal, handler);

  const results = [];
  const passed = () => results.every((r) => r.status !== 'fail');
  const checkInterrupt = () => {
    if (interrupted) throw new NosError(FAILED, `gate interrupted by ${interrupted}`, { tools: results });
  };
  let reclaimed = null;
  try {
    for (const tool of tools.filter((t) => t.name !== 'e2e')) {
      checkInterrupt();
      results.push(await runTool(roots, tool, logDir, ctx));
    }
    checkInterrupt();
    const tool = tools.find((t) => t.name === 'e2e');
    if (tool && !tool.cmd) results.push(notConfigured('e2e'));
    else if (tool) {
      try {
        const result = await withSlot(
          roots,
          (slot, lease) => {
            reclaimed = lease.reclaimed;
            checkInterrupt();
            return runTool(roots, tool, logDir, ctx, slot);
          },
          { label: 'gate e2e', holder: { run: runId === 'main' ? null : runId }, abort: abort.signal, ...slotOptions },
        );
        results.push(result);
      } catch (err) {
        if (err instanceof NosError) err.details = { ...err.details, tools: results, pass: passed() };
        throw err;
      }
      checkInterrupt();
    }
  } finally {
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  }
  return { action: 'gate', pass: passed(), tools: results, ...(reclaimed && { reclaimed }) };
}
