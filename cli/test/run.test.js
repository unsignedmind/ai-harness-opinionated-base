import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { git } from '../src/git.js';
import { createPlan } from '../src/plan.js';
import { createQuickStep } from '../src/quick-step.js';
import { resolveRoots, slash } from '../src/roots.js';
import { readRun } from '../src/runs.js';
import { gitOk, initRepo, makeProject, makeTempRoot, readJson, writeFile } from './helpers.js';
import {
  commitIn,
  head,
  lastSpecsFiles,
  lastSpecsSubject,
  noGit,
  nos,
  PASS,
  read,
  setup,
  start,
} from './run-helpers.js';

// The run lifecycle with real git: run start, run sync (run-helpers.js sets the projects up).

// ---------------------------------------------------------------------------------------------------------
// run start

test('run start: branch + worktree + run file, branch in the quick step, JSON shape for the chat', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const out = await start(root, quick.a);

  assert.deepEqual(Object.keys(out), ['action', 'run', 'token', 'roots', 'enter', 'install', 'leftovers']);
  assert.equal(out.action, 'run-start');
  assert.equal('error' in out, false);
  const wt = slash(path.join(root, '.claude', 'worktrees', quick.a.runId));
  assert.deepEqual(Object.keys(out.run), [
    'kind',
    'id',
    'domain',
    'branch',
    'worktree',
    'base',
    'mainBranch',
    'phase',
    'started',
    'seen',
  ]);
  assert.equal(out.run.kind, 'quick');
  assert.equal(out.run.id, quick.a.id);
  assert.equal(out.run.domain, quick.a.domain);
  assert.equal(out.run.branch, quick.a.runId);
  assert.equal(out.run.worktree, wt);
  assert.equal(out.run.base, head(root));
  assert.equal(out.run.mainBranch, 'main');
  assert.equal(out.run.phase, 'develop');
  assert.match(out.token, /^[0-9a-f]{8}$/);
  assert.deepEqual(out.roots, { home: slash(roots.home), work: wt, main: slash(root), specs: slash(roots.specs) });
  assert.equal(out.enter, wt);
  assert.equal(out.install, null, 'no install command configured');
  assert.equal(out.leftovers, null);

  assert.ok(existsSync(path.join(wt, 'src', 'a.txt')), 'the worktree is checked out');
  assert.equal(gitOk(['symbolic-ref', '--short', 'HEAD'], wt), quick.a.runId);
  assert.equal(head(wt), head(root));
  const file = readRun(roots, quick.a.runId);
  assert.equal(file.token, out.token);
  assert.equal(file.worktree, wt);
  const step = readJson(roots.specs, `${quick.a.domain}/quick-steps/quick-steps.json`)[0];
  assert.equal(step.branch, quick.a.runId);
  // a session inside the worktree resolves to it
  const inside = await nos(['roots'], wt);
  assert.equal(inside.json.work, wt);
  assert.equal(inside.json.main, slash(root));
});

test('run start: install runs in the new worktree, its output goes to the log, never to stdout', noGit, async (t) => {
  const installCmd = `node -e "require('fs').writeFileSync('installed.txt', 'x'); console.log('INSTALL OUT')"`;
  const { root, roots, quick } = setup(t, { config: { 'project-commands': { install: installCmd } } });
  const res = await nos(['run', 'start', '--domain', quick.a.domain, '--quick', String(quick.a.id)], root);

  assert.equal(res.code, 0, res.err);
  assert.doesNotMatch(res.out, /INSTALL OUT/);
  const { install, enter } = res.json;
  assert.equal(install.code, 0);
  assert.equal(install.log, slash(path.join(roots.specs, '.runs', 'logs', quick.a.runId, 'install.log')));
  assert.match(read(install.log), /INSTALL OUT/);
  assert.ok(existsSync(path.join(enter, 'installed.txt')), 'install ran in the worktree');

  // resume with the worktree in place: no install
  const again = await start(root, quick.a, ['--token', res.json.token]);
  assert.equal(again.install, null);
});

