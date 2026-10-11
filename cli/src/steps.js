import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runDeploy } from './deploy.js';
import { CONFLICT, DIRTY, FAILED, HELD, NOT_CONFIGURED, NosError, USAGE } from './exit-codes.js';
import { execCommand } from './exec.js';
import { logDirOf, readCacheEntry, runGate, saveCacheEntry } from './gate.js';
import { git } from './git.js';
import { asList, PLAN_FILE } from './plan.js';
import { parallelConfig, projectCommands } from './project-config.js';
import { isInside, resolveRoots, slash } from './roots.js';
import {
  branchExists,
  changedFiles,
  currentBranch,
  fileList,
  hasE2e,
  mainTopOf,
  modifiedTracked,
  mustGit,
  NO_EDITOR_ENV,
  publicRun,
  rebaseInProgress,
  registeredWorktree,
  removeWorktreeDir,
  requireActive,
  resolveRun,
  unmergedFiles,
} from './run.js';
import { deleteStep, listSteps, readStep, runIdOf, STEP_PHASES, writeRun, writeStep } from './runs.js';
import { readFileSync } from 'node:fs';

// Parallel steps of a plan run (workflow.md block "scheduler", AUTO). A step that develops beside the others
// does so in its own worktree: the subagent's own (Claude Code's Agent isolation "worktree": <main>/.claude/
// worktrees/agent-<id>, branch worktree-agent-<id>, created from origin's default branch). nos adopts it:
//   nos run step-start --step <id> --token <t>   (the agent's first call, from its worktree)
// resets the agent's branch to the step's tip (first agent: the run branch tip, so the base never depends on
// Claude's base ref), moves node_modules over from the step's previous agent worktree and removes that one, and
// records { worktree, branch, base, phase } in the step file <specs>/.runs/<run>.steps/step-<id>.json. Every
// ability of the step hops it onto a fresh agent worktree the same way; the commits travel with the branch.
//   nos run step-merge --step <id> --token <t>   enqueues the step (phase queued)
//   nos run merge-queue --token <t>              rebases the head of the queue onto the run branch, gates it in
//                                                its worktree, fast-forwards the run branch, removes the step
//                                                worktree; stops at the first step that needs an agent (3: a
//                                                conflict for integrate, 1: a failed gate for review-fixing)
//   nos run merge-queue --hold <reason> | --release   an exclusive hold on the run worktree (a phase review)
//   nos run step-abandon --step <id> --token <t> throws the step's worktree, branch and env away
//   nos run status --token <t>                   run file, steps, queue, hold
// The run branch is never rebased onto main while step files exist (run sync refuses): the step bases stay valid.

const MERGE_ATTEMPTS = 2;

const now = () => new Date().toISOString();

const stepEnv = (run, step) => `${runIdOf(run)}-step-${step}`;

// The run of --run / the token, without touching "seen": a step agent's call must not race the orchestrator's
// writes of the run file (hold, phases)
const runFor = (roots, options) => resolveRun(roots, { ...options, touch: false });

function parseStep(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value).trim()) {
    throw new NosError(USAGE, `Invalid --step "${value}". Use a step id (a positive whole number)`);
  }
  return id;
}

// The step must be a plan step of the run's domain (ids come from the spec-file paths)
function requirePlanStep(roots, run, step) {
  if (run.kind !== 'plan') throw new NosError(FAILED, `${runIdOf(run)} is not a plan run: step worktrees are for plans`);
  const planPath = path.join(roots.specs, run.domain, PLAN_FILE);
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new NosError(FAILED, `Cannot read ${slash(planPath)}: ${err.message}`);
  }
  for (const phase of asList(plan.phases)) {
    for (const entry of asList(phase.steps)) {
      const match = String(entry?.['spec-file'] ?? '').match(/\/step-(\d+)-[^/]+\.md$/);
      if (match && Number(match[1]) === step) return entry;
    }
  }
  throw new NosError(FAILED, `Step ${step} is not a step of the plan of ${run.domain}`);
}

