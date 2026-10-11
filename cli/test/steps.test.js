import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { createPlan } from '../src/plan.js';
import { listSteps, readStep, writeStep } from '../src/runs.js';
import { gitOk, makeProject, initRepo, writeFile } from './helpers.js';
import { branchExists, commitIn, FAIL_IF, head, noGit, nos } from './run-helpers.js';

// Parallel steps of a plan run with real git: step-start adopts an agent worktree, step-merge + merge-queue
// fold the step branches back into the run branch, conflicts and failed gates stop the queue for an agent.

const step = (slug) => ({ slug, intent: slug, status: 'open', description: '', 'spec-file': '', 'depends-on': [] });

function setup(t) {
  const { root, roots } = makeProject(t, {
    git: true,
    sibling: true,
    config: { 'quality-tools': { test: FAIL_IF }, worktrees: { slots: 1, slotWait: 1 } },
  });
  writeFile(root, 'src/a.txt', 'one\ntwo\nthree\n');
  gitOk(['add', 'src/a.txt'], root);
  gitOk(['commit', '-m', 'src'], root);
  initRepo(roots.specs);
  writeFile(roots.specs, '.gitignore', '.chat/\n.locks/\n.runs/\n');
  const { folder: domain } = createDomain(roots, { idea: '# P', slug: 'p' });
  createPlan(roots, {
    domain,
    plan: {
      name: 'P',
      status: 'open',
      'dependencies-checked': true,
      phases: [{ slug: 'f', name: 'f', status: 'open', intent: '', description: '', steps: [step('x'), step('y'), step('z')] }],
    },
  });
  gitOk(['add', '-A'], roots.specs);
  gitOk(['commit', '-m', 'nos: init'], roots.specs);
  return { root, roots, domain };
}

async function startPlan(root, domain) {
  const res = await nos(['run', 'start', '--domain', domain, '--plan'], root);
  assert.equal(res.code, 0, res.err);
  return res.json;
}

// what Claude Code's Agent isolation "worktree" does: a worktree under .claude/worktrees on its own branch
let agents = 0;
function agentWorktree(root, from = 'main') {
  agents++;
  const wt = path.join(root, '.claude', 'worktrees', `agent-${agents}`);
  gitOk(['worktree', 'add', '-b', `worktree-agent-${agents}`, wt, from], root);
  return wt;
}

const stepStart = (wt, id, token) => nos(['run', 'step-start', '--step', String(id), '--token', token], wt);
const stepMerge = (dir, id, token) => nos(['run', 'step-merge', '--step', String(id), '--token', token], dir);
const queue = (dir, token, extra = []) => nos(['run', 'merge-queue', '--token', token, ...extra], dir);

test('step-start adopts an agent worktree at the run branch tip; merge-queue folds the step back', noGit, async (t) => {
  const { root, roots, domain } = setup(t);
  const run = await startPlan(root, domain);
  const runTip = head(run.enter);
  const wt = agentWorktree(root);

  const adopt = await stepStart(wt, 1, run.token);
  assert.equal(adopt.code, 0, adopt.err);
  assert.equal(adopt.json.adopted, true);
  assert.equal(adopt.json.step.phase, 'develop');
  assert.equal(adopt.json.step.base, runTip);
  assert.equal(adopt.json.step.branch, 'worktree-agent-1');
  assert.equal(adopt.json.env, 'plan-1-step-1');
  assert.equal(head(wt), runTip, 'the agent branch now points at the run branch tip');
  assert.equal(readStep(roots, 'plan-1', 1).worktree, adopt.json.step.worktree);
  // idempotent for the same worktree
  const again = await stepStart(wt, 1, run.token);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.adopted, false);

  // a gate in the step worktree logs under the step, not the run
  const gate = await nos(['gate'], wt);
  assert.equal(gate.code, 0, gate.err);
  assert.match(gate.json.tools[0].log, /logs\/plan-1\/step-1\/test\.log$/);

  // sync, finish and abandon wait while a step is open
  const sync = await nos(['run', 'sync', '--token', run.token], run.enter);
  assert.equal(sync.code, 1);
  assert.match(sync.err, /parallel step worktree/);

  commitIn(wt, 'src/x.txt', 'x\n', 'step-1: x');
  const merge = await stepMerge(wt, 1, run.token);
  assert.equal(merge.code, 0, merge.err);
  assert.equal(merge.json.step.phase, 'queued');

  const q = await queue(run.enter, run.token);
  assert.equal(q.code, 0, q.err);
  assert.deepEqual(
    q.json.merged.map((m) => [m.step, m.worktree, m.branch]),
    [[1, true, true]],
  );
  assert.equal(q.json.head, head(run.enter));
  assert.ok(existsSync(path.join(run.enter, 'src', 'x.txt')), 'the run worktree has the step');
  assert.equal(existsSync(wt), false, 'the agent worktree is gone');
  assert.equal(branchExists(root, 'worktree-agent-1'), false);
  assert.equal(readStep(roots, 'plan-1', 1), null);
  assert.equal(gitOk(['rev-list', '--merges', 'plan-1'], root), '', 'ff only');
  // the run's gate cache knows the step's passes
  const runCache = path.join(roots.specs, '.runs', 'logs', 'plan-1', 'gate-cache.json');
  assert.ok(existsSync(runCache));
});