test('run start: a failing install is reported, the run stays', noGit, async (t) => {
  const { root, roots, quick } = setup(t, {
    config: { 'project-commands': { install: `node -e "process.exit(3)"` } },
  });
  const out = await start(root, quick.a);
  assert.equal(out.install.code, 3);
  assert.ok(readRun(roots, quick.a.runId));
});

test(
  'run start: same token resumes (recreates a missing worktree), other token 4, --take-over re-mints',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const first = await start(root, quick.a);
    const wt = first.enter;

    const resumed = await start(root, quick.a, ['--token', first.token]);
    assert.equal(resumed.token, first.token);
    assert.equal(resumed.run.started, first.run.started);

    // env fallback
    const viaEnv = await nos(['run', 'start', '--domain', quick.a.domain, '--quick', String(quick.a.id)], root, {
      NOS_RUN_TOKEN: first.token,
    });
    assert.equal(viaEnv.code, 0, viaEnv.err);

    for (const extra of [[], ['--token', 'ffffffff']]) {
      const held = await nos(
        ['run', 'start', '--domain', quick.a.domain, '--quick', String(quick.a.id), ...extra],
        root,
      );
      assert.equal(held.code, 4);
      assert.equal(held.json.action, 'run-start');
      assert.equal(held.json.details.run, quick.a.runId);
      assert.equal(typeof held.json.details.ageSec, 'number');
      assert.ok(held.json.details.seen);
    }

    // the worktree folder was deleted by hand: the same token recreates it
    gitOk(['worktree', 'remove', '--force', wt], root);
    const recreated = await start(root, quick.a, ['--token', first.token]);
    assert.ok(existsSync(path.join(recreated.enter, 'src', 'a.txt')));

    const taken = await start(root, quick.a, ['--take-over']);
    assert.notEqual(taken.token, first.token);
    assert.equal(readRun(roots, quick.a.runId).token, taken.token);
    const old = await nos(['run', 'sync', '--token', first.token, '--run', quick.a.runId], root);
    assert.equal(old.code, 4, 'the old token is out');
  },
);

test('run start: another run in the domain -> 6; plan run id = plan-<domain id>', noGit, async (t) => {
  const { root, roots, quick } = setup(t, { slugs: ['a'] });
  const { id: second } = createQuickStep(roots, { domain: quick.a.domain, step: { slug: 'other', intent: 'o' } });
  await start(root, quick.a);

  const busy = await nos(['run', 'start', '--domain', quick.a.domain, '--quick', String(second)], root);
  assert.equal(busy.code, 6);
  assert.equal(busy.json.action, 'run-start');
  assert.equal(busy.json.details.run, quick.a.runId);
  assert.equal(busy.json.details.domain, quick.a.domain);

  createPlan(roots, {
    domain: quick.a.domain,
    plan: { name: 'A', status: 'open', phases: [{ slug: 'p', steps: [{ slug: 's' }] }] },
  });
  const plan = await nos(['run', 'start', '--domain', quick.a.domain, '--plan'], root);
  assert.equal(plan.code, 6, 'a plan run waits for the quick run of its domain too');
});

