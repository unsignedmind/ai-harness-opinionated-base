import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { git } from '../src/git.js';
import { takeLock } from '../src/lock.js';
import { createPlan } from '../src/plan.js';
import { readRun } from '../src/runs.js';
import { gitOk, hasGit, readJson, writeFile } from './helpers.js';
import {
  branchExists,
  commitIn,
  done,
  head,
  lastSpecsFiles,
  lastSpecsSubject,
  mergeHeld,
  noGit,
  nos,
  quickStatus,
  setup,
  start,
} from './run-helpers.js';

// nos run cleanup / abandon with real git.

// ---------------------------------------------------------------------------------------------------------
// run cleanup / abandon

test(
  'cleanup: refused from inside the worktree and before merged; idempotent after a partial removal',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);

    const early = await nos(['run', 'cleanup', '--token', a.token], root);
    assert.equal(early.code, 1);
    assert.match(early.err, /cleanup needs merged or abandoned/);

    done(roots, quick.a);
    assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);

    const inside = await nos(['run', 'cleanup', '--token', a.token], a.enter);
    assert.equal(inside.code, 1);
    assert.match(inside.err, /ExitWorktree/);
    const deeper = await nos(['run', 'cleanup', '--token', a.token, '--run', quick.a.runId], path.join(a.enter, 'src'));
    assert.equal(deeper.code, 1);
    assert.ok(existsSync(a.enter));

    // the worktree went away already (a cleanup that failed after it): the rest still happens
    gitOk(['worktree', 'remove', a.enter], root);
    const rest = await nos(['run', 'cleanup', '--token', a.token, '--run', quick.a.runId], root);
    assert.equal(rest.code, 0, rest.err);
    assert.deepEqual(rest.json.removed, { worktree: false, branch: true, runFile: true });
    assert.equal(branchExists(root, quick.a.runId), false);
  },
);

test('take-over of a merged run re-mints the token only, so a token-less session reaches cleanup', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);
  const mainSha = head(root);

  const held = await nos(['run', 'start', '--domain', quick.a.domain, '--quick', String(quick.a.id)], root);
  assert.equal(held.code, 4);

  const taken = await start(root, quick.a, ['--take-over']);
  assert.notEqual(taken.token, a.token);
  assert.equal(taken.run.phase, 'merged');
  assert.equal(taken.install, null);
  assert.equal(taken.leftovers, null);
  assert.equal(head(root), mainSha);

  const cleanup = await nos(['run', 'cleanup', '--token', taken.token], root);
  assert.equal(cleanup.code, 0, cleanup.err);
  assert.equal(readRun(roots, quick.a.runId), null);
});

test('abandon: dirty worktree and unmerged commits are removed (--force, -D), statuses discarded', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  writeFile(a.enter, 'src/dirty.txt', 'dirty\n');
  const mainSha = head(root);

  const inside = await nos(['run', 'abandon', '--token', a.token], a.enter);
  assert.equal(inside.code, 1);
  assert.match(inside.err, /ExitWorktree/);
  assert.equal(quickStatus(roots, quick.a), 'open', 'nothing changed');

  const res = await nos(['run', 'abandon', '--token', a.token], root);

  assert.equal(res.code, 0, res.err);
  assert.equal(res.json.action, 'run-abandon');
  assert.equal('error' in res.json, false);
  assert.equal(res.json.run.phase, 'abandoned');
  assert.deepEqual(res.json.removed, { worktree: true, branch: true, runFile: true });
  assert.equal(res.json.statuses.changes[0].status, 'discarded');
  assert.equal(quickStatus(roots, quick.a), 'discarded');
  assert.equal(lastSpecsSubject(roots), `${quick.a.runId}: discarded`);
  assert.ok(lastSpecsFiles(roots).every((file) => file === 'config.json' || file.startsWith(`${quick.a.domain}/`)));
  assert.equal(existsSync(a.enter), false);
  assert.equal(branchExists(root, quick.a.runId), false);
  assert.equal(readRun(roots, quick.a.runId), null);
  assert.equal(head(root), mainSha, 'main untouched');
});

test('abandon of a plan run: plan and steps discarded; a merged run cannot be abandoned', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  createPlan(roots, {
    domain: quick.a.domain,
    plan: { name: 'A', status: 'in-progress', phases: [{ slug: 'p', steps: [{ slug: 's1' }, { slug: 's2' }] }] },
  });
  const p = (await nos(['run', 'start', '--domain', quick.a.domain, '--plan'], root)).json;
  const res = await nos(['run', 'abandon', '--token', p.token], root);
  assert.equal(res.code, 0, res.err);
  const saved = readJson(roots.specs, `${quick.a.domain}/plan.json`);
  assert.equal(saved.status, 'discarded');
  assert.deepEqual(
    saved.phases[0].steps.map((s) => s.status),
    ['discarded', 'discarded'],
  );
  assert.equal(saved.branch, 'plan-1');

  const b = await start(root, quick.b);
  commitIn(b.enter, 'src/y.txt', 'y\n', `step-${quick.b.id}: y`);
  done(roots, quick.b);
  assert.equal((await nos(['run', 'finish', '--token', b.token], b.enter)).code, 0);
  const merged = await nos(['run', 'abandon', '--token', b.token], root);
  assert.equal(merged.code, 1);
  assert.match(merged.err, /merged: nos run cleanup/);
});

test('abandon releases a merge lock its crashed finish left', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  takeLock(roots, 'merge', { run: quick.a.runId, token: a.token, command: 'run finish' });
  assert.equal((await nos(['run', 'abandon', '--token', a.token], root)).code, 0);
  assert.equal(mergeHeld(roots), false);
});

test(
  'cleanup: a process sitting in the worktree -> 1 with a hint; phase stays, a rerun completes (Windows)',
  { skip: (!hasGit && 'git is not available') || (process.platform !== 'win32' && 'Windows folder locks only') },
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: path.join(a.enter, 'src') });
    t.after(() => child.kill());
    await new Promise((resolve) => child.on('spawn', resolve));

    const res = await nos(['run', 'abandon', '--token', a.token], root);
    assert.equal(res.code, 1);
    assert.match(res.err, /still uses .*stop it and rerun nos run cleanup/);
    assert.equal(readRun(roots, quick.a.runId).phase, 'abandoned', 'abandoned before the cleanup');

    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    const rerun = await nos(['run', 'cleanup', '--token', a.token], root);
    assert.equal(rerun.code, 0, rerun.err);
    assert.equal(existsSync(a.enter), false);
    assert.equal(readRun(roots, quick.a.runId), null);
  },
);

test('run: usage errors', noGit, async (t) => {
  const { root } = setup(t, { slugs: ['a'] });
  assert.equal((await nos(['run'], root)).code, 2);
  assert.equal((await nos(['run', 'nope'], root)).code, 2);
  assert.equal((await nos(['run', 'start', '--plan'], root)).code, 2);
  assert.equal((await nos(['run', 'sync', '--domain', 'domain-1-a', '--token', 'x'], root)).code, 2);
  const noRun = await nos(['run', 'sync', '--token', 'abcdef12'], root);
  assert.equal(noRun.code, 1);
  assert.match(noRun.err, /No run holds this token/);
});
