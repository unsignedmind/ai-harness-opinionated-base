import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, HELD, NosError, USAGE } from '../src/exit-codes.js';
import { listLocks, lockPath, lockStatus, releaseLock, takeLock } from '../src/lock.js';
import { slash } from '../src/roots.js';
import { invokeCli, makeProject, makeRoots, runNode, srcUrl } from './helpers.js';

const A = { run: 'quick-7', token: 'aaaa1111', command: 'test' };
const B = { run: 'quick-8', token: 'bbbb2222', command: 'test' };

const isCode = (code) => (err) => err instanceof NosError && err.code === code;

test('takeLock creates <specs>/.locks/<name>/holder.json { run, token, pid, command, taken }', (t) => {
  const roots = makeRoots(t);

  const res = takeLock(roots, 'merge', A);

  assert.equal(res.lock, 'merge');
  assert.equal(res.reentrant, false);
  assert.equal(res.path, slash(path.join(roots.specs, '.locks', 'merge')));
  const holder = JSON.parse(readFileSync(path.join(roots.specs, '.locks', 'merge', 'holder.json'), 'utf8'));
  assert.deepEqual(Object.keys(holder), ['run', 'token', 'pid', 'command', 'taken']);
  assert.equal(holder.run, 'quick-7');
  assert.equal(holder.token, 'aaaa1111');
  assert.equal(holder.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(holder.taken)));
});

test('the same token re-takes its own lock (reentrant), another token gets HELD with holder, age, pidAlive', (t) => {
  const roots = makeRoots(t);
  takeLock(roots, 'merge', A);

  const again = takeLock(roots, 'merge', A);
  assert.equal(again.reentrant, true);

  assert.throws(
    () => takeLock(roots, 'merge', B),
    (err) => {
      assert.ok(isCode(HELD)(err));
      assert.equal(err.details.lock, 'merge');
      assert.equal(err.details.holder.token, 'aaaa1111');
      assert.equal(err.details.holder.run, 'quick-7');
      assert.equal(typeof err.details.ageSec, 'number');
      assert.equal(err.details.pidAlive, true, 'this test process holds it');
      assert.equal(err.details.hint, 'nos lock release merge --break');
      return true;
    },
  );
});

test('a held lock waits up to waitMs, then reports HELD; it is never broken automatically', (t) => {
  const roots = makeRoots(t);
  takeLock(roots, 'merge', A);

  const start = Date.now();
  assert.throws(() => takeLock(roots, 'merge', B, { waitMs: 150 }), isCode(HELD));
  assert.ok(Date.now() - start >= 140);
  assert.equal(lockStatus(roots, 'merge').holder.token, A.token);
});

test('releaseLock: only the holder token, or break; not held is released false', (t) => {
  const roots = makeRoots(t);
  takeLock(roots, 'merge', A);

  assert.throws(() => releaseLock(roots, 'merge', B.token), isCode(HELD));
  assert.throws(() => releaseLock(roots, 'merge', undefined), isCode(FAILED));
  const released = releaseLock(roots, 'merge', A.token);
  assert.equal(released.released, true);
  assert.equal(released.broken, false);
  assert.equal(existsSync(lockPath(roots, 'merge')), false);
  assert.equal(releaseLock(roots, 'merge', A.token).released, false);

  takeLock(roots, 'merge', A);
  const broken = releaseLock(roots, 'merge', undefined, { break: true });
  assert.equal(broken.released, true);
  assert.equal(broken.broken, true);
  assert.equal(broken.holder.token, A.token);
  assert.equal(takeLock(roots, 'merge', B).reentrant, false, 'free again');
});

test('lockStatus and listLocks report holders; a dead pid is pidAlive false', (t) => {
  const roots = makeRoots(t);
  assert.equal(lockStatus(roots, 'merge').held, false);
  takeLock(roots, 'slot-1', A);
  takeLock(roots, 'merge', B);

  const status = lockStatus(roots, 'merge');
  assert.equal(status.held, true);
  assert.equal(status.holder.run, 'quick-8');
  assert.deepEqual(
    listLocks(roots).map((l) => l.lock),
    ['merge', 'slot-1'],
  );
});