test('a conflict stops the queue for integrate; the next agent worktree replays the rebase', noGit, async (t) => {
  const { root, roots, domain } = setup(t);
  const run = await startPlan(root, domain);
  const wt = agentWorktree(root);
  assert.equal((await stepStart(wt, 2, run.token)).code, 0);
  commitIn(wt, 'src/a.txt', 'one\nSTEP\nthree\n', 'step-2: a');
  // meanwhile a phase review-fixing commit on the run branch touches the same line
  commitIn(run.enter, 'src/a.txt', 'one\nRUN\nthree\n', 'phase-1: fix');
  assert.equal((await stepMerge(wt, 2, run.token)).code, 0);

  const q = await queue(run.enter, run.token);
  assert.equal(q.code, 3, q.err);
  assert.equal(q.json.details.step, 2);
  assert.equal(q.json.details.mainBranch, 'plan-1');
  assert.equal(q.json.details.rebaseInProgress, true);
  assert.deepEqual(q.json.details.files, ['src/a.txt']);
  assert.equal(readStep(roots, 'plan-1', 2).phase, 'conflict');

  // a conflict step is skipped by the next call (listed as blocked), nothing else queued -> no merges
  const again = await queue(run.enter, run.token);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.json.merged, []);
  assert.deepEqual(again.json.blocked, [{ step: 2, phase: 'conflict', attempts: 0 }]);

  // the integrate agent hops the step onto its own worktree: the rebase is replayed there
  const wt2 = agentWorktree(root);
  const hop = await stepStart(wt2, 2, run.token);
  assert.equal(hop.code, 0, hop.err);
  assert.equal(hop.json.replay.rebaseInProgress, true);
  assert.deepEqual(hop.json.replay.files, ['src/a.txt']);
  assert.equal(hop.json.previous.removed.worktree, true);
  assert.equal(existsSync(wt), false);
  assert.equal(readStep(roots, 'plan-1', 2).worktree, hop.json.step.worktree);
  assert.equal(readStep(roots, 'plan-1', 2).branch, `worktree-${path.basename(wt2)}`);

  // step-merge refuses while the rebase is open
  const early = await stepMerge(wt2, 2, run.token);
  assert.equal(early.code, 3);

  writeFile(wt2, 'src/a.txt', 'one\nRUN+STEP\nthree\n');
  gitOk(['add', '--', 'src/a.txt'], wt2);
  gitOk(['-c', 'core.editor=true', 'rebase', '--continue'], wt2);
  assert.equal((await stepMerge(wt2, 2, run.token)).code, 0);
  const merged = await queue(run.enter, run.token);
  assert.equal(merged.code, 0, merged.err);
  assert.deepEqual(merged.json.merged.map((m) => m.step), [2]);
  assert.match(gitOk(['show', 'HEAD:src/a.txt'], run.enter), /RUN\+STEP/);
  assert.equal(listSteps(roots, 'plan-1').length, 0);
});

