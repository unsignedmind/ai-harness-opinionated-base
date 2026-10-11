import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FAILED, HELD, NosError, USAGE } from './exit-codes.js';
import { writeFileAtomic } from './fs-atomic.js';
import { isInside, slash } from './roots.js';

// Run registry: <specs>/.runs/<kind>-<id>.json, one file per running plan, quick step or POC (one writer each).
// { kind, id, domain, branch, worktree, base, mainBranch, token, started, seen, phase }
//   kind 'plan' (id = domain id) | 'quick' (id = step id) | 'poc' (id = slug, domain null: a throwaway branch,
//   never merged); worktree absolute; base = main sha the branch builds on; mainBranch = the branch of main the
//   run merges into (a POC only builds on it); token = holder (8 hex).
//   A POC keeps its notes next to its run file: <specs>/.runs/poc-<slug>.md, deleted with the run.
export const RUNS_DIR = '.runs';
export const RUN_KINDS = Object.freeze(['plan', 'quick', 'poc']);
export const RUN_PHASES = Object.freeze(['develop', 'integrate', 'gate', 'merge', 'merged', 'abandoned']);
const RUN_ID = /^(plan|quick)-([1-9]\d*)$/;
const POC_RUN_ID = /^poc-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const isRunId = (runId) => RUN_ID.test(runId) || POC_RUN_ID.test(runId);

export const runsDir = (roots) => path.join(roots.specs, RUNS_DIR);

// Step files of a plan run's parallel steps: <specs>/.runs/<run>.steps/step-<id>.json, one writer each (the
// step's agent via step-start, the merge queue), never the run file (touchSeen rewrites that one whole).
// { run, step, worktree, branch, base, phase, attempts, queuedAt?, gateTree?, created, updated }
//   phase: develop (an agent works in the worktree) | queued | rebasing | conflict (a stopped rebase: integrate)
//   | gating | blocked (a failed gate or merge: review-fixing) | merging | merged (cleanup pending)
export const STEP_PHASES = Object.freeze(['develop', 'queued', 'rebasing', 'conflict', 'gating', 'blocked', 'merging', 'merged']);
const STEP_FILE = /^step-([1-9]\d*)\.json$/;

export const stepsDir = (roots, runId) => path.join(runsDir(roots), `${parseRunId(runId).runId}.steps`);

export const stepPath = (roots, runId, step) => path.join(stepsDir(roots, runId), `step-${step}.json`);

export function readStep(roots, runId, step) {
  const file = stepPath(roots, runId, step);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
}

export function writeStep(roots, file) {
  if (!STEP_PHASES.includes(file?.phase)) {
    throw new NosError(FAILED, `Invalid step phase "${file?.phase}". Valid: ${STEP_PHASES.join(', ')}`);
  }
  const target = stepPath(roots, file.run, file.step);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, JSON.stringify(file, null, 2) + '\n');
  return target;
}

export function deleteStep(roots, runId, step) {
  rmSync(stepPath(roots, runId, step), { force: true });
  try {
    if (!readdirSync(stepsDir(roots, runId)).length) rmSync(stepsDir(roots, runId), { recursive: true, force: true });
  } catch {
    // already gone
  }
}

// Every step file of a run, sorted by step id. Unreadable files are skipped.
export function listSteps(roots, runId) {
  let names;
  try {
    names = readdirSync(stepsDir(roots, runId));
  } catch {
    return [];
  }
  const steps = [];
  for (const name of names) {
    const match = STEP_FILE.exec(name);
    if (!match) continue;
    try {
      const file = readStep(roots, runId, Number(match[1]));
      if (file) steps.push(file);
    } catch {
      // half-written: not a step anyone can act on
    }
  }
  return steps.sort((a, b) => a.step - b.step);
}

// '<kind>-<id>' -> { runId, kind, id }: id a number for plan/quick, the slug for poc; anything else is a usage
// error
export function parseRunId(runId) {
  const text = String(runId ?? '');
  const poc = POC_RUN_ID.exec(text);
  if (poc) return { runId: poc[0], kind: 'poc', id: poc[1] };
  const match = RUN_ID.exec(text);
  if (!match) {
    throw new NosError(USAGE, `Invalid run "${runId}". Use <kind>-<id>, e.g. quick-7, plan-3 or poc-dark-mode`);
  }
  return { runId: match[0], kind: match[1], id: Number(match[2]) };
}