const stepRoots = (roots, wt) => resolveRoots({ root: wt, env: {}, home: roots.home });

const publicStep = (file) => {
  const { run, step, worktree, branch, base, phase, attempts, queuedAt, updated, gateTree } = file;
  return { run, step, worktree, branch, base, phase, attempts, queuedAt: queuedAt ?? null, updated, gateTree: gateTree ?? null };
};

function dirtyError(run, step, wt, files, what) {
  return new NosError(DIRTY, `${what} has uncommitted changes: commit or remove them first`, {
    run: runIdOf(run),
    step,
    worktree: slash(wt),
    ...fileList(wt, files),
  });
}

// ---------------------------------------------------------------------------------------------------------
// step-start: adopt the caller's worktree for the step

async function installIfNeeded(roots, wt) {
  const wtRoots = stepRoots(roots, wt);
  if (existsSync(path.join(wt, 'node_modules'))) return { nodeModules: 'present', install: null };
  const cmd = projectCommands(wtRoots).install;
  if (typeof cmd !== 'string' || !cmd.trim()) return { nodeModules: 'none', install: null };
  try {
    const result = await execCommand(wtRoots, 'install', { stdio: 'log' });
    return { nodeModules: 'installed', install: { code: result.code, log: result.log } };
  } catch (err) {
    return { nodeModules: 'none', install: { code: err instanceof NosError ? err.code : FAILED, log: null, error: err.message } };
  }
}

// Removes a step's agent worktree and branch (best effort for the branch). Throws busy/dirty like run cleanup.
function dropWorktree(roots, run, step, wt, branch) {
  const mainTop = mainTopOf(roots);
  let worktree = false;
  if (wt && registeredWorktree(mainTop, wt)) {
    git(['worktree', 'unlock', wt], { cwd: mainTop });
    removeWorktreeDir(mainTop, { run: runIdOf(run), step }, wt, true);
    worktree = true;
  } else if (wt && existsSync(wt)) {
    try {
      rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      throw new NosError(FAILED, `a process still uses ${slash(wt)}; stop it and rerun`, { worktree: slash(wt), error: err.message });
    }
    worktree = true;
  }
  git(['worktree', 'prune'], { cwd: mainTop });
  let branchRemoved = false;
  if (branch && branchExists(mainTop, branch)) {
    branchRemoved = git(['branch', '-D', branch], { cwd: mainTop }).code === 0;
  }
  return { worktree, branch: branchRemoved };
}

