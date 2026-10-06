import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.js';
import { findWorkRoot, homeGuard, resolveRoots, slash, SPECS_DIR } from '../src/roots.js';
import { gitOk, hasGit, initRepo, makeProject, makeTempRoot, writeFile } from './helpers.js';

const noGit = { skip: !hasGit && 'git is not available' };

// nos roots through the CLI, as the orchestrator calls it
function nosRoots(cwd, { env = {}, home } = {}) {
  let out = '';
  let err = '';
  const code = run(['roots'], {
    cwd,
    env,
    ...(home && { home }),
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
  });
  assert.equal(code, 0, err);
  return JSON.parse(out);
}

// a run worktree of the project like nos run start creates it: <main>/.claude/worktrees/<name> on branch <name>
function addWorktree(root, name = 'quick-1') {
  const wt = path.join(root, '.claude', 'worktrees', name);
  gitOk(['worktree', 'add', '-b', name, wt], root);
  return wt;
}

test('plain dir without nos.config.json: work = main = cwd, specs = cwd/.specs', (t) => {
  const root = makeTempRoot(t);

  const roots = resolveRoots({ cwd: root, env: {} });

  assert.equal(roots.work, root);
  assert.equal(roots.main, root);
  assert.equal(roots.specs, path.join(root, SPECS_DIR));
  assert.equal(roots.inWorktree, false);
  assert.equal(roots.git, false);
});

test('the walk from a subfolder lands on the folder with nos.config.json', (t) => {
  const { root } = makeProject(t);
  const deep = path.join(root, 'src', 'lib');
  mkdirSync(deep, { recursive: true });

  assert.equal(findWorkRoot(deep), root);
  const roots = resolveRoots({ cwd: deep, env: {} });
  assert.equal(roots.work, root);
  assert.equal(roots.main, root);
  assert.equal(roots.specs, path.join(root, SPECS_DIR));
});

test('specs.dir of nos.config.json sets the specs root', (t) => {
  const { root } = makeProject(t, { config: { specs: { dir: 'planning' } } });
  assert.equal(resolveRoots({ cwd: root, env: {} }).specs, path.join(root, 'planning'));
});

test('main repo: main = work, git true, not in a worktree', noGit, (t) => {
  const { root } = makeProject(t, { git: true });

  const roots = resolveRoots({ cwd: root, env: {} });

  assert.deepEqual(
    { work: roots.work, main: roots.main, specs: roots.specs, inWorktree: roots.inWorktree, git: roots.git },
    { work: root, main: root, specs: path.join(root, SPECS_DIR), inWorktree: false, git: true },
  );
});

test('git worktree: work = the worktree, main and specs = the main checkout', noGit, (t) => {
  const { root } = makeProject(t, { git: true });
  const wt = addWorktree(root);
  mkdirSync(path.join(wt, 'src'), { recursive: true });

  for (const cwd of [wt, path.join(wt, 'src')]) {
    const roots = resolveRoots({ cwd, env: {} });
    assert.equal(roots.work, wt);
    assert.equal(roots.main, root);
    assert.equal(roots.specs, path.join(root, SPECS_DIR));
    assert.equal(roots.inWorktree, true);
    assert.equal(roots.git, true);
  }
});

test('specs.dir is read from main, not from the worktree (a branch cannot move the specs)', noGit, (t) => {
  const { root } = makeProject(t, { git: true });
  const wt = addWorktree(root);
  writeFile(wt, 'nos.config.json', { specs: { dir: 'elsewhere' } });

  assert.equal(resolveRoots({ cwd: wt, env: {} }).specs, path.join(root, SPECS_DIR));
});