export const runIdOf = (run) => `${run.kind}-${run.id}`;

export const runPath = (roots, runId) => path.join(runsDir(roots), `${parseRunId(runId).runId}.json`);

// The notes of a run (a POC subagent's log, survives a lost context): <specs>/.runs/<run>.md
export const notesPath = (roots, runId) => path.join(runsDir(roots), `${parseRunId(runId).runId}.md`);

// The run file, null when there is none. An unreadable file is an error (never silently replaced).
export function readRun(roots, runId) {
  const file = runPath(roots, runId);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
}

// Every run file (directory scan), sorted by run id. Unreadable files are skipped.
export function listRuns(roots) {
  let names;
  try {
    names = readdirSync(runsDir(roots));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    const runId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (!isRunId(runId)) continue;
    try {
      const run = readRun(roots, runId);
      if (run) runs.push(run);
    } catch {
      // half-written or broken file: not a run anyone can act on
    }
  }
  return runs.sort((a, b) => runIdOf(a).localeCompare(runIdOf(b), 'en', { numeric: true }));
}

// Writes the run file atomically (tmp + rename). kind, id and phase are checked. Returns the path.
export function writeRun(roots, run) {
  if (!RUN_KINDS.includes(run?.kind)) throw new NosError(FAILED, `Invalid run kind "${run?.kind}"`);
  if (run.phase != null && !RUN_PHASES.includes(run.phase)) {
    throw new NosError(FAILED, `Invalid run phase "${run.phase}". Valid: ${RUN_PHASES.join(', ')}`);
  }
  const file = runPath(roots, runIdOf(run));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(run, null, 2) + '\n');
  return file;
}

export function deleteRun(roots, runId) {
  rmSync(runPath(roots, runId), { force: true });
}

// A run token: 4 random bytes, 8 hex
export const mintToken = () => randomBytes(4).toString('hex');

const ageSec = (iso) => {
  const time = Date.parse(iso ?? '');
  return Number.isNaN(time) ? null : Math.max(0, Math.round((Date.now() - time) / 1000));
};

// The token is the holder of a run: token ?? env.NOS_RUN_TOKEN must match the run file's.
// Missing -> FAILED "--token required"; another token -> HELD { run, started, seen, ageSec }.
export function requireToken(run, token, env = process.env) {
  const given = token || env.NOS_RUN_TOKEN;
  const runId = runIdOf(run);
  if (!given) throw new NosError(FAILED, `run ${runId}: --token required (or NOS_RUN_TOKEN)`, { run: runId });
  if (given !== run.token) {
    const details = { run: runId, started: run.started ?? null, seen: run.seen ?? null, ageSec: ageSec(run.seen) };
    const age = details.ageSec == null ? '' : `, last seen ${details.ageSec}s ago`;
    throw new NosError(
      HELD,
      `run ${runId} is held by another token${age}. Take it over on purpose (--take-over)`,
      details,
    );
  }
  return given;
}

// Sets seen = now and writes the run file. Every token-bearing call does this. Returns the updated run.
export function touchSeen(roots, run) {
  const updated = { ...run, seen: new Date().toISOString() };
  writeRun(roots, updated);
  return updated;
}

function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

const inFolder = (work, folder) => {
  if (!folder || !existsSync(folder)) return false;
  const wt = real(folder);
  return samePath(wt, work) || isInside(work, wt);
};

// The run whose worktree roots.work is (or lies in), null in main or outside any run. In the worktree of a
// parallel step (step file) the run comes with "step": its id (log folder logs/<run>/step-<id>, env <run>-step-<id>).
export function runOfWorktree(roots) {
  if (!roots.inWorktree) return null;
  const work = real(roots.work);
  const runs = listRuns(roots);
  const own = runs.find((run) => inFolder(work, run.worktree));
  if (own) return own;
  for (const run of runs) {
    const step = listSteps(roots, runIdOf(run)).find((s) => inFolder(work, s.worktree));
    if (step) return { ...run, step: step.step };
  }
  return null;
}