test('run start of a plan: branch plan-<domain id>, branch field in plan.json, validation', noGit, async (t) => {
  const { root, roots, quick } = setup(t, { slugs: ['a', 'b'] });
  createPlan(roots, {
    domain: quick.a.domain,
    plan: { name: 'A', status: 'open', phases: [{ slug: 'p', steps: [{ slug: 's' }] }] },
  });
  createPlan(roots, { domain: quick.b.domain, hollow: true });

  const out = (await nos(['run', 'start', '--domain', quick.a.domain, '--plan'], root)).json;
  assert.equal(out.run.kind, 'plan');
  assert.equal(out.run.id, 1);
  assert.equal(out.run.branch, 'plan-1');
  assert.equal(readJson(roots.specs, `${quick.a.domain}/plan.json`).branch, 'plan-1');

  const hollow = await nos(['run', 'start', '--domain', quick.b.domain, '--plan'], root);
  assert.equal(hollow.code, 1);
  assert.match(hollow.err, /no phases/);
  const unknown = await nos(['run', 'start', '--domain', quick.b.domain, '--quick', '99'], root);
  assert.equal(unknown.code, 1);
  const both = await nos(['run', 'start', '--domain', quick.b.domain, '--plan', '--quick', '2'], root);
  assert.equal(both.code, 2);
  const steps = readJson(roots.specs, `${quick.b.domain}/quick-steps/quick-steps.json`);
  steps[0].status = 'discarded';
  writeFile(roots.specs, `${quick.b.domain}/quick-steps/quick-steps.json`, steps);
  const discarded = await nos(['run', 'start', '--domain', quick.b.domain, '--quick', String(quick.b.id)], root);
  assert.equal(discarded.code, 1);
  assert.match(discarded.err, /discarded/);
});

test('run start: needs git', async (t) => {
  const { root, roots } = makeProject(t);
  const { folder } = createDomain(roots, { idea: '# A', slug: 'a' });
  createQuickStep(roots, { domain: folder, step: { slug: 'x', intent: 'x' } });
  const res = await nos(['run', 'start', '--domain', folder, '--quick', '1'], root);
  assert.equal(res.code, 1);
  assert.match(res.err, /need git/);
});

test('run start: uncommitted specs of the domain are committed as leftovers, other domains stay', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  writeFile(roots.specs, `${quick.a.domain}/idea.md`, '# a changed\n');
  writeFile(roots.specs, `${quick.b.domain}/idea.md`, '# b changed\n');

  const out = await start(root, quick.a);

  assert.equal(out.leftovers.committed, true);
  assert.equal(out.leftovers.sha, head(roots.specs));
  assert.equal(lastSpecsSubject(roots), `${quick.a.runId}: leftovers`);
  assert.deepEqual(lastSpecsFiles(roots), [`${quick.a.domain}/idea.md`]);
  assert.match(gitOk(['status', '--porcelain'], roots.specs), new RegExp(`${quick.b.domain}/idea.md`));
});

test('run start in a monorepo subfolder: enter = worktree + the project offset', noGit, async (t) => {
  const repo = makeTempRoot(t);
  initRepo(repo);
  const app = path.join(repo, 'app');
  writeFile(app, 'nos.config.json', { specs: { dir: '.specs', remote: null }, 'quality-tools': { test: PASS } });
  writeFile(app, '.gitignore', '.specs/\n.claude/worktrees/\n');
  writeFile(app, 'src/x.txt', 'x\n');
  gitOk(['add', '-A'], repo);
  gitOk(['commit', '-m', 'init'], repo);
  const roots = resolveRoots({ root: app, env: {} });
  writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 1, phase: 1, step: 1 } });
  initRepo(roots.specs);
  const { folder } = createDomain(roots, { idea: '# A', slug: 'a' });
  createQuickStep(roots, { domain: folder, step: { slug: 'x', intent: 'x' } });
  gitOk(['add', '-A'], roots.specs);
  gitOk(['commit', '-m', 'nos: init'], roots.specs);

  const out = await start(app, { domain: folder, id: 1 });

  const wtTop = slash(path.join(app, '.claude', 'worktrees', 'quick-1'));
  assert.equal(out.run.worktree, wtTop);
  assert.equal(out.enter, `${wtTop}/app`);
  assert.equal(out.roots.work, out.enter);
  assert.ok(existsSync(path.join(out.enter, 'nos.config.json')));
  const inside = await nos(['roots'], out.enter);
  assert.equal(inside.json.main, slash(app));
  assert.equal(inside.json.specs, slash(roots.specs));
});

// ---------------------------------------------------------------------------------------------------------
// run sync

