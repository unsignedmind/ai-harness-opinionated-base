import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NosError } from '../src/exit-codes.js';
import { initProject } from '../src/init.js';
import { NOS_HOME, resolveRoots, SPECS_DIR } from '../src/roots.js';
import { gitOk, hasGit, initRepo, makeTempRoot, readJson, writeFile } from './helpers.js';

const noGit = { skip: !hasGit && 'git is not available' };

// a git project without nos layout, with one commit
function gitProject(t) {
  const root = initRepo(makeTempRoot(t));
  writeFile(root, 'README.md', '# app\n');
  gitOk(['add', '-A'], root);
  gitOk(['commit', '-m', 'app'], root);
  return root;
}

const rootsOf = (cwd) => resolveRoots({ cwd, env: {} });
const read = (file) => readFileSync(file, 'utf8');

test(
  'init sets up a git project: nos.config.json, .specs repo with its first commit, .gitignore entries',
  noGit,
  (t) => {
    const root = gitProject(t);
    const head = gitOk(['rev-parse', 'HEAD'], root);

    const result = initProject(rootsOf(root));

    const specs = path.join(root, SPECS_DIR);
    assert.deepEqual(
      readJson(root, 'nos.config.json'),
      JSON.parse(read(path.join(NOS_HOME, 'templates', 'nos.config.json'))),
    );
    assert.deepEqual(readJson(specs, 'config.json'), { 'id-counters': { domain: 1, phase: 1, step: 1 } });
    assert.equal(read(path.join(specs, '.gitignore')), '.chat/\n.locks/\n.runs/\n');
    assert.equal(read(path.join(root, '.gitignore')), '.specs/\n.claude/worktrees/\n');
    assert.deepEqual(result.gitignoreAdded, ['.specs/', '.claude/worktrees/']);

    assert.equal(gitOk(['symbolic-ref', '--short', 'HEAD'], specs), 'main');
    assert.equal(gitOk(['log', '--format=%s'], specs), 'nos: init');
    assert.deepEqual(gitOk(['ls-files'], specs).split('\n').sort(), ['.gitignore', 'config.json']);
    assert.equal(result.commit, gitOk(['rev-parse', 'HEAD'], specs));
    assert.equal(gitOk(['rev-parse', 'HEAD'], root), head, 'nothing is committed in the project');
    assert.deepEqual(
      result.created.sort(),
      [
        path.join(root, 'nos.config.json'),
        specs,
        path.join(specs, 'config.json'),
        path.join(specs, '.gitignore'),
        path.join(specs, '.git'),
      ].sort(),
    );
    assert.deepEqual(result.existing, []);
    assert.equal(result.remote, null);
  },
);

test('init is idempotent: a second run creates, commits and appends nothing', noGit, (t) => {
  const root = gitProject(t);
  initProject(rootsOf(root));
  const files = ['nos.config.json', '.gitignore', '.specs/config.json', '.specs/.gitignore'];
  const before = files.map((f) => read(path.join(root, f)));

  const again = initProject(rootsOf(root));

  assert.deepEqual(again.created, []);
  assert.equal(again.existing.length, 5);
  assert.deepEqual(again.gitignoreAdded, []);
  assert.equal(again.commit, null);
  assert.deepEqual(
    files.map((f) => read(path.join(root, f))),
    before,
  );
  assert.equal(gitOk(['rev-list', '--count', 'HEAD'], path.join(root, SPECS_DIR)), '1');
});

test('init appends only the missing .gitignore entries and keeps an existing nos.config.json', noGit, (t) => {
  const root = gitProject(t);
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n/.specs');
  const config = { specs: { dir: '.specs', remote: null }, 'quality-tools': { test: 'npm test' } };
  writeFile(root, 'nos.config.json', config);

  const result = initProject(rootsOf(root));

  assert.deepEqual(result.gitignoreAdded, ['.claude/worktrees/']);
  assert.equal(read(path.join(root, '.gitignore')), 'node_modules\n/.specs\n.claude/worktrees/\n');
  assert.deepEqual(readJson(root, 'nos.config.json'), config);
  assert.ok(result.existing.includes(path.join(root, 'nos.config.json')));
});

test('init is refused inside a worktree', noGit, (t) => {
  const root = gitProject(t);
  initProject(rootsOf(root));
  gitOk(['add', '-A'], root);
  gitOk(['commit', '-m', 'nos'], root);
  const wt = path.join(root, '.claude', 'worktrees', 'quick-1');
  gitOk(['worktree', 'add', '-b', 'quick-1', wt], root);

  assert.throws(
    () => initProject(rootsOf(wt)),
    (err) => err instanceof NosError && err.code === 1 && /not in a worktree/.test(err.message),
  );
  assert.equal(existsSync(path.join(wt, SPECS_DIR)), false);
});

test('init adds origin = specs.remote to .specs when it has none', noGit, (t) => {
  const root = gitProject(t);
  const remote = initRepo(path.join(makeTempRoot(t), 'specs-backup.git'));
  writeFile(root, 'nos.config.json', { specs: { dir: '.specs', remote } });

  const first = initProject(rootsOf(root));
  const second = initProject(rootsOf(root));

  assert.deepEqual(first.remote, { url: remote, added: true });
  assert.deepEqual(second.remote, { url: remote, added: false });
  assert.equal(gitOk(['remote', 'get-url', 'origin'], path.join(root, SPECS_DIR)), remote);
});

test('init without a git project writes no project .gitignore', (t) => {
  const root = makeTempRoot(t);

  const result = initProject(rootsOf(root));

  assert.equal(existsSync(path.join(root, '.gitignore')), false);
  assert.deepEqual(result.gitignoreAdded, []);
  assert.ok(existsSync(path.join(root, 'nos.config.json')));
  assert.ok(existsSync(path.join(root, SPECS_DIR, 'config.json')));
});
