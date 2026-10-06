import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockStatus, takeLock } from '../src/lock.js';
import { readRun, writeRun } from '../src/runs.js';
import { gitOk, makeTempRoot, writeFile } from './helpers.js';
import { branchExists, commitIn, done, head, mergeHeld, noGit, nos, quickStatus, setup, start } from './run-helpers.js';

// Guards of the run lifecycle: races between sessions, crashes, tokens never leaking, leftovers in worktrees.

const NOS_BIN = fileURLToPath(new URL('../bin/nos.js', import.meta.url));

// nos in a child process (a second session): { code, stdout, stderr }
function nosChild(args, cwd) {
  const env = { ...process.env };
  for (const name of ['NOS_SPECS_ROOT', 'NOS_RUN_TOKEN', 'NOS_HOME']) delete env[name];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NOS_BIN, ...args], { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const startArgs = (q) => ['run', 'start', '--domain', q.domain, '--quick', String(q.id)];

test('two sessions start the same run at once: exactly one gets it, the other gets 4', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const results = await Promise.all([nosChild(startArgs(quick.a), root), nosChild(startArgs(quick.a), root)]);
  const codes = results.map((r) => r.code).sort();
  assert.deepEqual(codes, [0, 4], results.map((r) => r.stderr).join('\n'));
  const winner = JSON.parse(results.find((r) => r.code === 0).stdout);
  assert.equal(readRun(roots, quick.a.runId).token, winner.token, 'the printed token is the valid one');
  assert.equal(lockStatus(roots, 'runs').held, false);
});

test('two sessions start two quick steps of one domain at once: one run, the other gets 6', noGit, async (t) => {
  const { root, roots, quick } = setup(t, { slugs: ['a'] });
  const { createQuickStep } = await import('../src/quick-step.js');
  const { id } = createQuickStep(roots, { domain: quick.a.domain, step: { slug: 'second', intent: 'x' } });
  const second = { domain: quick.a.domain, id };
  const results = await Promise.all([nosChild(startArgs(quick.a), root), nosChild(startArgs(second), root)]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 6], results.map((r) => r.stderr).join('\n'));
  const { listRuns } = await import('../src/runs.js');
  assert.equal(listRuns(roots).length, 1);
});

test('run start warns when .claude/worktrees is not ignored by the project', noGit, async (t) => {
  const { root, quick } = setup(t);
  writeFile(root, '.gitignore', '.specs/\n');
  gitOk(['commit', '-qam', 'ignore less'], root);
  const out = await start(root, quick.a);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /not ignored/);
});

test('take-over is refused while the old holder still runs a finish; a dead holder is taken over', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  takeLock(roots, 'merge', { run: quick.a.runId, token: a.token, command: 'run finish' });

  const alive = await nos([...startArgs(quick.a), '--take-over'], root);
  assert.equal(alive.code, 4);
  assert.match(alive.err, /still running/);
  assert.equal(alive.json.details.holder.run, quick.a.runId);
  assert.doesNotMatch(alive.out, new RegExp(a.token), 'no foreign token in the output');
  assert.equal(readRun(roots, quick.a.runId).token, a.token);

  const holderFile = path.join(roots.specs, '.locks', 'merge', 'holder.json');
  const holder = JSON.parse(readFileSync(holderFile, 'utf8'));
  writeFile(path.dirname(holderFile), 'holder.json', { ...holder, pid: 999999 });
  const dead = await nos([...startArgs(quick.a), '--take-over'], root);
  assert.equal(dead.code, 0, dead.err);
  assert.equal(mergeHeld(roots), false, 'the dead holder lock is released');
});

test('printed lock holders never carry the token: exit 4 details and lock status', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  const b = await start(root, quick.b);
  commitIn(b.enter, 'src/y.txt', 'y\n', `step-${quick.b.id}: y`);
  done(roots, quick.b);
  takeLock(roots, 'merge', { run: quick.a.runId, token: a.token, command: 'run finish' });

  const blocked = await nos(['run', 'finish', '--token', b.token], b.enter);
  assert.equal(blocked.code, 4);
  assert.equal('token' in blocked.json.details.holder, false);
  assert.doesNotMatch(blocked.out, new RegExp(a.token));
  const status = await nos(['lock', 'status', 'merge'], root);
  assert.equal(status.json.holder.run, quick.a.runId);
  assert.doesNotMatch(status.out, new RegExp(a.token));
  const all = await nos(['lock', 'status'], root);
  assert.doesNotMatch(all.out, new RegExp(a.token));
  assert.equal(
    JSON.parse(readFileSync(path.join(roots.specs, '.locks', 'merge', 'holder.json'), 'utf8')).token,
    a.token,
  );
});

