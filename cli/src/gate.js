import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAILED, NosError } from './exit-codes.js';
import { writeFileAtomic } from './fs-atomic.js';
import { git } from './git.js';
import { killTree, toolEnv } from './proc.js';
import { qualityTools } from './project-config.js';
import { slash } from './roots.js';
import { parseRunId, runIdOf, runOfWorktree, runsDir } from './runs.js';
import { withSlot } from './slots.js';

// nos gate: the quality tools of work's nos.config.json, in order test, lint, format-check, typecheck,
// additional[], then e2e (only with e2e: true). Every tool runs, also after a failure. Each runs in a shell
// in the work root with NOS_HOME (and NOS_SLOT for e2e, the only tool under a slot lease), never with the
// caller's NODE_ENV or run token (proc.js toolEnv). Full output goes to
// <specs>/.runs/logs/<run|main>/<tool>.log, the result carries its last TAIL_LINES lines. A tool running longer
// than quality-tools.timeout minutes (default 30) is killed with its process tree and fails (timedOut).
// Cache: a tool that passed with the same command on the same content (workTreeOf) is not run again
// (cached: true, e2e then takes no slot). Passes only, kept in <logDir>/gate-cache.json for the newest
// CACHE_TREES trees. Off with the option fresh or quality-tools.cache false.
export const GATE_TOOLS = Object.freeze(['test', 'lint', 'format-check', 'typecheck']);
export const TAIL_LINES = 60;
export const LOGS_DIR = 'logs';
export const DEFAULT_TIMEOUT_MIN = 30;
export const CACHE_FILE = 'gate-cache.json';
export const CACHE_TREES = 10;
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
  cached: false,
  tail: '',
  log: null,
});

// The content id of work's checkout: the git tree of every tracked and untracked, not ignored file as it is on
// disk, uncommitted changes included, so a gate before a commit and one after it get the same id. Built in a
// copy of the index (its stat cache spares hashing unchanged files), the real index stays untouched. Ignored
// files (node_modules, .env, build output) are not part of it. null when git fails (e.g. no repo).
export function workTreeOf(roots) {
  const cwd = roots.work;
  const index = git(['rev-parse', '--git-path', 'index'], { cwd });
  if (index.code !== 0) return null;
  const tmp = path.join(os.tmpdir(), `nos-gate-index-${process.pid}-${randomBytes(3).toString('hex')}`);
  try {
    const real = path.resolve(cwd, index.stdout.trim());
    if (existsSync(real)) copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    if (git(['add', '-A'], { cwd, env }).code !== 0) return null;
    const tree = git(['write-tree'], { cwd, env });
    return tree.code === 0 ? tree.stdout.trim() : null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

const emptyCache = () => ({ version: 1, trees: {} });

// gate-cache.json: { version: 1, trees: { <tree>: { at, tools: { <name>: { cmd, at, tail } } } } }. Unreadable
// or another version -> empty.
function readCache(logDir) {
  try {
    const cache = JSON.parse(readFileSync(path.join(logDir, CACHE_FILE), 'utf8'));
    if (cache?.version === 1 && cache.trees && typeof cache.trees === 'object') return cache;
  } catch {
    // none yet, or broken: start over
  }
  return emptyCache();
}

// The passes of results under tree (also of a gate with failed tools: each tool stands for itself), only the
// newest CACHE_TREES trees kept. Best effort: a write error never fails the gate.
function saveCache(logDir, cache, tree, results) {
  const at = new Date().toISOString();
  const entry = { tools: { ...cache.trees[tree]?.tools } };
  for (const r of results) {
    if (r.status === 'pass' && !r.cached) entry.tools[r.name] = { cmd: r.cmd, at, tail: r.tail };
  }
  entry.at = at;
  const trees = { ...cache.trees, [tree]: entry };
  const newest = Object.keys(trees)
    .sort((a, b) => String(trees[b].at).localeCompare(String(trees[a].at)))
    .slice(0, CACHE_TREES);
  try {
    const kept = Object.fromEntries(newest.map((key) => [key, trees[key]]));
    writeFileAtomic(path.join(logDir, CACHE_FILE), `${JSON.stringify({ version: 1, trees: kept }, null, 2)}\n`);
  } catch {
    // the next gate runs the tools again
  }
}

// A cached pass: not run, its log says so and keeps the tail of the run that passed.
function cachedPass(tool, hit, tree, logDir) {
  const log = path.join(logDir, `${tool.name}.log`);
  writeFileSync(log, `nos: cached pass of ${hit.at} on tree ${tree}, not run again. Its last lines:\n${hit.tail}\n`);
  return {
    name: tool.name,
    cmd: tool.cmd,
    status: 'pass',
    exit: 0,
    signal: null,
    timedOut: false,
    cached: true,
    tail: hit.tail,
    log: slash(log),
  };
}

// One tool, output (stdout + stderr interleaved) into its log file. ctx: { timeoutMs, running } where
// running.child is the tool in flight (the gate's signal handler kills it).
function runTool(roots, tool, logDir, ctx, slot) {
  if (!tool.cmd) return Promise.resolve(notConfigured(tool.name));
  const log = path.join(logDir, `${tool.name}.log`);
  const env = toolEnv(roots.home);
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
        cached: false,
        tail: lastLines(output, TAIL_LINES),
        log: slash(log),
      });
    });
  });
}