test(
  'from inside nested repos (<main>/.claude/skills/nos, <main>/.specs) the walk lands on the project',
  noGit,
  (t) => {
    const { root } = makeProject(t, { git: true });
    const nos = initRepo(path.join(root, '.claude', 'skills', 'nos'));
    writeFile(nos, 'cli/bin/nos.js', '');
    gitOk(['add', '-A'], nos);
    gitOk(['commit', '-m', 'nos'], nos);
    const specs = initRepo(path.join(root, SPECS_DIR));
    gitOk(['add', '-A'], specs);
    gitOk(['commit', '-m', 'specs'], specs);

    for (const cwd of [nos, path.join(nos, 'cli', 'bin'), specs]) {
      const roots = resolveRoots({ cwd, env: {} });
      assert.equal(roots.work, root, cwd);
      assert.equal(roots.main, root, cwd);
      assert.equal(roots.specs, path.join(root, SPECS_DIR), cwd);
      assert.equal(roots.inWorktree, false, cwd);
    }
  },
);

test(
  'nos roots prints the same specs from main, a worktree, <main>/.claude/skills/nos and <main>/.specs',
  noGit,
  (t) => {
    const { root } = makeProject(t, { git: true });
    const wt = addWorktree(root);
    const nos = initRepo(path.join(root, '.claude', 'skills', 'nos'));
    const specs = initRepo(path.join(root, SPECS_DIR));
    const home = nos;

    const results = [root, wt, nos, specs].map((cwd) => nosRoots(cwd, { home }));

    const expected = slash(path.join(root, SPECS_DIR));
    assert.deepEqual(
      results.map((r) => r.specs),
      [expected, expected, expected, expected],
    );
    assert.deepEqual(
      results.map((r) => r.main),
      Array(4).fill(slash(root)),
    );
    assert.deepEqual(
      results.map((r) => r.inWorktree),
      [false, true, false, false],
    );
    assert.equal(results[1].work, slash(wt));
    for (const r of results)
      for (const key of ['home', 'work', 'main', 'specs']) assert.ok(!r[key].includes('\\'), key);
  },
);

test('NOS_SPECS_ROOT sets the work root; --root wins over it; both resolve against cwd', noGit, (t) => {
  const { root } = makeProject(t, { git: true });
  const wt = addWorktree(root);
  const elsewhere = makeTempRoot(t);

  const viaEnv = resolveRoots({ cwd: elsewhere, env: { NOS_SPECS_ROOT: wt } });
  assert.equal(viaEnv.work, wt);
  assert.equal(viaEnv.main, root);
  assert.equal(viaEnv.inWorktree, true);

  const viaRoot = resolveRoots({ root, cwd: elsewhere, env: { NOS_SPECS_ROOT: wt } });
  assert.equal(viaRoot.work, root);
  assert.equal(viaRoot.inWorktree, false);

  const relative = resolveRoots({ root: path.relative(elsewhere, wt), cwd: elsewhere, env: {} });
  assert.equal(relative.work, wt);
});

test('--root is used as given: no walk up to nos.config.json', (t) => {
  const { root } = makeProject(t);
  const sub = path.join(root, 'packages', 'a');
  mkdirSync(sub, { recursive: true });
  assert.equal(resolveRoots({ root: sub, cwd: root, env: {} }).work, sub);
});

test('home guard: quiet for the project nos, warns for another nos and for a copy inside a worktree', (t) => {
  const { root } = makeProject(t);
  const projectNos = path.join(root, '.claude', 'skills', 'nos');
  mkdirSync(projectNos, { recursive: true });
  const roots = resolveRoots({ cwd: root, env: {} });
  const sink = () => {
    const lines = [];
    return { lines, write: (s) => lines.push(s) };
  };

  const quiet = sink();
  assert.deepEqual(homeGuard({ ...roots, home: projectNos }, quiet), []);
  assert.deepEqual(quiet.lines, []);

  const other = sink();
  const otherHome = path.join(makeTempRoot(t), 'nos');
  assert.equal(homeGuard({ ...roots, home: otherHome }, other).length, 1);
  assert.match(other.lines[0], /warning: running .*the project's nos is .*\/\.claude\/skills\/nos/);

  const inWorktree = sink();
  const copy = path.join(root, '.claude', 'worktrees', 'quick-1', '.claude', 'skills', 'nos');
  const warnings = homeGuard({ ...roots, home: copy }, inWorktree);
  assert.equal(warnings.length, 2);
  assert.match(inWorktree.lines[1], /inside a worktree/);
});