test('a failed gate blocks the step, counts attempts and lets the rest of the queue merge', noGit, async (t) => {
  const { root, roots, domain } = setup(t);
  const run = await startPlan(root, domain);
  const bad = agentWorktree(root);
  const good = agentWorktree(root);
  assert.equal((await stepStart(bad, 1, run.token)).code, 0);
  assert.equal((await stepStart(good, 2, run.token)).code, 0);
  commitIn(bad, 'FAIL', '', 'step-1: breaks the gate');
  commitIn(good, 'src/y.txt', 'y\n', 'step-2: y');
  assert.equal((await stepMerge(bad, 1, run.token)).code, 0);
  assert.equal((await stepMerge(good, 2, run.token)).code, 0);

  const first = await queue(run.enter, run.token);
  assert.equal(first.code, 1, first.err);
  assert.equal(first.json.details.step.step, 1);
  assert.equal(first.json.details.step.phase, 'blocked');
  assert.equal(first.json.details.attempts, 1);
  assert.equal(first.json.details.exhausted, false);
  assert.equal(first.json.details.gate.pass, false);

  // the next call skips the blocked step and merges step 2
  const second = await queue(run.enter, run.token);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(second.json.merged.map((m) => m.step), [2]);
  assert.deepEqual(second.json.blocked, [{ step: 1, phase: 'blocked', attempts: 1 }]);

  // review-fixing removes the breakage in the step worktree, the step is queued again and merges on top of 2
  gitOk(['rm', '-q', 'FAIL'], bad);
  gitOk(['commit', '-m', 'step-1: gate fix'], bad);
  assert.equal((await stepMerge(bad, 1, run.token)).code, 0);
  const third = await queue(run.enter, run.token);
  assert.equal(third.code, 0, third.err);
  assert.deepEqual(third.json.merged.map((m) => m.step), [1]);
  assert.ok(existsSync(path.join(run.enter, 'src', 'y.txt')));
  assert.equal(existsSync(path.join(run.enter, 'FAIL')), false);
  assert.equal(listSteps(roots, 'plan-1').length, 0);

  // a second failure exhausts the attempts
  const again = agentWorktree(root);
  assert.equal((await stepStart(again, 3, run.token)).code, 0);
  commitIn(again, 'FAIL', '', 'step-3: breaks');
  assert.equal((await stepMerge(again, 3, run.token)).code, 0);
  assert.equal((await queue(run.enter, run.token)).code, 1);
  gitOk(['commit', '--allow-empty', '-m', 'step-3: still broken'], again);
  assert.equal((await stepMerge(again, 3, run.token)).code, 0);
  const last = await queue(run.enter, run.token);
  assert.equal(last.code, 1);
  assert.equal(last.json.details.attempts, 2);
  assert.equal(last.json.details.exhausted, true);
});

test('hold, status, step-abandon and the refusals', noGit, async (t) => {
  const { root, roots, domain } = setup(t);
  const run = await startPlan(root, domain);

  // step-start needs an agent worktree, not the run worktree, not a dirty one
  const inRun = await stepStart(run.enter, 1, run.token);
  assert.equal(inRun.code, 1);
  assert.match(inRun.err, /must not run in the run worktree/);
  const wt = agentWorktree(root);
  writeFile(wt, 'src/dirty.txt', 'x');
  const dirty = await stepStart(wt, 1, run.token);
  assert.equal(dirty.code, 5);
  gitOk(['clean', '-fdq'], wt);
  assert.equal((await stepStart(wt, 1, run.token)).code, 0);
  const unknown = await stepStart(wt, 99, run.token);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /not a step of the plan/);

  commitIn(wt, 'src/x.txt', 'x\n', 'step-1: x');
  assert.equal((await stepMerge(wt, 1, run.token)).code, 0);

  const hold = await queue(run.enter, run.token, ['--hold', 'phase-1 review']);
  assert.equal(hold.code, 0, hold.err);
  assert.equal(hold.json.held, true);
  assert.equal(hold.json.hold.reason, 'phase-1 review');
  const held = await queue(run.enter, run.token);
  assert.equal(held.code, 4);
  assert.equal(held.json.details.hold.reason, 'phase-1 review');
  const finish = await nos(['run', 'finish', '--token', run.token], run.enter);
  assert.equal(finish.code, 1);
  assert.match(finish.err, /parallel step/);

  const status = await nos(['run', 'status', '--token', run.token], run.enter);
  assert.equal(status.code, 0, status.err);
  assert.equal(status.json.hold.reason, 'phase-1 review');
  assert.deepEqual(status.json.queue.map((q) => [q.step, q.phase]), [[1, 'queued']]);

  const release = await queue(run.enter, run.token, ['--release']);
  assert.equal(release.code, 0, release.err);
  assert.equal(release.json.held, false);

  // abandon throws the step away: worktree, branch, file
  const abandon = await nos(['run', 'step-abandon', '--step', '1', '--token', run.token], run.enter);
  assert.equal(abandon.code, 0, abandon.err);
  assert.deepEqual([abandon.json.worktree, abandon.json.branch], [true, true]);
  assert.equal(existsSync(wt), false);
  assert.equal(branchExists(root, 'worktree-agent-1'), false);
  assert.equal(listSteps(roots, 'plan-1').length, 0);
  assert.equal((await queue(run.enter, run.token)).json.merged.length, 0);

  // with no steps open, sync works again
  const sync = await nos(['run', 'sync', '--token', run.token], run.enter);
  assert.equal(sync.code, 0, sync.err);
});

