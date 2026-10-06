import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NosError } from '../src/exit-codes.js';
import { initProject } from '../src/init.js';
import { NOS_HOME, resolveRoots } from '../src/roots.js';
import { gitOk, hasGit, initRepo, makeTempRoot, readJson, SPECS_DIR, writeFile } from './helpers.js';

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
// the default specs root: the sibling folder <name>.specs of the project (makeTempRoot removes it too)
const siblingOf = (root) => path.join(path.dirname(root), `${path.basename(root)}.specs`);
// a project whose specs root lies inside it (explicit specs.dir ".specs"), for the .gitignore cases
const inside = (root) => writeFile(root, 'nos.config.json', { specs: { dir: SPECS_DIR, remote: null } });

test(
  'init sets up a git project: nos.config.json, the sibling specs repo with its first commit, .gitignore entry',
  noGit,
  (t) => {
    const root = gitProject(t);
    const head = gitOk(['rev-parse', 'HEAD'], root);

    const result = initProject(rootsOf(root));

    const specs = siblingOf(root);
    const template = JSON.parse(read(path.join(NOS_HOME, 'templates', 'nos.config.json')));
    assert.equal(template.specs.dir, null, 'the template leaves specs.dir to the default');
    assert.deepEqual(readJson(root, 'nos.config.json'), {
      ...template,
      specs: { ...template.specs, dir: '../p.specs' },
    });
    assert.deepEqual(readJson(specs, 'config.json'), {
      project: '../p',
      'id-counters': { domain: 1, phase: 1, step: 1 },
    });
    assert.deepEqual(result.backPointer, { project: '../p', written: true });
    assert.equal(read(path.join(specs, '.gitignore')), '.chat/\n.locks/\n.runs/\n');
    assert.equal(read(path.join(specs, '.gitattributes')), '* text=auto eol=lf\n');
    assert.equal(read(path.join(root, '.gitignore')), '.claude/worktrees/\n');
    assert.deepEqual(result.gitignoreAdded, ['.claude/worktrees/']);

    assert.equal(gitOk(['symbolic-ref', '--short', 'HEAD'], specs), 'main');
    assert.equal(gitOk(['log', '--format=%s'], specs), 'nos: init');
    assert.deepEqual(gitOk(['ls-files'], specs).split('\n').sort(), ['.gitattributes', '.gitignore', 'config.json']);
    assert.equal(result.commit, gitOk(['rev-parse', 'HEAD'], specs));
    assert.equal(gitOk(['rev-parse', 'HEAD'], root), head, 'nothing is committed in the project');
    assert.deepEqual(
      result.created.sort(),
      [
        path.join(root, 'nos.config.json'),
        specs,
        path.join(specs, 'config.json'),
        path.join(specs, '.gitignore'),
        path.join(specs, '.gitattributes'),
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
  const specs = siblingOf(root);
  const files = [
    path.join(root, 'nos.config.json'),
    path.join(root, '.gitignore'),
    ...['config.json', '.gitignore', '.gitattributes'].map((f) => path.join(specs, f)),
  ];
  const before = files.map(read);

  const again = initProject(rootsOf(root));

  assert.deepEqual(again.created, []);
  assert.equal(again.existing.length, 5);
  assert.deepEqual(again.gitignoreAdded, []);
  assert.deepEqual(again.backPointer, { project: '../p', written: false });
  assert.equal(again.commit, null);
  assert.deepEqual(files.map(read), before);
  assert.equal(gitOk(['rev-list', '--count', 'HEAD'], specs), '1');
});

test('the resolver walks from inside the sibling specs root back to the project (back-pointer)', noGit, (t) => {
  const root = gitProject(t);
  initProject(rootsOf(root));
  const specs = siblingOf(root);
  writeFile(specs, 'domain-1-a/idea.md', '# A\n');

  for (const cwd of [specs, path.join(specs, 'domain-1-a')]) {
    const roots = rootsOf(cwd);
    assert.equal(roots.main, root, cwd);
    assert.equal(roots.work, root, cwd);
    assert.equal(roots.specs, specs, cwd);
    assert.equal(roots.configured, true, cwd);
  }
});

test('init (re)writes a stale back-pointer of an existing specs root and leaves it uncommitted', noGit, (t) => {
  const root = gitProject(t);
  initProject(rootsOf(root));
  const specs = siblingOf(root);
  writeFile(specs, 'config.json', { 'id-counters': { domain: 4, phase: 1, step: 1 }, project: '../old-name' });

  const result = initProject(rootsOf(root));

  assert.deepEqual(result.backPointer, { project: '../p', written: true });
  assert.deepEqual(readJson(specs, 'config.json'), {
    'id-counters': { domain: 4, phase: 1, step: 1 },
    project: '../p',
  });
  assert.equal(result.commit, null);
});

test('init leaves .gitattributes alone: an existing file is kept, a specs root with history gets none', noGit, (t) => {
  const own = gitProject(t);
  writeFile(siblingOf(own), '.gitattributes', '* -text\n');
  initProject(rootsOf(own));
  assert.equal(read(path.join(siblingOf(own), '.gitattributes')), '* -text\n');
  assert.ok(gitOk(['ls-files'], siblingOf(own)).split('\n').includes('.gitattributes'));

  // a migrated specs root: repo with history, no .gitattributes -> init adds nothing there
  const migrated = gitProject(t);
  const specs = siblingOf(migrated);
  initRepo(specs);
  writeFile(specs, 'config.json', { 'id-counters': { domain: 2, phase: 1, step: 1 } });
  gitOk(['add', '-A'], specs);
  gitOk(['commit', '-m', 'history'], specs);
  const result = initProject(rootsOf(migrated));
  assert.equal(existsSync(path.join(specs, '.gitattributes')), false);
  assert.equal(result.commit, null);
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
  assert.equal(existsSync(siblingOf(wt)), false);
});

test('init adds origin = specs.remote to the specs root when it has none', noGit, (t) => {
  const root = gitProject(t);
  const remote = initRepo(path.join(makeTempRoot(t), 'specs-backup.git'));
  writeFile(root, 'nos.config.json', { specs: { dir: SPECS_DIR, remote } });

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
  assert.ok(existsSync(path.join(siblingOf(root), 'config.json')));
});

test('init keeps CRLF line endings when it appends to .gitignore', noGit, (t) => {
  const root = gitProject(t);
  inside(root);
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\r\ndist');

  initProject(rootsOf(root));

  assert.equal(read(path.join(root, '.gitignore')), 'node_modules\r\ndist\r\n.specs/\r\n.claude/worktrees/\r\n');
});

test('init recognises existing forms of the entries and patterns that already ignore them', noGit, (t) => {
  for (const [gitignore, added] of [
    ['.specs/*\n.claude/worktrees\n', []],
    ['**/.specs/\n/.claude/worktrees/\n', []],
    ['.specs\n.claude/*\n', []],
    ['.claude/\n', ['.specs/']],
    ['.claude/*\n!.claude/worktrees/\n', ['.specs/', '.claude/worktrees/']],
  ]) {
    const root = gitProject(t);
    inside(root);
    writeFileSync(path.join(root, '.gitignore'), gitignore);
    const result = initProject(rootsOf(root));
    assert.deepEqual(result.gitignoreAdded, added, gitignore);
    assert.ok(read(path.join(root, '.gitignore')).startsWith(gitignore));
  }
});

test('an ignore rule outside the repo .gitignore files (.git/info/exclude) does not count', noGit, (t) => {
  const root = gitProject(t);
  inside(root);
  writeFileSync(path.join(root, '.git', 'info', 'exclude'), '.specs/\n.claude/\n');

  assert.deepEqual(initProject(rootsOf(root)).gitignoreAdded, ['.specs/', '.claude/worktrees/']);
});

test('init reports an origin with another URL as a mismatch and leaves it', noGit, (t) => {
  const root = gitProject(t);
  const remote = path.join(makeTempRoot(t), 'wanted.git');
  writeFile(root, 'nos.config.json', { specs: { dir: SPECS_DIR, remote } });
  initProject(rootsOf(root));
  const specs = path.join(root, SPECS_DIR);
  gitOk(['remote', 'set-url', 'origin', 'https://example.invalid/other.git'], specs);

  const result = initProject(rootsOf(root));

  assert.deepEqual(result.remote, {
    url: remote,
    existing: 'https://example.invalid/other.git',
    added: false,
    mismatch: true,
  });
  assert.equal(gitOk(['remote', 'get-url', 'origin'], specs), 'https://example.invalid/other.git');
});

test('init without a git identity fails with the hint to set user.name and user.email', noGit, (t) => {
  const root = gitProject(t);
  gitOk(['config', '--unset', 'user.name'], root);
  gitOk(['config', '--unset', 'user.email'], root);
  const empty = writeFile(makeTempRoot(t), 'gitconfig', '');
  const names = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];
  const extra = {
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.useConfigOnly',
    GIT_CONFIG_VALUE_0: 'true',
  };
  const saved = Object.fromEntries([...names, ...Object.keys(extra)].map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  for (const k of names) delete process.env[k];
  Object.assign(process.env, extra);

  assert.throws(() => initProject(rootsOf(root)), /git config --global user\.name .* user\.email/);
});

test(
  'without nos.config.json init runs only from the project root: refused in a subfolder and inside nos',
  noGit,
  (t) => {
    const root = gitProject(t);
    const sub = path.join(root, 'src');
    const nos = path.join(root, '.claude', 'skills', 'nos');
    writeFile(sub, 'a.js', '');
    writeFile(nos, 'cli/bin/nos.js', '');

    assert.throws(() => initProject(rootsOf(sub)), /not the top of its git repo.*project root or pass --root/);
    assert.throws(
      () => initProject(resolveRoots({ cwd: nos, env: {}, home: nos })),
      /inside the nos folder.*project root or pass --root/,
    );
    assert.equal(existsSync(path.join(sub, 'nos.config.json')), false);

    const viaRoot = resolveRoots({ root, cwd: nos, env: {}, home: nos });
    initProject(viaRoot);
    assert.ok(existsSync(path.join(root, 'nos.config.json')));
    // set up: from inside nos the walk now lands on the project
    assert.equal(initProject(resolveRoots({ cwd: nos, env: {}, home: nos })).created.length, 0);
  },
);
