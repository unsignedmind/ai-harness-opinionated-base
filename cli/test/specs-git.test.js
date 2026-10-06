import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError } from '../src/exit-codes.js';
import { slash } from '../src/roots.js';
import { writeRun } from '../src/runs.js';
import { commitSpecs, findStep } from '../src/specs-git.js';
import { gitOk, hasGit, initRepo, invokeCli, makeProject, makeRoots, makeTempRoot, writeFile } from './helpers.js';

const noGit = { skip: !hasGit && 'git is not available' };

// A project whose .specs is its own repo with two domains committed
function specsProject(t, config = {}) {
  const { root, roots } = makeProject(t, { git: true, config });
  initRepo(roots.specs);
  writeFile(roots.specs, 'domain-1-auth/idea.md', '# Auth\n');
  writeFile(roots.specs, 'domain-2-ui/idea.md', '# UI\n');
  gitOk(['add', '-A'], roots.specs);
  gitOk(['commit', '-m', 'nos: init'], roots.specs);
  return { root, roots };
}

const porcelain = (dir) => gitOk(['status', '--porcelain'], dir);
const lastFiles = (dir) => gitOk(['show', '--name-only', '--format=', 'HEAD'], dir).split('\n').filter(Boolean);

test('commitSpecs commits config.json + the domain only; another domain stays unstaged', noGit, (t) => {
  const { roots } = specsProject(t);
  writeFile(roots.specs, 'domain-1-auth/plan.json', '{}');
  writeFile(roots.specs, 'domain-1-auth/idea.md', '# Auth v2\n');
  writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 3, phase: 1, step: 1 } });
  writeFile(roots.specs, 'domain-2-ui/idea.md', '# UI v2\n');
  writeFile(roots.specs, 'domain-2-ui/new.md', 'x');
  writeFile(roots.specs, 'stray.md', 'x');

  const result = commitSpecs(roots, { domain: 'domain-1-auth', message: 'step-1: develop' });

  assert.equal(result.action, 'specs-commit');
  assert.equal(result.committed, true);
  assert.equal(result.sha, gitOk(['rev-parse', 'HEAD'], roots.specs));
  assert.equal(result.pushed, false);
  assert.deepEqual(result.files.sort(), [
    slash(path.join(roots.specs, 'config.json')),
    slash(path.join(roots.specs, 'domain-1-auth/idea.md')),
    slash(path.join(roots.specs, 'domain-1-auth/plan.json')),
  ]);
  assert.deepEqual(lastFiles(roots.specs).sort(), ['config.json', 'domain-1-auth/idea.md', 'domain-1-auth/plan.json']);
  assert.equal(gitOk(['log', '-1', '--format=%s'], roots.specs), 'step-1: develop');
  const left = porcelain(roots.specs);
  assert.match(left, /M domain-2-ui\/idea\.md/);
  assert.equal(gitOk(['diff', '--cached', '--name-only'], roots.specs), '', 'nothing left staged');
  assert.match(left, /\?\? domain-2-ui\/new\.md/);
  assert.match(left, /\?\? stray\.md/);
});

test('commitSpecs stages deletions inside the domain and keeps files another writer staged out', noGit, (t) => {
  const { roots } = specsProject(t);
  writeFile(roots.specs, 'domain-2-ui/staged.md', 'x');
  gitOk(['add', 'domain-2-ui/staged.md'], roots.specs);
  rmSync(path.join(roots.specs, 'domain-1-auth', 'idea.md'));
  writeFile(roots.specs, 'domain-1-auth/plan.json', '{}');

  const result = commitSpecs(roots, { domain: 'domain-1-auth', message: 'x' });

  assert.equal(result.committed, true);
  assert.deepEqual(lastFiles(roots.specs).sort(), ['domain-1-auth/idea.md', 'domain-1-auth/plan.json']);
  assert.match(porcelain(roots.specs), /^A {2}domain-2-ui\/staged\.md/m, 'still staged, not committed');
});