test('run sync: rebases onto main, updates base; token checks; NOS_RUN_TOKEN fallback', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const { token, enter: wt } = await start(root, quick.a);
  commitIn(wt, 'src/b.txt', 'b\n', `step-${quick.a.id}: b`);
  const mainSha = commitIn(root, 'src/c.txt', 'c\n', 'architect: c');

  const missing = await nos(['run', 'sync'], wt);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /--token required/);
  const other = await nos(['run', 'sync', '--token', 'ffffffff'], wt);
  assert.equal(other.code, 4);
  assert.equal(other.json.action, 'run-sync');

  const seenBefore = readRun(roots, quick.a.runId).seen;
  const res = await nos(['run', 'sync'], wt, { NOS_RUN_TOKEN: token });
  assert.equal(res.code, 0, res.err);
  assert.equal(res.json.action, 'run-sync');
  assert.equal(res.json.base, mainSha);
  assert.equal(res.json.ahead, 1);
  assert.equal(res.json.behind, 0);
  assert.equal(res.json.rebased, true);
  assert.equal(readRun(roots, quick.a.runId).base, mainSha);
  assert.notEqual(readRun(roots, quick.a.runId).seen, seenBefore);
  assert.ok(existsSync(path.join(wt, 'src', 'c.txt')));

  // from main: the token finds the run
  const fromMain = await nos(['run', 'sync', '--token', token], root);
  assert.equal(fromMain.code, 0, fromMain.err);
  assert.equal(fromMain.json.rebased, false);
});

test('run sync: dirty worktree -> 5 with the files, never autostashed', noGit, async (t) => {
  const { root, quick } = setup(t);
  const { token, enter: wt } = await start(root, quick.a);
  writeFile(wt, 'src/a.txt', 'changed\n');
  writeFile(wt, 'new/file.txt', 'n\n');

  const res = await nos(['run', 'sync', '--token', token], wt);

  assert.equal(res.code, 5);
  assert.equal(res.json.action, 'run-sync');
  assert.deepEqual(res.json.details.files.sort(), ['new/file.txt', 'src/a.txt']);
  assert.deepEqual(res.json.details.paths.sort(), [
    slash(path.join(wt, 'new/file.txt')),
    slash(path.join(wt, 'src/a.txt')),
  ]);
  assert.equal(read(path.join(wt, 'src', 'a.txt')), 'changed\n');
  assert.equal(gitOk(['stash', 'list'], wt), '');
});

test(
  'run sync: conflict -> 3, rebase left open with the unmerged files; again -> 3 (rebase in progress)',
  noGit,
  async (t) => {
    const { root, quick } = setup(t);
    const { token, enter: wt } = await start(root, quick.a);
    commitIn(wt, 'src/a.txt', 'one\nTWO-branch\nthree\n', `step-${quick.a.id}: two`);
    commitIn(root, 'src/a.txt', 'one\nTWO-main\nthree\n', 'architect: two');

    const res = await nos(['run', 'sync', '--token', token], wt);

    assert.equal(res.code, 3);
    assert.equal(res.json.action, 'run-sync');
    assert.deepEqual(res.json.details.files, ['src/a.txt']);
    assert.deepEqual(res.json.details.paths, [slash(path.join(wt, 'src/a.txt'))]);
    assert.equal(res.json.details.rebaseInProgress, true);
    const gitDir = gitOk(['rev-parse', '--absolute-git-dir'], wt);
    assert.ok(existsSync(path.join(gitDir, 'rebase-merge')), 'rebase left open');

    const again = await nos(['run', 'sync', '--token', token], wt);
    assert.equal(again.code, 3);
    assert.match(again.err, /rebase is in progress/);
    assert.deepEqual(again.json.details.files, ['src/a.txt']);

    // resolved: the next sync is clean
    writeFile(wt, 'src/a.txt', 'one\nTWO-both\nthree\n');
    gitOk(['add', 'src/a.txt'], wt);
    gitOk(['-c', 'core.editor=true', 'rebase', '--continue'], wt);
    const clean = await nos(['run', 'sync', '--token', token], wt);
    assert.equal(clean.code, 0, clean.err);
  },
);