const timeoutOf = (tools) =>
  (typeof tools.timeout === 'number' && tools.timeout > 0 ? tools.timeout : DEFAULT_TIMEOUT_MIN) * 60_000;

// Runs the gate. options: e2e (also run e2e under a slot lease), run (run id for the log folder; default the
// run of this worktree, else 'main'), fresh (no cache: run every tool), timeoutMs (per tool; default
// quality-tools.timeout minutes), slot options for withSlot (pollMs, waitMs), signals (emitter whose
// SIGINT/SIGTERM stop the gate, default process).
// Returns { action: 'gate', pass, cache, tree, tools: [{ name, cmd, status: 'pass'|'fail'|'not-configured',
// exit, signal, timedOut, cached, tail, log }], reclaimed? } (reclaimed: { slot, holder } of a dead lease e2e
// took over). cache: 'saved' (passes stored under tree), 'tree-changed' (the content changed while the tools
// ran: nothing stored), 'off' (fresh or quality-tools.cache false), 'unavailable' (no tree: not a git checkout).
// Not set up (no command configured; e2e counts only with e2e) -> NosError FAILED. No slot -> NosError
// SLOT_TIMEOUT, details.tools / details.pass of the tools run so far. SIGINT/SIGTERM -> the running tool's tree
// is killed, the lease released, NosError FAILED "gate interrupted" (details.tools). Both store nothing.
export async function runGate(
  roots,
  { e2e = false, run, fresh = false, timeoutMs, slot: slotOptions = {}, signals = process } = {},
) {
  const config = qualityTools(roots);
  const tools = gateTools(config, { e2e });
  if (tools.every((tool) => !tool.cmd)) {
    throw new NosError(
      FAILED,
      'quality tools are not set up: no "quality-tools" command in nos.config.json. Run setup',
    );
  }
  const { runId, logDir } = logDirOf(roots, run);
  const useCache = !fresh && config.cache !== false;
  const tree = useCache ? workTreeOf(roots) : null;
  const cache = tree ? readCache(logDir) : emptyCache();
  const hits = (tree && cache.trees[tree]?.tools) || {};
  const hitOf = (tool) => (tool.cmd && hits[tool.name]?.cmd === tool.cmd ? hits[tool.name] : null);
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
      const hit = hitOf(tool);
      results.push(hit ? cachedPass(tool, hit, tree, logDir) : await runTool(roots, tool, logDir, ctx));
    }
    checkInterrupt();
    const tool = tools.find((t) => t.name === 'e2e');
    const e2eHit = tool && hitOf(tool);
    if (tool && !tool.cmd) results.push(notConfigured('e2e'));
    else if (e2eHit) results.push(cachedPass(tool, e2eHit, tree, logDir));
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
  let state = !useCache ? 'off' : !tree ? 'unavailable' : 'saved';
  if (tree) {
    const ran = results.some((r) => r.cmd && !r.cached);
    if (ran && workTreeOf(roots) !== tree) state = 'tree-changed';
    else saveCache(logDir, cache, tree, results);
  }
  return { action: 'gate', pass: passed(), cache: state, tree, tools: results, ...(reclaimed && { reclaimed }) };
}