test('commitSpecs with nothing to commit: committed false, sha null, no commit', noGit, (t) => {
  const { roots } = specsProject(t);
  const head = gitOk(['rev-parse', 'HEAD'], roots.specs);

  const result = commitSpecs(roots, { domain: 'domain-1-auth', message: 'x' });

  assert.deepEqual(result, {
    action: 'specs-commit',
    domain: 'domain-1-auth',
    committed: false,
    sha: null,
    pushed: false,
    files: [],
  });
  assert.equal(gitOk(['rev-parse', 'HEAD'], roots.specs), head);
});

test('commitSpecs with domain null commits config.json only', noGit, (t) => {
  const { roots } = specsProject(t);
  writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 3, phase: 1, step: 1 }, chat: { port: 4700 } });
  writeFile(roots.specs, 'domain-1-auth/plan.json', '{}');

  const result = commitSpecs(roots, { domain: null, message: 'setup: chat' });

  assert.equal(result.committed, true);
  assert.equal(result.domain, null);
  assert.deepEqual(lastFiles(roots.specs), ['config.json']);
  assert.match(porcelain(roots.specs), /\?\? domain-1-auth\//);
});

test('commitSpecs retries while another writer holds index.lock', noGit, (t) => {
  const { roots } = specsProject(t);
  writeFile(roots.specs, 'domain-1-auth/plan.json', '{}');
  const indexLock = path.join(roots.specs, '.git', 'index.lock');
  writeFileSync(indexLock, '');
  // another process removes it after 300ms (commitSpecs blocks this thread while it retries)
  const remover = spawn(process.execPath, [
    '-e',
    `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(indexLock)}), 300)`,
  ]);
  t.after(() => remover.kill());

  const result = commitSpecs(roots, { domain: 'domain-1-auth', message: 'x' });

  assert.equal(result.committed, true);
});

test('commitSpecs gives up after the retries when index.lock stays', noGit, (t) => {
  const { roots } = specsProject(t);
  writeFile(roots.specs, 'domain-1-auth/plan.json', '{}');
  writeFileSync(path.join(roots.specs, '.git', 'index.lock'), '');

  assert.throws(
    () => commitSpecs(roots, { domain: 'domain-1-auth', message: 'x' }),
    (err) => err instanceof NosError && err.code === FAILED && /index\.lock/.test(err.message),
  );
});

test('commitSpecs pushes when specs.remote is set; a failed push is a warning', noGit, (t) => {
  const remote = path.join(makeTempRoot(t), 'specs.git');
  gitOk(['init', '-q', '--bare', remote], path.dirname(remote));
  const { roots } = specsProject(t, { specs: { dir: '.specs', remote } });
  gitOk(['remote', 'add', 'origin', remote], roots.specs);
  writeFile(roots.specs, 'domain-1-auth/plan.json', '{}');

  const pushed = commitSpecs(roots, { domain: 'domain-1-auth', message: 'x' });
  assert.equal(pushed.pushed, true);
  assert.equal(gitOk(['rev-parse', 'main'], remote), pushed.sha);

  gitOk(['remote', 'set-url', 'origin', path.join(remote, 'missing')], roots.specs);
  writeFile(roots.specs, 'domain-1-auth/plan.json', '{"a":1}');
  const failed = commitSpecs(roots, { domain: 'domain-1-auth', message: 'y' });
  assert.equal(failed.committed, true);
  assert.equal(failed.pushed, false);
  assert.match(failed.warning, /push to origin failed/);
});

test('commitSpecs refuses a specs root that is not its own repo (never reaches the project repo)', noGit, (t) => {
  const { roots } = makeProject(t, { git: true });
  writeFile(roots.specs, 'domain-1-auth/idea.md', 'x');
  assert.throws(() => commitSpecs(roots, { domain: 'domain-1-auth', message: 'x' }), /not its own git repo/);
});