// A gate tool that commits to main (like an architect commit landing during the gate) the first <limit> times
function mainMover(t, limit) {
  const dir = makeTempRoot(t);
  const script = writeFile(
    dir,
    'move-main.cjs',
    `const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const marker = ${JSON.stringify(path.join(dir, 'count'))};
const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
if (count < ${limit}) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trim();
  execFileSync('git', ['-C', path.dirname(common), 'commit', '--allow-empty', '-q', '-m', 'architect: moved']);
  fs.writeFileSync(marker, String(count + 1));
}
`,
  );
  return `node "${script}"`;
}

test('finish: ff refused once (main moved during the gate) -> sync + gate again -> merged', noGit, async (t) => {
  const { root, roots, quick } = setup(t, { config: { 'quality-tools': { test: mainMover(t, 1) } } });
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  const res = await nos(['run', 'finish', '--token', a.token], a.enter);
  assert.equal(res.code, 0, res.err);
  assert.equal(head(root), head(a.enter));
  assert.equal(gitOk(['log', '-1', '--format=%s', 'main~1'], root), 'architect: moved');
  assert.equal(gitOk(['rev-list', '--merges', 'main'], root), '');
});

test('finish: ff refused twice -> 1 "refused twice", lock released, phase develop', noGit, async (t) => {
  const { root, roots, quick } = setup(t, { config: { 'quality-tools': { test: mainMover(t, 2) } } });
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  const res = await nos(['run', 'finish', '--token', a.token], a.enter);
  assert.equal(res.code, 1);
  assert.match(res.json.error, /refused twice/);
  assert.equal(mergeHeld(roots), false);
  assert.equal(readRun(roots, quick.a.runId).phase, 'develop');
  assert.equal(quickStatus(roots, quick.a), 'done');
});

test('finish on a merged run releases a merge lock it left', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);
  takeLock(roots, 'merge', { run: quick.a.runId, token: a.token, command: 'run finish' });
  const again = await nos(['run', 'finish', '--token', a.token], a.enter);
  assert.equal(again.json.already, true);
  assert.equal(mergeHeld(roots), false);
});

test('abandon after a crash right after the ff merge is refused: finish completes it', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  writeRun(roots, { ...readRun(roots, quick.a.runId), phase: 'merge' });
  gitOk(['merge', '--ff-only', quick.a.runId], root);

  const res = await nos(['run', 'abandon', '--token', a.token], root);
  assert.equal(res.code, 1);
  assert.match(res.err, /already in main: run nos run finish to complete it/);
  assert.equal(quickStatus(roots, quick.a), 'done');
  assert.equal(readRun(roots, quick.a.runId).phase, 'merge');
  assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);
  assert.equal(quickStatus(roots, quick.a), 'merged');
});

test('cleanup of a merged run while main is checked out on another branch deletes the branch', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);
  gitOk(['checkout', '-q', '-b', 'side', 'main~1'], root);

  const res = await nos(['run', 'cleanup', '--token', a.token], root);
  assert.equal(res.code, 0, res.err);
  assert.equal(branchExists(root, quick.a.runId), false);
});

test(
  'cleanup of a merged run: untracked leftovers (gate output) are removed, modified files -> 5',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
    done(roots, quick.a);
    assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);
    writeFile(a.enter, 'coverage/report.txt', 'gate output\n');
    writeFile(a.enter, 'src/x.txt', 'modified after the merge\n');

    const dirty = await nos(['run', 'cleanup', '--token', a.token], root);
    assert.equal(dirty.code, 5);
    assert.equal(dirty.json.action, 'run-cleanup');
    assert.deepEqual(dirty.json.details.files, ['src/x.txt']);
    assert.doesNotMatch(dirty.err, /still uses/);

    gitOk(['checkout', '--', 'src/x.txt'], a.enter);
    const res = await nos(['run', 'cleanup', '--token', a.token], root);
    assert.equal(res.code, 0, res.err);
    assert.deepEqual(res.json.removed, { worktree: true, branch: true, runFile: true });
  },
);
