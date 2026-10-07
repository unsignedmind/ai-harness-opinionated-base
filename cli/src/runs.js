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

// The run whose worktree roots.work is (or lies in), null in main or outside any run.
export function runOfWorktree(roots) {
  if (!roots.inWorktree) return null;
  const work = real(roots.work);
  return (
    listRuns(roots).find((run) => {
      if (!run.worktree || !existsSync(run.worktree)) return false;
      const wt = real(run.worktree);
      return samePath(wt, work) || isInside(work, wt);
    }) ?? null
  );
}