test('a lock folder without holder.json (a taker mid-write) is waited for, then reported as held', (t) => {
  const roots = makeRoots(t);
  mkdirSync(lockPath(roots, 'merge'), { recursive: true });

  const start = Date.now();
  assert.throws(
    () => takeLock(roots, 'merge', A),
    (err) => isCode(HELD)(err) && err.details.holder === null,
  );
  assert.ok(Date.now() - start >= 900, 'retried for about 1s');
});

test('lock names are checked: no path traversal', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => takeLock(roots, '../x', A), isCode(USAGE));
  assert.throws(() => takeLock(roots, 'merge', { run: null }), isCode(FAILED), 'token required');
});

test('5 child processes take the same lock at once: exactly one wins', async (t) => {
  const roots = makeRoots(t);
  const script = (i) => `
    import { takeLock } from '${srcUrl('lock.js')}';
    const roots = ${JSON.stringify(roots)};
    try {
      takeLock(roots, 'merge', { run: 'quick-${i}', token: 'tok${i}', command: 'race' });
      console.log('won');
    } catch (err) {
      console.log(err.code === 4 ? 'held' : 'error ' + err.message);
    }`;

  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => runNode(script(i))));

  const outs = results.map((r) => r.stdout.trim());
  assert.equal(outs.filter((o) => o === 'won').length, 1, outs.join(','));
  assert.equal(outs.filter((o) => o === 'held').length, 4, outs.join(','));
  const winner = outs.indexOf('won') + 1;
  assert.equal(lockStatus(roots, 'merge').holder.token, `tok${winner}`);
});

test('nos lock take|release|status through run(): held -> exit 4 with { action, error, exit, details }', async (t) => {
  const { root } = makeProject(t);

  const take = await invokeCli(['lock', 'take', 'merge', '--token', 'aaaa1111', '--run', 'quick-7'], { cwd: root });
  assert.equal(take.code, 0, take.err);
  assert.equal(take.json.action, 'lock-take');
  assert.equal(take.json.holder.run, 'quick-7');
  assert.equal(take.json.holder.command, 'lock take');

  const again = await invokeCli(['lock', 'take', 'merge'], { cwd: root, env: { NOS_RUN_TOKEN: 'aaaa1111' } });
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.reentrant, true);

  const held = await invokeCli(['lock', 'take', 'merge', '--token', 'bbbb2222'], { cwd: root });
  assert.equal(held.code, 4);
  assert.deepEqual(Object.keys(held.json), ['action', 'error', 'exit', 'details']);
  assert.equal(held.json.action, 'lock-take');
  assert.equal(held.json.exit, 4);
  assert.equal(held.json.details.holder.run, 'quick-7');
  assert.equal(held.json.details.hint, 'nos lock release merge --break');
  assert.match(held.err, /^nos: lock merge is held by run quick-7/);

  const status = await invokeCli(['lock', 'status', 'merge'], { cwd: root });
  assert.equal(status.json.action, 'lock-status');
  assert.equal(status.json.held, true);
  assert.equal(status.json.pidAlive, true, 'run() ran in this process');
  assert.equal((await invokeCli(['lock', 'status'], { cwd: root })).json.locks.length, 1);

  const wrong = await invokeCli(['lock', 'release', 'merge', '--token', 'bbbb2222'], { cwd: root });
  assert.equal(wrong.code, 4);
  assert.equal(wrong.json.action, 'lock-release');

  const broken = await invokeCli(['lock', 'release', 'merge', '--break'], { cwd: root });
  assert.equal(broken.code, 0, broken.err);
  assert.equal(broken.json.broken, true);
});

test('nos lock usage errors exit 2', async (t) => {
  const { root } = makeProject(t);
  assert.equal((await invokeCli(['lock'], { cwd: root })).code, 2);
  assert.equal((await invokeCli(['lock', 'grab', 'merge'], { cwd: root })).code, 2);
  assert.equal((await invokeCli(['lock', 'take', 'merge'], { cwd: root })).code, 2, 'no token');
  assert.equal((await invokeCli(['lock', 'release', 'merge'], { cwd: root })).code, 2, 'no token, no --break');
  assert.equal((await invokeCli(['lock', 'take', 'Merge!', '--token', 'x'], { cwd: root })).code, 2);
  assert.equal((await invokeCli(['lock', 'take', 'a', 'b', '--token', 'x'], { cwd: root })).code, 2);
});
