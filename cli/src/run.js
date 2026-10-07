import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from './config.js';
import { CONFLICT, DIRTY, DOMAIN_RUNNING, FAILED, HELD, NosError, USAGE } from './exit-codes.js';
import { execCommand } from './exec.js';
import { runGate } from './gate.js';
import { git } from './git.js';
import { lockStatus, publicHolder, randomToken, releaseLock, takeLock } from './lock.js';
import { asList, PLAN_FILE, resolveDomain } from './plan.js';
import { projectCommands, qualityTools } from './project-config.js';
import { quickStepId, quickStepsPath, readQuickSteps } from './quick-step.js';
import { isInside, resolveRoots, slash, worktreeProjectDir } from './roots.js';
import {
  deleteRun,
  listRuns,
  mintToken,
  notesPath,
  readRun,
  requireToken,
  runIdOf,
  runOfWorktree,
  touchSeen,
  writeRun,
} from './runs.js';
import { assertSlug } from './slug.js';
import { commitSpecs } from './specs-git.js';
import { setRunStatus } from './status.js';

// The run lifecycle: nos run start | sync | finish | cleanup | abandon. A run is one plan (plan-<domain id>),
// one quick step (quick-<step id>) or one POC (poc-<slug>) in its own branch <kind>-<id> and worktree
// <main>/.claude/worktrees/<kind>-<id>. A POC has no domain and no statuses, and run commands never commit the
// specs for it: it is never merged (finish refuses it), only abandoned, which deletes worktree, branch, run file
// and notes. Its result file (<specs>/pocs/poc-<slug>-result.md) stays.
// The CLI owns every git mechanic: main is touched only here, always with git -C <main>, and moves only by
// merge --ff-only under the lock "merge".
export const WORKTREES_DIR = Object.freeze(['.claude', 'worktrees']);
export const MERGE_LOCK = 'merge';
// run start checks and creates a run under this lock (short: no install, no gate)
export const RUNS_LOCK = 'runs';
const RUNS_LOCK_WAIT_MS = 10_000;
const TERMINAL = Object.freeze(['merged', 'abandoned']);
// target statuses a run never starts on
const TERMINAL_STATUSES = Object.freeze(['merged', 'discarded']);
// REBASE_HEAD is not among them: git (2.40) leaves it behind after a finished rebase. The rebase folders tell.
const BUSY_REFS = Object.freeze(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']);
const REBASE_DIRS = Object.freeze(['rebase-merge', 'rebase-apply']);
// git never opens an editor for a rebase (GIT_EDITOR beats core.editor)
const NO_EDITOR_ENV = Object.freeze({ GIT_EDITOR: 'true' });
// Windows: a process sits in the folder or holds a file in it
const FOLDER_BUSY =
  /Permission denied|Device or resource busy|being used by another process|Invalid argument|EBUSY|EPERM/i;

// A FAILED error whose details also go to stdout as JSON (gate result, file lists for the orchestrator)
function failed(message, details) {
  const err = new NosError(FAILED, message, details);
  err.report = true;
  return err;
}

function mustGit(args, cwd, env) {
  const res = git(args, { cwd, env });
  if (res.code !== 0) {
    throw new NosError(FAILED, `git -C ${slash(cwd)} ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout.trim();
}

const ok = (args, cwd) => git(args, { cwd }).code === 0;

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

const samePath = (a, b) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

const ageSec = (iso) => {
  const time = Date.parse(iso ?? '');
  return Number.isNaN(time) ? null : Math.max(0, Math.round((Date.now() - time) / 1000));
};

// The fields of a run file a result shows (never the token: it is printed only by run start, top-level)
export function publicRun(run) {
  const { kind, id, domain, branch, worktree, base, mainBranch, phase, started, seen } = run;
  return { kind, id, domain, branch, worktree, base, mainBranch, phase, started, seen };
}

function requireGit(roots) {
  if (!roots.git) throw new NosError(FAILED, `Runs need git: ${slash(roots.main)} is not a git repo`);
}

// The top of main's git checkout (main itself unless the project is a subfolder of its repo)
const mainTopOf = (roots) => path.resolve(mustGit(['rev-parse', '--show-toplevel'], roots.main));

// <main>/.claude/worktrees/<run>: the only place EnterWorktree accepts without a prompt
export const worktreeOf = (roots, runId) => path.join(roots.main, ...WORKTREES_DIR, runId);

// The folder a session enters: the worktree + the project's offset in its repo
export const enterOf = (roots, run) => worktreeProjectDir(roots, path.resolve(run.worktree));

// Roots as a session inside the run's worktree sees them (quality tools and project commands of the branch)
const worktreeRoots = (roots, run) => resolveRoots({ root: enterOf(roots, run), env: {}, home: roots.home });

// Lines of a -z git output
const zList = (out) => out.split('\0').filter(Boolean);

// git status --porcelain -z --untracked-files=all of a checkout: paths relative to its top (renames: both names)
function changedFiles(top) {
  const res = git(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: top });
  if (res.code !== 0) throw new NosError(FAILED, `git status failed in ${slash(top)}: ${res.stderr.trim()}`);
  const parts = res.stdout.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') files.push(parts[++i]);
  }
  return [...new Set(files.filter(Boolean))];
}

// { files (relative to top), paths (absolute) } of a file list
const fileList = (top, files) => ({ files, paths: files.map((file) => slash(path.join(top, file))) });

// The unmerged files of a stopped rebase
const unmergedFiles = (top) => zList(git(['diff', '--name-only', '-z', '--diff-filter=U'], { cwd: top }).stdout);

// A rebase is stopped in this checkout: a rebase-merge / rebase-apply folder in its git dir (a worktree has its
// own git dir under <common>/worktrees/<name>). Not REBASE_HEAD: git leaves it behind after a finished rebase.
function rebaseInProgress(top) {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: top }).stdout.trim();
  return Boolean(gitDir) && REBASE_DIRS.some((dir) => existsSync(path.join(gitDir, dir)));
}

const currentBranch = (top) => {
  const res = git(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: top });
  return res.code === 0 ? res.stdout.trim() : null;
};

const branchExists = (top, branch) => ok(['rev-parse', '-q', '--verify', `refs/heads/${branch}`], top);

// The entry of `git worktree list` for this folder, null when git does not know it
function registeredWorktree(mainTop, wt) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd: mainTop }).stdout;
  const paths = out
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  return paths.find((p) => samePath(p, wt)) ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// The target of a run: the plan (plan.json) or the quick step entry (quick-steps.json)

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
}

// { file, data, item, label }; item.status is the target's status
function targetOf(roots, { domain, kind, id }) {
  const domainDir = path.join(roots.specs, domain);
  if (kind === 'plan') {
    const file = path.join(domainDir, PLAN_FILE);
    if (!existsSync(file)) throw new NosError(FAILED, `Domain ${domain} has no plan.json. Run create-plan first`);
    const data = readJson(file);
    return { file, data, item: data, label: `plan of ${domain}` };
  }
  const data = readQuickSteps(domainDir);
  const item = data.find((step) => quickStepId(step) === id);
  if (!item) throw new NosError(FAILED, `Quick step ${id} is not in ${slash(quickStepsPath(domainDir))}`);
  return { file: quickStepsPath(domainDir), data, item, label: `quick step ${id}` };
}

// plan.json / the quick step entry gets "branch" (display only, stays as history)
function writeBranch(target, branch) {
  if (target.item.branch === branch) return false;
  target.item.branch = branch;
  writeJsonFile(target.file, target.data);
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Which run a token-bearing command acts on

// --run, else the run of the worktree the caller sits in, else the run holding the token. The token must match
// (requireToken: missing -> 1, another -> 4). Updates seen. Returns the run.
export function resolveRun(roots, { run: runId, token, env = process.env } = {}) {
  const given = token || env.NOS_RUN_TOKEN;
  let run;
  if (runId) {
    run = readRun(roots, runId);
    if (!run) throw new NosError(FAILED, `No run ${runId} in ${slash(path.join(roots.specs, '.runs'))}`);
  } else {
    run = runOfWorktree(roots) ?? (given ? listRuns(roots).find((r) => r.token === given) : null);
    if (!run) {
      throw new NosError(
        FAILED,
        given
          ? "No run holds this token. Pass --run <kind>-<id>, or run the command inside the run's worktree"
          : "No run here: run the command inside the run's worktree, or pass --run <kind>-<id> and --token <t>",
      );
    }
  }
  requireToken(run, token, env);
  return touchSeen(roots, run);
}

function heldBy(run) {
  const runId = runIdOf(run);
  const details = {
    run: runId,
    domain: run.domain,
    phase: run.phase,
    started: run.started ?? null,
    seen: run.seen ?? null,
    ageSec: ageSec(run.seen),
  };
  const age = details.ageSec == null ? '' : `, last seen ${details.ageSec}s ago`;
  return new NosError(
    HELD,
    `run ${runId} is held by another token${age}. Take it over on purpose (--take-over)`,
    details,
  );
}

// The cwd of the caller must not lie in the worktree: Windows cannot delete a folder a process sits in
function refuseInside(cwd, run) {
  const wt = real(run.worktree);
  const here = real(cwd);
  if (samePath(here, wt) || isInside(here, wt)) {
    throw new NosError(
      FAILED,
      `The current directory ${slash(here)} is inside the worktree of ${runIdOf(run)}: ExitWorktree (keep) first, ` +
        'then run this from main',
      { run: runIdOf(run), worktree: run.worktree, cwd: slash(here) },
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// run start

function parseStepId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value).trim()) {
    throw new NosError(USAGE, `Invalid --quick "${value}". Use a step id (a positive whole number)`);
  }
  return id;
}

// Uncommitted specs of the domain (a session that died before its specs commit) -> "<run>: leftovers"
function commitLeftovers(roots, runId, domain) {
  const res = git(['status', '--porcelain', '--untracked-files=all', '--', domain], { cwd: roots.specs });
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const commit = commitSpecs(roots, { domain, message: `${runId}: leftovers` });
  if (commit.warning) process.stderr.write(`nos: warning: ${commit.warning}\n`);
  return { committed: commit.committed, sha: commit.sha, files: commit.files };
}

// Adds the worktree when git does not have it (reuses the branch, else creates it from mainBranch).
// Returns { created, branchCreated }.
function addWorktree(mainTop, { wt, branch, mainBranch }) {
  const known = registeredWorktree(mainTop, wt);
  if (known && existsSync(wt)) return { created: false, branchCreated: false };
  // known but the folder is gone (deleted by hand): forget it first
  if (known) git(['worktree', 'prune'], { cwd: mainTop });
  if (existsSync(wt)) {
    throw new NosError(FAILED, `${slash(wt)} exists but is not a worktree of the project. Move it away and retry`);
  }
  mkdirSync(path.dirname(wt), { recursive: true });
  const reuse = branchExists(mainTop, branch);
  const add = reuse ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, mainBranch];
  // Windows: deep node_modules / test paths of a branch exceed MAX_PATH without core.longpaths
  const res = git(['-c', 'core.longpaths=true', ...add], { cwd: mainTop });
  if (res.code !== 0) {
    const message = (res.stderr || res.stdout).trim();
    const hint = /Filename too long/i.test(message)
      ? '. Paths are too long for Windows: git config --global core.longpaths true, or a shorter project path'
      : '';
    throw new NosError(FAILED, `git worktree add ${slash(wt)} failed: ${message}${hint}`, { worktree: slash(wt) });
  }
  return { created: true, branchCreated: !reuse };
}

async function install(roots, run) {
  const wtRoots = worktreeRoots(roots, run);
  const cmd = projectCommands(wtRoots).install;
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  try {
    const result = await execCommand(wtRoots, 'install', { stdio: 'log', run: runIdOf(run) });
    return { code: result.code, log: result.log };
  } catch (err) {
    return { code: err instanceof NosError ? err.code : FAILED, log: null, error: err.message };
  }
}

// The merge lock of a crashed finish of this run (taken with token) is released: the holder is declared gone
// --take-over: the merge lock of the old token is released, unless the old holder's finish still runs (pid
// alive) -> HELD
function takeOverMergeLock(roots, run) {
  const status = lockStatus(roots, MERGE_LOCK);
  if (status.holder?.token !== run.token) return;
  if (status.pidAlive) {
    throw new NosError(
      HELD,
      `A finish of the old holder of ${runIdOf(run)} is still running (pid ${status.holder.pid}): wait for it`,
      {
        run: runIdOf(run),
        lock: MERGE_LOCK,
        holder: publicHolder(status.holder),
        ageSec: status.ageSec,
        pidAlive: true,
      },
    );
  }
  releaseLock(roots, MERGE_LOCK, run.token);
}

function releaseOwnMergeLock(roots, token) {
  if (lockStatus(roots, MERGE_LOCK).holder?.token !== token) return false;
  return releaseLock(roots, MERGE_LOCK, token).released;
}

function startResult(roots, run, { install: installed = null, leftovers = null, warnings = [] } = {}) {
  const enter = slash(enterOf(roots, run));
  return {
    action: 'run-start',
    run: publicRun(run),
    token: run.token,
    roots: { home: slash(roots.home), work: enter, main: slash(roots.main), specs: slash(roots.specs) },
    enter,
    install: installed,
    leftovers,
    ...(warnings.length && { warnings }),
  };
}

// --poc <slug>: lowercase kebab-case, else a usage error
function parsePocSlug(value) {
  try {
    return assertSlug(value, '--poc');
  } catch (err) {
    throw new NosError(USAGE, err.message);
  }
}

// nos run start --domain <d> (--plan | --quick <id>) [--token t] [--take-over]
// nos run start --poc <slug> [--token t] [--take-over]: no domain, no target, no statuses
export async function startRun(
  roots,
  { domain, plan = false, quick, poc, token, takeOver = false, env = process.env } = {},
) {
  requireGit(roots);
  let kind;
  let id;
  if (poc != null) {
    if (domain != null || plan || quick != null) {
      throw new NosError(USAGE, 'run start --poc takes no --domain, --plan or --quick');
    }
    kind = 'poc';
    id = parsePocSlug(poc);
    domain = null;
  } else {
    if (Boolean(plan) === (quick != null)) {
      throw new NosError(USAGE, 'Give exactly one of --plan, --quick <stepId>, --poc <slug>');
    }
    resolveDomain(roots, domain, 'run start');
    kind = plan ? 'plan' : 'quick';
    id = plan ? Number(/^domain-(\d+)-/.exec(domain)[1]) : parseStepId(quick);
  }
  const runId = `${kind}-${id}`;
  const given = token || env.NOS_RUN_TOKEN;

  // check-and-create under lock runs: two sessions never both start a run of one target or one domain
  const lockToken = randomToken();
  takeLock(roots, RUNS_LOCK, { run: runId, token: lockToken, command: 'run start' }, { waitMs: RUNS_LOCK_WAIT_MS });
  let started;
  try {
    started = startLocked(roots, { domain, kind, id, runId, given, takeOver });
  } finally {
    releaseLock(roots, RUNS_LOCK, lockToken);
  }
  if (started.done) return started.done;
  const { run, created, leftovers, warnings } = started;
  const installed = created ? await install(roots, run) : null;
  return startResult(roots, run, { install: installed, leftovers, warnings });
}

// A finish or abandon of this run crashed between set-status --run and the phase change: the target is merged
// while the phase is merge, or discarded while the phase is not yet abandoned
function statusesFlipped(roots, run) {
  if (run.kind === 'poc') return false;
  let status;
  try {
    status = targetOf(roots, run).item.status;
  } catch {
    return false;
  }
  return (status === 'merged' && run.phase === 'merge') || (status === 'discarded' && run.phase !== 'abandoned');
}

// The part of run start under lock runs. Returns { done } (merged/abandoned run: token only) or
// { run, created, leftovers, warnings }.
function startLocked(roots, { domain, kind, id, runId, given, takeOver }) {
  const now = () => new Date().toISOString();
  const existing = readRun(roots, runId);
  if (existing) {
    if (existing.domain !== domain) {
      throw new NosError(FAILED, `Run ${runId} belongs to ${existing.domain}, not ${domain}`);
    }
    if (!takeOver && given !== existing.token) throw heldBy(existing);
    if (takeOver) takeOverMergeLock(roots, existing);
    // merged or abandoned: only the token (a session without it reaches run cleanup), no git work. Also a finish /
    // abandon that crashed after the statuses flipped (merged + phase merge, discarded + phase not abandoned):
    // only the token, so run finish / run abandon completes it.
    if (TERMINAL.includes(existing.phase) || statusesFlipped(roots, existing)) {
      const run = { ...existing, token: takeOver ? mintToken() : existing.token, seen: now() };
      writeRun(roots, run);
      return { done: startResult(roots, run) };
    }
  }

  // one run per domain; a POC has none and runs next to anything
  const other = domain != null && listRuns(roots).find((r) => r.domain === domain && runIdOf(r) !== runId);
  if (other) {
    throw new NosError(
      DOMAIN_RUNNING,
      `Domain ${domain} already has run ${runIdOf(other)} (phase ${other.phase}). One run per domain`,
      {
        run: runIdOf(other),
        domain,
        phase: other.phase,
        branch: other.branch,
        worktree: other.worktree,
        started: other.started ?? null,
        seen: other.seen ?? null,
        ageSec: ageSec(other.seen),
      },
    );
  }

  // a POC has no target, no statuses and no specs of its own
  const target = kind === 'poc' ? null : targetOf(roots, { domain, kind, id });
  if (target) {
    const status = target.item.status;
    if (kind === 'plan' && !asList(target.data.phases).length) {
      throw new NosError(FAILED, `The plan of ${domain} has no phases. Plan it first`);
    }
    if (TERMINAL_STATUSES.includes(status)) {
      throw new NosError(FAILED, `The ${target.label} is ${status}: nothing to run`);
    }
  }

  const leftovers = target ? commitLeftovers(roots, runId, domain) : null;
  const mainTop = mainTopOf(roots);
  const mainBranch = existing?.mainBranch ?? currentBranch(mainTop);
  if (!mainBranch) throw new NosError(FAILED, `${slash(mainTop)} has a detached HEAD: check out the main branch first`);
  const branch = existing?.branch ?? runId;
  const wt = existing?.worktree ? path.resolve(existing.worktree) : worktreeOf(roots, runId);
  const warnings = [];
  if (!ok(['check-ignore', '-q', '--', wt], mainTop)) {
    warnings.push(
      `${slash(wt)} is not ignored by the project's .gitignore: add ".claude/worktrees/" (nos init does it)`,
    );
  }
  const added = addWorktree(mainTop, { wt, branch, mainBranch });

  let run;
  if (existing) {
    run = { ...existing, token: takeOver ? mintToken() : existing.token, seen: now() };
  } else {
    const base = added.branchCreated
      ? mustGit(['rev-parse', mainBranch], mainTop)
      : mustGit(['merge-base', mainBranch, branch], mainTop);
    const time = now();
    run = {
      kind,
      id,
      domain,
      branch,
      worktree: slash(wt),
      base,
      mainBranch,
      token: mintToken(),
      started: time,
      seen: time,
      phase: 'develop',
    };
  }
  writeRun(roots, run);
  if (target) writeBranch(target, branch);
  return { run, created: added.created, leftovers, warnings };
}

// ---------------------------------------------------------------------------------------------------------
// run sync

function requireWorktree(run) {
  const wt = path.resolve(run.worktree);
  if (!existsSync(wt)) {
    throw new NosError(
      FAILED,
      `The worktree ${run.worktree} of ${runIdOf(run)} is missing. nos run start --token <t> recreates it`,
    );
  }
  return wt;
}

function conflictError(run, wt, message) {
  return new NosError(CONFLICT, message, {
    run: runIdOf(run),
    worktree: slash(wt),
    branch: run.branch,
    mainBranch: run.mainBranch,
    rebaseInProgress: true,
    ...fileList(wt, unmergedFiles(wt)),
  });
}

// Rebases the run branch onto mainBranch in the worktree. Rebase stopped -> CONFLICT (left open), dirty -> DIRTY.
// Returns { base, ahead, behind, rebased }.
function syncWorktree(run) {
  const wt = requireWorktree(run);
  const runId = runIdOf(run);
  if (rebaseInProgress(wt)) {
    throw conflictError(
      run,
      wt,
      `A rebase is in progress in ${slash(wt)}: resolve it (ability integrate), then repeat`,
    );
  }
  const dirty = changedFiles(wt);
  if (dirty.length) {
    throw new NosError(DIRTY, `The worktree of ${runId} has uncommitted changes: commit them or remove them`, {
      run: runId,
      worktree: slash(wt),
      ...fileList(wt, dirty),
    });
  }
  const on = currentBranch(wt);
  if (on !== run.branch) {
    throw new NosError(FAILED, `The worktree of ${runId} is on ${on ?? 'a detached HEAD'}, expected ${run.branch}`);
  }
  const before = mustGit(['rev-parse', 'HEAD'], wt);
  const res = git(['-c', 'core.editor=true', 'rebase', '--no-autostash', run.mainBranch], {
    cwd: wt,
    env: NO_EDITOR_ENV,
  });
  if (res.code !== 0) {
    if (rebaseInProgress(wt)) {
      throw conflictError(
        run,
        wt,
        `Rebase of ${run.branch} onto ${run.mainBranch} stopped on conflicts. It is left open for the ability integrate`,
      );
    }
    throw new NosError(
      FAILED,
      `git rebase ${run.mainBranch} failed in ${slash(wt)}: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  const after = mustGit(['rev-parse', 'HEAD'], wt);
  const base = mustGit(['rev-parse', run.mainBranch], wt);
  const [behind, ahead] = mustGit(['rev-list', '--left-right', '--count', `${run.mainBranch}...HEAD`], wt)
    .split(/\s+/)
    .map(Number);
  return { base, ahead, behind, rebased: before !== after };
}

function requireActive(run, command) {
  if (TERMINAL.includes(run.phase)) {
    throw new NosError(FAILED, `Run ${runIdOf(run)} is ${run.phase}: no ${command}. nos run cleanup removes it`);
  }
}

// nos run sync --token t
export function syncRun(roots, options = {}) {
  let run = resolveRun(roots, options);
  requireActive(run, 'sync');
  const sync = syncWorktree(run);
  run = { ...run, base: sync.base };
  writeRun(roots, run);
  return { action: 'run-sync', run: publicRun(run), ...sync };
}

// ---------------------------------------------------------------------------------------------------------
// run finish

function checkMainBranch(mainTop, run) {
  const on = currentBranch(mainTop);
  if (on !== run.mainBranch) {
    throw failed(`main checkout is on ${on ?? 'a detached HEAD'}, expected ${run.mainBranch}`, {
      run: runIdOf(run),
      main: slash(mainTop),
      current: on,
      mainBranch: run.mainBranch,
    });
  }
}

// MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD (one rev-parse each) and the rebase folders of main
function checkMainBusy(mainTop, run) {
  const busy = BUSY_REFS.filter((ref) => ok(['rev-parse', '-q', '--verify', ref], mainTop));
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: mainTop }).stdout.trim();
  if (gitDir) busy.push(...REBASE_DIRS.filter((dir) => existsSync(path.join(gitDir, dir))));
  if (busy.length) {
    throw failed(`main is busy (${busy.join(', ')}): finish or abort that in ${slash(mainTop)} first`, {
      run: runIdOf(run),
      main: slash(mainTop),
      busy,
    });
  }
}

// Uncommitted changes of main on the paths the branch touches (both names of a rename) would block or be
// overwritten by the merge
function checkMainClean(mainTop, run) {
  const touched = zList(
    mustGit(['diff', '--name-only', '-z', '--no-renames', `${run.mainBranch}...${run.branch}`], mainTop),
  );
  if (!touched.length) return;
  const set = new Set(touched);
  const dirty = changedFiles(mainTop).filter((file) => set.has(file));
  if (dirty.length) {
    throw failed(`main has uncommitted changes on paths ${run.branch} touches: commit or remove them in main`, {
      run: runIdOf(run),
      main: slash(mainTop),
      ...fileList(mainTop, dirty),
    });
  }
}

const isAncestor = (top, a, b) => ok(['merge-base', '--is-ancestor', a, b], top);

const hasE2e = (roots) => {
  const e2e = qualityTools(roots).e2e;
  return typeof e2e === 'string' && e2e.trim() !== '';
};

// nos run finish --token t: under lock merge: phase integrate, main busy / main clean prechecks, sync, phase
// gate (full gate, e2e when configured), phase merge (merge --ff-only; refused -> back to sync once), statuses
// merged + specs commit, phase merged. A failure releases the lock and parks the run in phase develop; a crash
// leaves lock and phase, the same token resumes (phase merge with the branch already in main -> statuses).
// gate: options for runGate (tests).
export async function finishRun(roots, { gate: gateOptions = {}, ...options } = {}) {
  let run = resolveRun(roots, options);
  const runId = runIdOf(run);
  if (run.kind === 'poc') throw new NosError(FAILED, `${runId}: a POC is never merged: nos run abandon`);
  if (run.phase === 'abandoned') throw new NosError(FAILED, `Run ${runId} is abandoned: nothing to finish`);
  if (run.phase === 'merged') {
    releaseOwnMergeLock(roots, run.token);
    return { action: 'run-finish', run: publicRun(run), merged: true, already: true };
  }
  const target = targetOf(roots, run);
  const status = target.item.status;
  if (!(status === 'done' || (status === 'merged' && run.phase === 'merge'))) {
    throw new NosError(FAILED, `The ${target.label} is ${status ?? 'without status'}: finish needs done`);
  }
  // violations surface before main moves
  setRunStatus(roots, { run: runId, status: 'merged', dryRun: true });

  takeLock(roots, MERGE_LOCK, { run: runId, token: run.token, command: 'run finish' });
  const resumedFrom = run.phase === 'develop' ? null : run.phase;
  const setPhase = (phase, extra = {}) => {
    run = { ...run, ...extra, phase };
    writeRun(roots, run);
  };
  let inMain = false;
  try {
    const mainTop = mainTopOf(roots);
    let gate = null;
    inMain = run.phase === 'merge' && isAncestor(mainTop, run.branch, run.mainBranch);
    for (let attempt = 1; !inMain; attempt++) {
      setPhase('integrate');
      checkMainBranch(mainTop, run);
      checkMainBusy(mainTop, run);
      checkMainClean(mainTop, run);
      const sync = syncWorktree(run);
      setPhase('gate', { base: sync.base });
      const wtRoots = worktreeRoots(roots, run);
      gate = await runGate(wtRoots, { e2e: hasE2e(wtRoots), run: runId, ...gateOptions });
      if (!gate.pass) {
        const names = gate.tools.filter((tool) => tool.status === 'fail').map((tool) => tool.name);
        throw failed(`gate failed: ${names.join(', ')}`, { run: runId, gate });
      }
      setPhase('merge');
      const merge = git(['merge', '--ff-only', run.branch], { cwd: mainTop });
      if (merge.code === 0) inMain = true;
      else if (attempt >= 2) {
        const message = (merge.stderr || merge.stdout).trim();
        throw failed(`git merge --ff-only ${run.branch} was refused twice: ${message}`, { run: runId, git: message });
      }
    }
    const statuses = setRunStatus(roots, { run: runId, status: 'merged' });
    const commit = commitSpecs(roots, { domain: run.domain, message: `${runId}: merged` });
    if (commit.warning) process.stderr.write(`nos: warning: ${commit.warning}\n`);
    setPhase('merged');
    return {
      action: 'run-finish',
      run: publicRun(run),
      merged: true,
      mainBranch: run.mainBranch,
      head: mustGit(['rev-parse', run.mainBranch], mainTop),
      resumedFrom,
      gate,
      statuses,
      specs: { committed: commit.committed, sha: commit.sha },
    };
  } catch (err) {
    // parked: back to develop. Once the branch is in main the phase stays merge, a rerun completes it
    if (!inMain) {
      try {
        setPhase('develop');
      } catch {
        // the error that got us here is the one to report
      }
    }
    throw err;
  } finally {
    try {
      releaseLock(roots, MERGE_LOCK, run.token);
    } catch {
      // broken and taken by someone else meanwhile: not ours to release
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// run cleanup / abandon

function busyError(wt, message) {
  return new NosError(
    FAILED,
    `a process (dev server, terminal, editor) still uses ${slash(wt)}; stop it and rerun nos run cleanup`,
    { worktree: slash(wt), git: message },
  );
}

// git worktree remove. Merged: untracked files (gate output, build artefacts) are no reason to keep it -> --force,
// but modified tracked files are -> DIRTY with the list. Abandoned: always --force.
function removeWorktree(mainTop, run, wt, force) {
  const remove = (withForce) => git(['worktree', 'remove', ...(withForce ? ['--force'] : []), wt], { cwd: mainTop });
  let res = remove(force);
  let message = (res.stderr || res.stdout).trim();
  if (res.code !== 0 && /contains modified or untracked files/i.test(message)) {
    const tracked = git(['status', '--porcelain', '-z', '--untracked-files=no'], { cwd: wt });
    const modified = zList(tracked.stdout).map((entry) => entry.slice(3));
    if (tracked.code === 0 && !modified.length) {
      res = remove(true);
      message = (res.stderr || res.stdout).trim();
    } else {
      throw new NosError(DIRTY, `The worktree of ${runIdOf(run)} has modified files: commit or revert them first`, {
        run: runIdOf(run),
        worktree: slash(wt),
        ...fileList(wt, modified),
      });
    }
  }
  if (res.code === 0) return;
  if (FOLDER_BUSY.test(message)) throw busyError(wt, message);
  throw new NosError(FAILED, `git worktree remove ${slash(wt)} failed: ${message}`, { worktree: slash(wt) });
}

// Removes worktree, branch (-D: merged into mainBranch, or abandoned), run file and notes (<specs>/.runs/<run>.md,
// a POC's). Each part is skipped when already gone, so a cleanup that failed half way is simply rerun.
// Returns { worktree, branch, runFile, notes? } (true = removed now; notes only when there were some).
function removeRun(roots, run) {
  const mainTop = mainTopOf(roots);
  const wt = path.resolve(run.worktree);
  const force = run.phase === 'abandoned';
  releaseOwnMergeLock(roots, run.token);
  let worktree = false;
  if (registeredWorktree(mainTop, wt)) {
    removeWorktree(mainTop, run, wt, force);
    worktree = true;
  } else if (existsSync(wt)) {
    // left behind by a removal that failed half way: git no longer knows it
    try {
      rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      throw busyError(wt, err.message);
    }
    worktree = true;
  }
  git(['worktree', 'prune'], { cwd: mainTop });
  let branch = false;
  if (branchExists(mainTop, run.branch)) {
    // merged: the branch is in mainBranch, so -D is safe also when main's checkout moved to another branch
    // (-d checks against HEAD). Not in mainBranch (someone reset it) -> refused, the user decides
    if (!force && !isAncestor(mainTop, run.branch, run.mainBranch)) {
      throw new NosError(
        FAILED,
        `Branch ${run.branch} is not in ${run.mainBranch} although ${runIdOf(run)} is merged: ` +
          `check ${run.mainBranch}, then git branch -D ${run.branch} by hand`,
        { run: runIdOf(run), branch: run.branch, mainBranch: run.mainBranch },
      );
    }
    mustGit(['branch', '-D', run.branch], mainTop);
    branch = true;
  }
  const notesFile = notesPath(roots, runIdOf(run));
  const notes = existsSync(notesFile);
  if (notes) rmSync(notesFile, { force: true });
  deleteRun(roots, runIdOf(run));
  return { worktree, branch, runFile: true, ...(notes && { notes: true }) };
}

// nos run cleanup --token t: from main, phase merged or abandoned
export function cleanupRun(roots, { cwd = process.cwd(), ...options } = {}) {
  const run = resolveRun(roots, options);
  if (!TERMINAL.includes(run.phase)) {
    throw new NosError(
      FAILED,
      `Run ${runIdOf(run)} is in phase ${run.phase}: cleanup needs merged or abandoned (nos run finish or nos run abandon)`,
    );
  }
  refuseInside(cwd, run);
  return { action: 'run-cleanup', run: publicRun(run), removed: removeRun(roots, run) };
}

// nos run abandon --token t: statuses discarded + specs commit + phase abandoned (written before the cleanup,
// so a failed cleanup is retried with nos run cleanup), then the cleanup with --force / -D.
// POC: no statuses, no specs commit (statuses and specs null); its result file in <specs>/pocs stays.
export function abandonRun(roots, { cwd = process.cwd(), ...options } = {}) {
  let run = resolveRun(roots, options);
  const runId = runIdOf(run);
  if (run.phase === 'merged') throw new NosError(FAILED, `Run ${runId} is merged: nos run cleanup removes it`);
  // a finish crashed after the ff merge: the code is in main, discarding the specs would lie
  if (run.phase === 'merge' && isAncestor(mainTopOf(roots), run.branch, run.mainBranch)) {
    throw new NosError(FAILED, `Run ${runId} is already in ${run.mainBranch}: run nos run finish to complete it`);
  }
  refuseInside(cwd, run);
  let statuses = null;
  let specs = null;
  if (run.phase !== 'abandoned' && run.kind === 'poc') {
    run = { ...run, phase: 'abandoned' };
    writeRun(roots, run);
  } else if (run.phase !== 'abandoned') {
    statuses = setRunStatus(roots, { run: runId, status: 'discarded' });
    const commit = commitSpecs(roots, { domain: run.domain, message: `${runId}: discarded` });
    if (commit.warning) process.stderr.write(`nos: warning: ${commit.warning}\n`);
    specs = { committed: commit.committed, sha: commit.sha };
    run = { ...run, phase: 'abandoned' };
    writeRun(roots, run);
  }
  return { action: 'run-abandon', run: publicRun(run), removed: removeRun(roots, run), statuses, specs };
}
