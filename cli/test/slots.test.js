import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { NosError, SLOT_TIMEOUT } from '../src/exit-codes.js';
import { lockStatus, releaseLock, takeLock } from '../src/lock.js';
import { withSlot } from '../src/slots.js';
import { makeProject, runNode, srcUrl } from './helpers.js';

const project = (t, worktrees) => makeProject(t, { config: { worktrees } }).roots;

test('withSlot takes the smallest free slot, holds it while fn runs and releases it', async (t) => {
  const roots = project(t, { slots: 3, slotWait: 1 });
  takeLock(roots, 'slot-1', { token: 'other' });

  const result = await withSlot(
    roots,
    async (slot) => {
      const status = lockStatus(roots, `slot-${slot}`);
      assert.equal(status.held, true);
      assert.equal(status.holder.command, 'gate e2e');
      assert.equal(status.holder.run, 'quick-7');
      return slot;
    },
    { label: 'gate e2e', holder: { run: 'quick-7' } },
  );

  assert.equal(result, 2);
  assert.equal(lockStatus(roots, 'slot-2').held, false);
  assert.equal(lockStatus(roots, 'slot-1').held, true, 'the other holder keeps its slot');
});

test('withSlot releases the lease when fn throws', async (t) => {
  const roots = project(t, { slots: 1, slotWait: 1 });
  await assert.rejects(
    withSlot(roots, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(lockStatus(roots, 'slot-1').held, false);
});

test('withSlot waits for a slot that becomes free', async (t) => {
  const roots = project(t, { slots: 1, slotWait: 5 });
  takeLock(roots, 'slot-1', { token: 'other' });
  setTimeout(() => releaseLock(roots, 'slot-1', 'other'), 150);

  const start = Date.now();
  const slot = await withSlot(roots, (n) => n, { pollMs: 50 });

  assert.equal(slot, 1);
  assert.ok(Date.now() - start >= 140);
});

test('withSlot: no free slot within slotWait (fractional seconds) -> SLOT_TIMEOUT with the holders', async (t) => {
  const roots = project(t, { slots: 2, slotWait: 0.2 });
  takeLock(roots, 'slot-1', { run: 'quick-1', token: 'a', command: 'exec dev' });
  takeLock(roots, 'slot-2', { run: 'quick-2', token: 'b', command: 'gate e2e' });
  let ran = false;

  const start = Date.now();
  await assert.rejects(
    withSlot(roots, () => (ran = true), { pollMs: 50 }),
    (err) => {
      assert.ok(err instanceof NosError);
      assert.equal(err.code, SLOT_TIMEOUT);
      assert.equal(err.details.slots, 2);
      assert.equal(err.details.slotWait, 0.2);
      assert.deepEqual(
        err.details.holders.map((h) => [h.slot, h.holder.run]),
        [
          [1, 'quick-1'],
          [2, 'quick-2'],
        ],
      );
      return true;
    },
  );
  assert.ok(Date.now() - start >= 190);
  assert.equal(ran, false);
});

// takes slot-<n> in a child process; alive: the child keeps running until killed
async function foreignLease(t, roots, n, { alive = false } = {}) {
  const script = `
    import { takeLock } from '${srcUrl('lock.js')}';
    takeLock(${JSON.stringify(roots)}, 'slot-${n}', { run: 'quick-9', token: 'f0f0f0f${n}', command: 'exec dev' });
    console.log('taken');
    ${alive ? 'setInterval(() => {}, 1000);' : ''}`;
  if (!alive) {
    const res = await runNode(script);
    assert.equal(res.code, 0, res.stderr);
    return null;
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.once('data', resolve));
  return child;
}

test('a slot lease whose process is gone is reclaimed by the next taker (D-10)', async (t) => {
  const roots = project(t, { slots: 1, slotWait: 1 });
  await foreignLease(t, roots, 1);
  assert.equal(lockStatus(roots, 'slot-1').pidAlive, false);

  const lease = await withSlot(roots, (slot, info) => info, { label: 'gate e2e' });

  assert.equal(lease.slot, 1);
  assert.equal(lease.reclaimed.slot, 1);
  assert.equal(lease.reclaimed.holder.token, 'f0f0f0f1');
  assert.equal(lockStatus(roots, 'slot-1').held, false, 'released after fn');
  assert.equal(lockStatus(roots, 'reclaim-slot-1').held, false, 'no guard left');
});

test('a slot lease whose process is alive is never reclaimed: the taker waits and times out', async (t) => {
  const roots = project(t, { slots: 1, slotWait: 0.3 });
  await foreignLease(t, roots, 1, { alive: true });

  await assert.rejects(
    withSlot(roots, () => 'ran', { pollMs: 50 }),
    (err) => err.code === SLOT_TIMEOUT,
  );
  assert.equal(lockStatus(roots, 'slot-1').holder.token, 'f0f0f0f1');
});

test('merge and ids locks of a dead process are never reclaimed by takeLock', async (t) => {
  const roots = project(t, { slots: 1, slotWait: 1 });
  const res = await runNode(`
    import { takeLock } from '${srcUrl('lock.js')}';
    takeLock(${JSON.stringify(roots)}, 'merge', { token: 'dead0001' });`);
  assert.equal(res.code, 0, res.stderr);
  assert.throws(
    () => takeLock(roots, 'merge', { token: 'mine' }),
    (err) => err.code === 4,
  );
});

test('withSlot: an abort signal stops the wait', async (t) => {
  const roots = project(t, { slots: 1, slotWait: 10 });
  takeLock(roots, 'slot-1', { token: 'other' });
  const abort = new AbortController();
  setTimeout(() => abort.abort('SIGINT'), 100);

  const start = Date.now();
  await assert.rejects(
    withSlot(roots, () => 'ran', { abort: abort.signal }),
    /interrupted while waiting/,
  );
  assert.ok(Date.now() - start < 2000);
});
