import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.js';
import { git, gitEnv } from '../src/git.js';
import { initProject } from '../src/init.js';
import { findWorkRoot, homeGuard, resolveRoots, slash, SPECS_DIR, worktreeProjectDir } from '../src/roots.js';
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

test("home guard: a nos under another project's .claude/worktrees/ is not a worktree copy of this one", (t) => {
  const { root } = makeProject(t);
  const roots = resolveRoots({ cwd: root, env: {} });
  const lines = [];
  const foreign = path.join(makeTempRoot(t), '.claude', 'worktrees', 'quick-1', '.claude', 'skills', 'nos');
  assert.deepEqual(homeGuard({ ...roots, home: foreign }, { write: (s) => lines.push(s) }), []);
  assert.deepEqual(lines, []);
});

// git project: README committed, worktree quick-1 cut from that commit, nos.config.json committed on main afterwards
function worktreeBeforeConfig(t) {
  const root = initRepo(makeTempRoot(t));
  writeFile(root, 'README.md', '# app\n');
  writeFile(root, '.gitignore', '.specs/\n.claude/worktrees/\n');
  gitOk(['add', '-A'], root);
  gitOk(['commit', '-m', 'app'], root);
  const wt = path.join(root, '.claude', 'worktrees', 'quick-1');
  gitOk(['worktree', 'add', '-b', 'quick-1', wt], root);
  writeFile(root, 'nos.config.json', { specs: { dir: SPECS_DIR, remote: null } });
  writeFile(root, `${SPECS_DIR}/config.json`, { 'id-counters': { domain: 1, phase: 1, step: 1 } });
  gitOk(['add', 'nos.config.json'], root);
  gitOk(['commit', '-m', 'nos'], root);
  return { root, wt };
}

test(
  'a worktree whose branch has no nos.config.json yet stays the work root (the walk climbed out of it)',
  noGit,
  (t) => {
    const { root, wt } = worktreeBeforeConfig(t);
    mkdirSync(path.join(wt, 'src'), { recursive: true });

    for (const cwd of [wt, path.join(wt, 'src')]) {
      const roots = resolveRoots({ cwd, env: {} });
      assert.equal(roots.work, wt, cwd);
      assert.equal(roots.main, root);
      assert.equal(roots.specs, path.join(root, SPECS_DIR));
      assert.equal(roots.inWorktree, true);
      assert.equal(roots.configured, true, 'main has nos.config.json');
    }
    assert.throws(() => initProject(resolveRoots({ cwd: wt, env: {} })), /not in a worktree/);
  },
);

// monorepo: repo R, project R/app (nos.config.json committed there), worktree <R/app>/.claude/worktrees/quick-1
function monorepo(t) {
  const repo = initRepo(makeTempRoot(t));
  const app = path.join(repo, 'app');
  writeFile(app, 'nos.config.json', { specs: { dir: SPECS_DIR, remote: null } });
  writeFile(app, '.gitignore', '.specs/\n.claude/worktrees/\n');
  writeFile(app, 'src/index.js', '');
  writeFile(app, `${SPECS_DIR}/config.json`, { 'id-counters': { domain: 1, phase: 1, step: 1 } });
  gitOk(['add', '-A'], repo);
  gitOk(['commit', '-m', 'app'], repo);
  const wt = path.join(app, '.claude', 'worktrees', 'quick-1');
  gitOk(['worktree', 'add', '-b', 'quick-1', wt], app);
  return { repo, app, wt };
}

test('monorepo subfolder project: main is the project folder, a worktree maps to <wt>/<offset>', noGit, (t) => {
  const { app, wt } = monorepo(t);

  const fromMain = resolveRoots({ cwd: path.join(app, 'src'), env: {} });
  assert.deepEqual(
    [fromMain.work, fromMain.main, fromMain.specs, fromMain.inWorktree, fromMain.offset],
    [app, app, path.join(app, SPECS_DIR), false, 'app'],
  );

  for (const cwd of [path.join(wt, 'app'), path.join(wt, 'app', 'src'), wt]) {
    const roots = resolveRoots({ cwd, env: {} });
    assert.equal(roots.work, path.join(wt, 'app'), cwd);
    assert.equal(roots.main, app, cwd);
    assert.equal(roots.specs, path.join(app, SPECS_DIR), cwd);
    assert.equal(roots.inWorktree, true, cwd);
  }
});

test('worktreeProjectDir: the project folder inside a worktree exists at <wt>/<offset>', noGit, (t) => {
  const { app, wt } = monorepo(t);
  const roots = resolveRoots({ cwd: app, env: {} });
  assert.equal(worktreeProjectDir(roots, wt), path.join(wt, 'app'));
  assert.equal(resolveRoots({ cwd: worktreeProjectDir(roots, wt), env: {} }).work, path.join(wt, 'app'));

  const { root } = makeProject(t, { git: true });
  const plain = resolveRoots({ cwd: root, env: {} });
  assert.equal(plain.offset, '');
  assert.equal(
    worktreeProjectDir(plain, path.join(root, '.claude', 'worktrees', 'x')),
    path.join(root, '.claude', 'worktrees', 'x'),
  );
});

test('configured and via tell how the roots were found', (t) => {
  const { root } = makeProject(t);
  const bare = makeTempRoot(t);
  assert.deepEqual(pick(resolveRoots({ cwd: root, env: {} })), { configured: true, via: 'walk' });
  assert.deepEqual(pick(resolveRoots({ cwd: bare, env: {} })), { configured: false, via: 'cwd' });
  assert.deepEqual(pick(resolveRoots({ cwd: bare, env: { NOS_SPECS_ROOT: root } })), { configured: true, via: 'env' });
  assert.deepEqual(pick(resolveRoots({ root: bare, cwd: root, env: {} })), { configured: false, via: 'root' });
  assert.equal(nosRoots(bare).configured, false);
});
const pick = ({ configured, via }) => ({ configured, via });

test('git calls ignore GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR of a calling hook', noGit, (t) => {
  const { root } = makeProject(t, { git: true });
  const other = initRepo(makeTempRoot(t));
  const saved = Object.fromEntries(
    ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].map((k) => [k, process.env[k]]),
  );
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  Object.assign(process.env, {
    GIT_DIR: path.join(other, '.git'),
    GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(other, '.git', 'index'),
    GIT_COMMON_DIR: path.join(other, '.git'),
  });

  assert.equal(gitEnv().GIT_DIR, undefined);
  const top = git(['rev-parse', '--show-toplevel'], { cwd: root }).stdout.trim();
  assert.equal(path.resolve(top), root);
  assert.equal(resolveRoots({ cwd: root, env: {} }).main, root);
});