test('merge-queue resumes from the persisted phase after a crash; a merged step is cleaned up first', noGit, async (t) => {
  const { root, roots, domain } = setup(t);
  const run = await startPlan(root, domain);
  const wt = agentWorktree(root);
  assert.equal((await stepStart(wt, 1, run.token)).code, 0);
  commitIn(wt, 'src/x.txt', 'x\n', 'step-1: x');
  assert.equal((await stepMerge(wt, 1, run.token)).code, 0);

  // crash after the ff merge, before the cleanup: the step file says merged, the worktree still exists
  gitOk(['merge', '--ff-only', readStep(roots, 'plan-1', 1).branch], run.enter);
  writeStep(roots, { ...readStep(roots, 'plan-1', 1), phase: 'merged' });
  const rerun = await queue(run.enter, run.token);
  assert.equal(rerun.code, 0, rerun.err);
  assert.deepEqual(rerun.json.merged.map((m) => [m.step, m.worktree, m.branch]), [[1, true, true]]);
  assert.equal(existsSync(wt), false);
  assert.equal(listSteps(roots, 'plan-1').length, 0);

  // crash in the gate: phase gating is picked up again (the rebase is not repeated)
  const wt2 = agentWorktree(root);
  assert.equal((await stepStart(wt2, 2, run.token)).code, 0);
  commitIn(wt2, 'src/y.txt', 'y\n', 'step-2: y');
  assert.equal((await stepMerge(wt2, 2, run.token)).code, 0);
  writeStep(roots, { ...readStep(roots, 'plan-1', 2), phase: 'gating', base: head(run.enter) });
  const resumed = await queue(run.enter, run.token);
  assert.equal(resumed.code, 0, resumed.err);
  assert.deepEqual(resumed.json.merged.map((m) => m.step), [2]);
  assert.ok(existsSync(path.join(run.enter, 'src', 'y.txt')));

  // nos run status after everything merged: empty queue, no hold
  const status = await nos(['run', 'status', '--token', run.token], run.enter);
  assert.equal(status.code, 0, status.err);
  assert.deepEqual([status.json.queue, status.json.blocked, status.json.developing, status.json.hold], [[], [], [], null]);
});

test('a step hops across agent worktrees: the next ability adopts the step with its commits and node_modules', noGit, async (t) => {
  const { root, roots, domain } = setup(t);
  const run = await startPlan(root, domain);
  const dev = agentWorktree(root);
  assert.equal((await stepStart(dev, 1, run.token)).code, 0);
  writeFile(dev, 'node_modules/.marker', 'installed');
  const tip = commitIn(dev, 'src/x.txt', 'x\n', 'step-1: x');

  const reviewer = agentWorktree(root);
  const hop = await stepStart(reviewer, 1, run.token);
  assert.equal(hop.code, 0, hop.err);
  assert.equal(hop.json.nodeModules, 'moved');
  assert.equal(head(reviewer), tip, 'the reviewer starts at the developer\'s tip');
  assert.ok(existsSync(path.join(reviewer, 'node_modules', '.marker')));
  assert.equal(existsSync(dev), false);
  assert.equal(branchExists(root, `worktree-${path.basename(dev)}`), false);
  assert.equal(readStep(roots, 'plan-1', 1).base, hop.json.step.base, 'the base is kept across hops');

  // a dirty previous worktree is refused (uncommitted work would be lost)
  const third = agentWorktree(root);
  writeFile(reviewer, 'src/x.txt', 'changed');
  const refused = await stepStart(third, 1, run.token);
  assert.equal(refused.code, 5);
  assert.match(refused.err, /previous worktree/);
});
