import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError } from './exit-codes.js';
import { gitEnv } from './git.js';
import { qualityTools } from './project-config.js';
import { slash } from './roots.js';
import { parseRunId, runIdOf, runOfWorktree, runsDir } from './runs.js';
import { withSlot } from './slots.js';

// nos gate: the quality tools of work's nos.config.json, in order test, lint, format-check, typecheck,
// additional[], then e2e (only with e2e: true). Every tool runs, also after a failure. Each runs in a shell
// in the work root with NOS_HOME (and NOS_SLOT for e2e, the only tool under a slot lease). Full output goes to
// <specs>/.runs/logs/<run|main>/<tool>.log, the result carries its last TAIL_LINES lines.
export const GATE_TOOLS = Object.freeze(['test', 'lint', 'format-check', 'typecheck']);
export const TAIL_LINES = 60;
export const LOGS_DIR = 'logs';

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

const lastLines = (text, n) => {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.slice(-n).join('\n');
};

// One tool, output (stdout + stderr interleaved) into its log file
function runTool(roots, tool, logDir, slot) {
  if (!tool.cmd) return { name: tool.name, cmd: null, status: 'not-configured', exit: null, tail: '', log: null };
  const log = path.join(logDir, `${tool.name}.log`);
  const env = { ...gitEnv(process.env), NOS_HOME: roots.home };
  delete env.NOS_SLOT;
  if (slot != null) env.NOS_SLOT = String(slot);
  const fd = openSync(log, 'w');
  let res;
  try {
    res = spawnSync(tool.cmd, { shell: true, cwd: roots.work, env, stdio: ['ignore', fd, fd], windowsHide: true });
  } finally {
    closeSync(fd);
  }
  let output = readFileSync(log, 'utf8');
  if (res.error) output += `\nnos: could not start: ${res.error.message}\n`;
  const exit = res.status ?? (res.error ? -1 : 1);
  return {
    name: tool.name,
    cmd: tool.cmd,
    status: exit === 0 ? 'pass' : 'fail',
    exit,
    tail: lastLines(output, TAIL_LINES),
    log: slash(log),
  };
}

// Runs the gate. options: e2e (also run e2e under a slot lease), run (run id for the log folder; default the
// run of this worktree, else 'main'), slot options for withSlot (pollMs, waitMs).
// Returns { action: 'gate', pass, tools: [{ name, cmd, status: 'pass'|'fail'|'not-configured', exit, tail, log }] }.
// Not set up (quality-tools missing or all null) -> NosError FAILED. No slot -> NosError SLOT_TIMEOUT with
// the tools run so far in details.tools.
export async function runGate(roots, { e2e = false, run, slot: slotOptions = {} } = {}) {
  const tools = gateTools(qualityTools(roots), { e2e: true });
  if (tools.every((tool) => !tool.cmd)) {
    throw new NosError(
      FAILED,
      'quality tools are not set up: no "quality-tools" command in nos.config.json. Run setup',
    );
  }
  const own = run ? null : runOfWorktree(roots);
  const runId = run ? parseRunId(run).runId : own ? runIdOf(own) : 'main';
  const logDir = path.join(runsDir(roots), LOGS_DIR, runId);
  mkdirSync(logDir, { recursive: true });

  const results = tools.filter((tool) => tool.name !== 'e2e').map((tool) => runTool(roots, tool, logDir));
  if (e2e) {
    const tool = tools.find((t) => t.name === 'e2e');
    if (!tool.cmd) results.push(runTool(roots, tool, logDir));
    else {
      try {
        results.push(
          await withSlot(roots, (slot) => runTool(roots, tool, logDir, slot), {
            label: 'gate e2e',
            holder: { run: runId === 'main' ? null : runId },
            ...slotOptions,
          }),
        );
      } catch (err) {
        if (err instanceof NosError) err.details = { ...err.details, tools: results };
        throw err;
      }
    }
  }
  return { action: 'gate', pass: results.every((r) => r.status !== 'fail'), tools: results };
}
