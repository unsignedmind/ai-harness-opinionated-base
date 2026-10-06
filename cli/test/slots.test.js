import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NosError, SLOT_TIMEOUT } from '../src/exit-codes.js';
import { lockStatus, releaseLock, takeLock } from '../src/lock.js';
import { withSlot } from '../src/slots.js';
import { makeProject } from './helpers.js';

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