// nos run step-start --step <id> --token <t>, from inside the agent's worktree
export async function stepStart(roots, { step: stepValue, cwd = process.cwd(), ...options } = {}) {
  const step = parseStep(stepValue);
  const run = runFor(roots, options);
  requireActive(run, 'step-start');
  requirePlanStep(roots, run, step);
  const mainTop = mainTopOf(roots);
  const wt = path.resolve(roots.work);
  const runWt = path.resolve(run.worktree);
  if (!roots.inWorktree || !registeredWorktree(mainTop, wt)) {
    throw new NosError(FAILED, `step-start runs inside the step agent's own git worktree (Agent isolation "worktree"); ${slash(wt)} is not one`, {
      run: runIdOf(run),
      step,
      cwd: slash(cwd),
    });
  }
  if (wt === runWt || isInside(wt, runWt)) {
    throw new NosError(FAILED, `step-start must not run in the run worktree ${slash(runWt)}: it adopts a separate agent worktree`, {
      run: runIdOf(run),
      step,
    });
  }
  const branch = currentBranch(wt);
  if (!branch) throw new NosError(FAILED, `${slash(wt)} has a detached HEAD`);
  if (branch === run.branch || branch === run.mainBranch) {
    throw new NosError(FAILED, `${slash(wt)} is on ${branch}: a step agent needs its own branch`);
  }

  const existing = readStep(roots, runIdOf(run), step);
  if (existing && path.resolve(existing.worktree) === wt) {
    return { action: 'run-step-start', run: publicRun(run), step: publicStep(existing), env: stepEnv(run, step), adopted: false };
  }
  if (existing && !['develop', 'blocked', 'conflict'].includes(existing.phase)) {
    throw new NosError(FAILED, `Step ${step} is ${existing.phase}: the merge queue owns it, no new agent worktree now`, {
      run: runIdOf(run),
      step: publicStep(existing),
    });
  }
  const dirty = changedFiles(wt);
  if (dirty.length) throw dirtyError(run, step, wt, dirty, `the agent worktree ${slash(wt)}`);

  const warnings = [];
  let previous = null;
  let tip;
  if (!existing) {
    tip = run.branch;
  } else {
    const prev = path.resolve(existing.worktree);
    tip = existing.branch;
    if (existsSync(prev)) {
      // a stopped rebase (phase conflict) is aborted there and replayed here; its conflict markers are no dirt
      if (rebaseInProgress(prev)) git(['rebase', '--abort'], { cwd: prev, env: NO_EDITOR_ENV });
      const modified = modifiedTracked(prev);
      if (modified.length) throw dirtyError(run, step, prev, modified, `the previous worktree ${slash(prev)} of step ${step}`);
    }
    if (!branchExists(mainTop, tip)) {
      throw new NosError(FAILED, `The branch ${tip} of step ${step} is gone: nos run step-abandon --step ${step}, then start over`, {
        run: runIdOf(run),
        step: publicStep(existing),
      });
    }
    previous = { worktree: existing.worktree, branch: existing.branch };
  }
  // the agent's branch now points at the step's tip (first agent: the run branch tip)
  mustGit(['reset', '-q', '--hard', `refs/heads/${tip}`], wt);
  const base = existing?.base ?? mustGit(['rev-parse', run.branch], mainTop);
  let nodeModules = 'none';
  if (previous && existsSync(path.join(previous.worktree, 'node_modules')) && !existsSync(path.join(wt, 'node_modules'))) {
    try {
      renameSync(path.join(previous.worktree, 'node_modules'), path.join(wt, 'node_modules'));
      nodeModules = 'moved';
    } catch (err) {
      warnings.push(`node_modules not moved from ${slash(previous.worktree)}: ${err.message}`);
    }
  }
  const file = {
    ...(existing ?? { attempts: 0, created: now() }),
    run: runIdOf(run),
    step,
    worktree: slash(wt),
    branch,
    base,
    phase: existing?.phase === 'conflict' ? 'conflict' : existing?.phase === 'blocked' ? 'blocked' : 'develop',
    updated: now(),
  };
  writeStep(roots, file);

  let removed = null;
  if (previous) {
    try {
      removed = dropWorktree(roots, run, step, previous.worktree, previous.branch);
    } catch (err) {
      warnings.push(`previous worktree ${slash(previous.worktree)} not removed: ${err.message}`);
      removed = { worktree: false, branch: false };
    }
  }
  // a stopped rebase is replayed here: same inputs, it stops at the same conflict for the integrate ability
  let replay = null;
  if (file.phase === 'conflict') {
    const res = git(['-c', 'core.editor=true', 'rebase', '--no-autostash', '--onto', run.branch, base], { cwd: wt, env: NO_EDITOR_ENV });
    if (res.code === 0) {
      file.phase = 'queued';
      file.queuedAt = file.queuedAt ?? now();
      file.base = mustGit(['rev-parse', run.branch], mainTop);
      writeStep(roots, { ...file, updated: now() });
      replay = { rebaseInProgress: false, files: [] };
    } else if (rebaseInProgress(wt)) {
      replay = { rebaseInProgress: true, ...fileList(wt, unmergedFiles(wt)) };
    } else {
      throw new NosError(FAILED, `git rebase --onto ${run.branch} ${base} failed in ${slash(wt)}: ${(res.stderr || res.stdout).trim()}`);
    }
  }
  const installed = nodeModules === 'moved' ? { nodeModules, install: null } : await installIfNeeded(roots, wt);
  return {
    action: 'run-step-start',
    run: publicRun(run),
    step: publicStep(readStep(roots, runIdOf(run), step)),
    env: stepEnv(run, step),
    adopted: true,
    previous: previous && { ...previous, removed },
    nodeModules: installed.nodeModules === 'none' && nodeModules === 'moved' ? 'moved' : installed.nodeModules,
    install: installed.install,
    ...(replay && { replay }),
    ...(warnings.length && { warnings }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// step-merge: enqueue

export function stepMerge(roots, { step: stepValue, ...options } = {}) {
  const step = parseStep(stepValue);
  const run = runFor(roots, options);
  requireActive(run, 'step-merge');
  const file = readStep(roots, runIdOf(run), step);
  if (!file) throw new NosError(FAILED, `Step ${step} has no worktree in ${runIdOf(run)}: nothing to merge (nos run step-start)`);
  if (!['develop', 'blocked', 'conflict'].includes(file.phase)) {
    return { action: 'run-step-merge', run: publicRun(run), step: publicStep(file), queued: false };
  }
  const wt = path.resolve(file.worktree);
  if (!existsSync(wt)) throw new NosError(FAILED, `The worktree ${file.worktree} of step ${step} is missing`, { step: publicStep(file) });
  if (rebaseInProgress(wt)) {
    throw new NosError(CONFLICT, `A rebase is in progress in ${slash(wt)}: resolve it (ability integrate) before step-merge`, {
      run: runIdOf(run),
      step,
      worktree: slash(wt),
      branch: file.branch,
      mainBranch: run.branch,
      base: file.base,
      rebaseInProgress: true,
      ...fileList(wt, unmergedFiles(wt)),
    });
  }
  const modified = modifiedTracked(wt);
  if (modified.length) throw dirtyError(run, step, wt, modified, `the worktree of step ${step}`);
  const updated = { ...file, phase: 'queued', queuedAt: file.queuedAt ?? now(), updated: now() };
  writeStep(roots, updated);
  return { action: 'run-step-merge', run: publicRun(run), step: publicStep(updated), queued: true };
}

// ---------------------------------------------------------------------------------------------------------
// merge-queue

const QUEUE_PHASES = Object.freeze(['merged', 'merging', 'gating', 'rebasing', 'queued']);

const queueOrder = (steps) =>
  steps
    .filter((s) => QUEUE_PHASES.includes(s.phase))
    .sort((a, b) => QUEUE_PHASES.indexOf(a.phase) - QUEUE_PHASES.indexOf(b.phase) || String(a.queuedAt).localeCompare(String(b.queuedAt)) || a.step - b.step);

function queueSummary(roots, run) {
  const steps = listSteps(roots, runIdOf(run)).map(publicStep);
  return {
    hold: run.hold ?? null,
    queue: queueOrder(steps).map((s) => ({ step: s.step, phase: s.phase, queuedAt: s.queuedAt })),
    blocked: steps.filter((s) => ['blocked', 'conflict'].includes(s.phase)).map((s) => ({ step: s.step, phase: s.phase, attempts: s.attempts })),
    developing: steps.filter((s) => s.phase === 'develop').map((s) => s.step),
    steps,
  };
}

function conflictError(run, file, wt, message) {
  return new NosError(CONFLICT, message, {
    run: runIdOf(run),
    step: file.step,
    worktree: slash(wt),
    branch: file.branch,
    mainBranch: run.branch,
    base: file.base,
    rebaseInProgress: true,
    ...fileList(wt, unmergedFiles(wt)),
  });
}

// Removes the merged step: env, worktree, branch, step file (last). A busy folder -> 1, the rerun finishes it.
async function cleanupMerged(roots, run, file) {
  const wt = path.resolve(file.worktree);
  let env = null;
  if (existsSync(wt)) {
    try {
      const result = await runDeploy(stepRoots(roots, wt), { mode: 'remove', env: stepEnv(run, file.step) });
      env = { removed: result.removed ?? true };
    } catch (err) {
      env = err instanceof NosError && err.code === NOT_CONFIGURED ? { removed: false, reason: 'not configured' } : { removed: false, error: err.message };
    }
  }
  const removed = dropWorktree(roots, run, file.step, file.worktree, file.branch);
  deleteStep(roots, runIdOf(run), file.step);
  return { step: file.step, env, ...removed };
}

// nos run merge-queue --token <t> [--hold <reason> | --release]
export async function mergeQueue(roots, { hold, release = false, gate: gateOptions = {}, ...options } = {}) {
  let run = resolveRun(roots, options);
  requireActive(run, 'merge-queue');
  if (hold != null && release) throw new NosError(USAGE, 'Give --hold <reason> or --release, not both');
  if (hold != null) {
    if (!String(hold).trim()) throw new NosError(USAGE, '--hold needs a reason, e.g. --hold "phase-2 review"');
    run = { ...run, hold: { reason: String(hold).trim(), since: now() } };
    writeRun(roots, run);
    return { action: 'run-merge-queue', run: publicRun(run), held: true, ...queueSummary(roots, run) };
  }
  if (release) {
    const { hold: _dropped, ...rest } = run;
    run = rest;
    writeRun(roots, run);
    return { action: 'run-merge-queue', run: publicRun(run), held: false, ...queueSummary(roots, run) };
  }
  if (run.hold) {
    throw new NosError(HELD, `the run worktree of ${runIdOf(run)} is held: ${run.hold.reason} (since ${run.hold.since}). nos run merge-queue --release when it is over`, {
      run: runIdOf(run),
      hold: run.hold,
      ...queueSummary(roots, run),
    });
  }
  const mainTop = mainTopOf(roots);
  const runWt = path.resolve(run.worktree);
  const merged = [];
  const mergeGate = parallelConfig(roots).mergeGate === 'full' ? 'full' : 'quick';

  for (;;) {
    const head = queueOrder(listSteps(roots, runIdOf(run)))[0];
    if (!head) break;
    let file = head;
    const wt = path.resolve(file.worktree);
    const setPhase = (phase, extra = {}) => {
      file = { ...file, ...extra, phase, updated: now() };
      writeStep(roots, file);
    };
    if (file.phase === 'merged') {
      merged.push(await cleanupMerged(roots, run, file));
      continue;
    }
    if (!existsSync(wt)) {
      setPhase('blocked');
      throw new NosError(FAILED, `The worktree ${file.worktree} of step ${file.step} is missing: nos run step-abandon --step ${file.step}`, {
        run: runIdOf(run),
        step: publicStep(file),
      });
    }
    for (let attempt = 1; file.phase !== 'merged'; attempt++) {
      if (['queued', 'rebasing'].includes(file.phase)) {
        setPhase('rebasing');
        if (rebaseInProgress(wt)) {
          setPhase('conflict');
          throw conflictError(run, file, wt, `A rebase is in progress in ${slash(wt)}: resolve it (ability integrate), then nos run step-merge --step ${file.step}`);
        }
        const modified = modifiedTracked(wt);
        if (modified.length) {
          setPhase('blocked');
          throw dirtyError(run, file.step, wt, modified, `the worktree of step ${file.step}`);
        }
        const res = git(['-c', 'core.editor=true', 'rebase', '--no-autostash', '--onto', run.branch, file.base], {
          cwd: wt,
          env: NO_EDITOR_ENV,
        });
        if (res.code !== 0) {
          if (rebaseInProgress(wt)) {
            setPhase('conflict');
            throw conflictError(
              run,
              file,
              wt,
              `Rebase of step ${file.step} onto ${run.branch} stopped on conflicts. It is left open in its worktree for the ability integrate`,
            );
          }
          setPhase('blocked');
          throw new NosError(FAILED, `git rebase --onto ${run.branch} ${file.base} failed in ${slash(wt)}: ${(res.stderr || res.stdout).trim()}`, {
            run: runIdOf(run),
            step: publicStep(file),
          });
        }
        setPhase('gating', { base: mustGit(['rev-parse', run.branch], mainTop) });
      }
      if (file.phase === 'gating') {
        const wtRoots = stepRoots(roots, wt);
        const gate = await runGate(wtRoots, { e2e: mergeGate === 'full' && hasE2e(wtRoots), ...gateOptions });
        if (!gate.pass) {
          const names = gate.tools.filter((tool) => tool.status === 'fail').map((tool) => tool.name);
          setPhase('blocked', { attempts: (file.attempts ?? 0) + 1 });
          const exhausted = file.attempts >= MERGE_ATTEMPTS;
          const err = new NosError(
            FAILED,
            `gate failed for step ${file.step} (${names.join(', ')}), merge attempt ${file.attempts}/${MERGE_ATTEMPTS}${exhausted ? ': attempts used up, the user decides' : ': ability review-fixing in its worktree, then step-merge again'}`,
            { run: runIdOf(run), step: publicStep(file), worktree: slash(wt), gate, attempts: file.attempts, exhausted },
          );
          err.report = true;
          throw err;
        }
        setPhase('merging', { gateTree: gate.tree ?? null });
      }
      if (file.phase === 'merging') {
        const dirtyRun = modifiedTracked(runWt);
        if (dirtyRun.length) {
          setPhase('queued');
          throw dirtyError(run, file.step, runWt, dirtyRun, `the run worktree ${slash(runWt)}`);
        }
        const merge = git(['merge', '--ff-only', file.branch], { cwd: runWt });
        if (merge.code === 0) {
          if (file.gateTree) {
            const entry = readCacheEntry(logDirOf(wtRoots(roots, wt)).logDir, file.gateTree);
            if (entry) saveCacheEntry(logDirOf(roots, runIdOf(run)).logDir, file.gateTree, entry);
          }
          setPhase('merged');
          break;
        }
        if (attempt >= MERGE_ATTEMPTS) {
          setPhase('blocked');
          throw new NosError(FAILED, `git merge --ff-only ${file.branch} was refused twice in ${slash(runWt)}: ${(merge.stderr || merge.stdout).trim()}`, {
            run: runIdOf(run),
            step: publicStep(file),
          });
        }
        // something landed on the run branch between the gate and the merge: once more from the rebase
        setPhase('queued');
      }
    }
    merged.push(await cleanupMerged(roots, run, file));
  }
  return {
    action: 'run-merge-queue',
    run: publicRun(run),
    held: false,
    merged,
    head: merged.length ? mustGit(['rev-parse', run.branch], mainTop) : null,
    ...queueSummary(roots, run),
  };
}

const wtRoots = (roots, wt) => stepRoots(roots, wt);

// ---------------------------------------------------------------------------------------------------------
// step-abandon, status

export async function stepAbandon(roots, { step: stepValue, ...options } = {}) {
  const step = parseStep(stepValue);
  const run = runFor(roots, options);
  const file = readStep(roots, runIdOf(run), step);
  if (!file) throw new NosError(FAILED, `Step ${step} has no worktree in ${runIdOf(run)}: nothing to abandon`);
  if (['merging', 'merged'].includes(file.phase)) {
    throw new NosError(FAILED, `Step ${step} is ${file.phase}: nos run merge-queue completes it`, { step: publicStep(file) });
  }
  const wt = path.resolve(file.worktree);
  let env = null;
  if (existsSync(wt)) {
    if (rebaseInProgress(wt)) git(['rebase', '--abort'], { cwd: wt, env: NO_EDITOR_ENV });
    try {
      const result = await runDeploy(stepRoots(roots, wt), { mode: 'remove', env: stepEnv(run, step) });
      env = { removed: result.removed ?? true };
    } catch (err) {
      env = err instanceof NosError && err.code === NOT_CONFIGURED ? { removed: false, reason: 'not configured' } : { removed: false, error: err.message };
    }
  }
  const removed = dropWorktree(roots, run, step, file.worktree, file.branch);
  deleteStep(roots, runIdOf(run), step);
  return { action: 'run-step-abandon', run: publicRun(run), step, env, ...removed };
}

export function runStatus(roots, options = {}) {
  const run = runFor(roots, options);
  return { action: 'run-status', run: publicRun(run), ...queueSummary(roots, run), phases: STEP_PHASES };
}