test('nos specs commit: --run, --domain or --config, exactly one; -m required', noGit, async (t) => {
  const { root, roots } = specsProject(t);
  writeRun(roots, { kind: 'quick', id: 7, domain: 'domain-2-ui', token: 'x', phase: 'develop' });
  writeFile(roots.specs, 'domain-2-ui/x.md', 'x');
  writeFile(roots.specs, 'domain-1-auth/x.md', 'x');

  const viaRun = await invokeCli(['specs', 'commit', '--run', 'quick-7', '-m', 'step-7: develop'], { cwd: root });
  assert.equal(viaRun.code, 0, viaRun.err);
  assert.equal(viaRun.json.action, 'specs-commit');
  assert.equal(viaRun.json.domain, 'domain-2-ui');
  assert.deepEqual(lastFiles(roots.specs), ['domain-2-ui/x.md']);

  const viaDomain = await invokeCli(['specs', 'commit', '--domain', 'domain-1-auth', '--message', 'idea'], {
    cwd: root,
  });
  assert.equal(viaDomain.code, 0, viaDomain.err);
  assert.deepEqual(lastFiles(roots.specs), ['domain-1-auth/x.md']);

  writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 9, phase: 1, step: 1 } });
  const viaConfig = await invokeCli(['specs', 'commit', '--config', '-m', 'setup'], { cwd: root });
  assert.equal(viaConfig.code, 0, viaConfig.err);
  assert.deepEqual(lastFiles(roots.specs), ['config.json']);

  const usage = (args) => invokeCli(['specs', ...args], { cwd: root }).then((r) => r.code);
  assert.equal(await usage(['commit', '-m', 'x']), 2, 'none of the three');
  assert.equal(await usage(['commit', '--config', '--domain', 'domain-1-auth', '-m', 'x']), 2, 'two of them');
  assert.equal(await usage(['commit', '--config']), 2, 'no message');
  assert.equal(await usage(['commit', '--run', 'bogus', '-m', 'x']), 2);
  assert.equal(await usage(['push']), 2);
  assert.equal(await usage([]), 2);
  assert.equal(await usage(['commit', '--run', 'quick-99', '-m', 'x']), 1, 'no such run');
  assert.equal(await usage(['commit', '--domain', 'domain-9-none', '-m', 'x']), 1, 'no such domain');
});

// specs with a plan (steps 1, 2 in phase 1) in domain 1 and a quick step 5 in domain 2
function stepsProject(t) {
  const roots = makeRoots(t);
  const plan = {
    name: 'Auth',
    status: 'open',
    phases: [
      {
        slug: 'a',
        steps: [
          { slug: 'one', intent: 'One', status: 'open', 'spec-file': 'domain-1-auth/phases/phase-1-a/step-1-one.md' },
          { slug: 'two', intent: 'Two', status: 'done', 'spec-file': 'domain-1-auth/phases/phase-1-a/step-2-two.md' },
        ],
      },
    ],
  };
  writeFile(roots.specs, 'domain-1-auth/plan.json', plan);
  writeFile(roots.specs, 'domain-2-ui/quick-steps/quick-steps.json', [
    { slug: 'fix', intent: 'Fix', status: 'open', 'spec-file': 'domain-2-ui/quick-steps/step-5-fix.md' },
  ]);
  return roots;
}

test('findStep finds plan steps and quick steps in any domain, spec file absolute', (t) => {
  const roots = stepsProject(t);

  assert.deepEqual(findStep(roots, 2), {
    action: 'find-step',
    id: 2,
    domain: 'domain-1-auth',
    kind: 'plan',
    phase: 1,
    step: 2,
    slug: 'two',
    intent: 'Two',
    status: 'done',
    specFile: slash(path.join(roots.specs, 'domain-1-auth/phases/phase-1-a/step-2-two.md')),
  });
  const quick = findStep(roots, '5');
  assert.equal(quick.kind, 'quick');
  assert.equal(quick.domain, 'domain-2-ui');
  assert.equal(quick.phase, null);
  assert.equal(quick.specFile, slash(path.join(roots.specs, 'domain-2-ui/quick-steps/step-5-fix.md')));
  assert.throws(
    () => findStep(roots, 3),
    (err) => err instanceof NosError && err.code === FAILED,
  );
});

test('nos specs find-step: not found -> exit 1, bad id -> 2', async (t) => {
  const roots = stepsProject(t);
  const ok = await invokeCli(['specs', 'find-step', '1'], { cwd: roots.work });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json.action, 'find-step');
  assert.equal(ok.json.slug, 'one');

  assert.equal((await invokeCli(['specs', 'find-step', '30'], { cwd: roots.work })).code, 1);
  assert.equal((await invokeCli(['specs', 'find-step', 'x'], { cwd: roots.work })).code, 2);
  assert.equal((await invokeCli(['specs', 'find-step'], { cwd: roots.work })).code, 2);
});
