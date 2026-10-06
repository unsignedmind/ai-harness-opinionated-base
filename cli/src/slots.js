import { setTimeout as sleep } from 'node:timers/promises';
import { FAILED, HELD, NosError, SLOT_TIMEOUT } from './exit-codes.js';
import { lockStatus, randomToken, reclaimDeadLock, releaseLock, takeLock } from './lock.js';
import { worktreesConfig } from './project-config.js';

// Slots: leases on ports, not a run attribute. Lock slot-<n>, n in 1..worktrees.slots of main's
// nos.config.json. A command that starts a server (gate --e2e, exec dev) holds one while it runs and
// passes NOS_SLOT=n to its child. None free -> poll until worktrees.slotWait seconds, then SLOT_TIMEOUT.
// A lease whose process is gone (holder pid not alive: killed hard) is reclaimed by the next taker [D-10].
// Only slot leases: the merge and ids locks and run files are never taken over automatically.
export const SLOT_POLL_MS = 2000;

export const slotLock = (n) => `slot-${n}`;

const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
const nonNegative = (value, fallback) => (typeof value === 'number' && value >= 0 ? value : fallback);

// The smallest free slot taken for holder: { slot, reclaimed: { slot, holder } | null }, null when all are held
function tryTakeSlot(roots, slots, holder) {
  for (let n = 1; n <= slots; n++) {
    const name = slotLock(n);
    try {
      takeLock(roots, name, holder);
      return { slot: n, reclaimed: null };
    } catch (err) {
      if (!(err instanceof NosError) || err.code !== HELD) throw err;
      const dead = err.details.holder;
      if (!dead || err.details.pidAlive || !reclaimDeadLock(roots, name, dead)) continue;
      try {
        takeLock(roots, name, holder);
        return { slot: n, reclaimed: { slot: n, holder: dead } };
      } catch (again) {
        if (!(again instanceof NosError) || again.code !== HELD) throw again;
      }
    }
  }
  return null;
}

// Runs fn(slot, lease) while holding the smallest free slot; the lease is released when fn settles (also on
// throw). lease = { slot, reclaimed: { slot, holder } | null } (reclaimed: the dead lease taken over).
// options: label (holder.command), holder ({ run } of the caller), pollMs, waitMs (default slotWait * 1000;
// slotWait may be fractional), abort (AbortSignal: stops the wait with NosError FAILED "interrupted").
// Timeout -> NosError SLOT_TIMEOUT { slots, slotWait, holders }.
export async function withSlot(roots, fn, { label = null, holder = {}, pollMs = SLOT_POLL_MS, waitMs, abort } = {}) {
  const config = worktreesConfig(roots);
  const slots = positiveInt(config.slots, 1);
  const slotWait = nonNegative(config.slotWait, 600);
  const limit = waitMs ?? slotWait * 1000;
  const owner = { run: holder.run ?? null, token: randomToken(), command: label };
  const start = Date.now();
  let lease;
  for (;;) {
    lease = tryTakeSlot(roots, slots, owner);
    if (lease) break;
    const waited = Date.now() - start;
    if (waited >= limit) {
      const holders = Array.from({ length: slots }, (_, i) => ({ slot: i + 1, ...lockStatus(roots, slotLock(i + 1)) }));
      throw new NosError(SLOT_TIMEOUT, `no free slot of ${slots} within ${limit / 1000}s`, {
        slots,
        slotWait: limit / 1000,
        holders,
      });
    }
    try {
      await sleep(Math.min(pollMs, limit - waited), undefined, abort ? { signal: abort } : {});
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
    if (abort?.aborted) throw new NosError(FAILED, `interrupted while waiting for a slot (${abort.reason})`);
  }
  try {
    return await fn(lease.slot, lease);
  } finally {
    try {
      releaseLock(roots, slotLock(lease.slot), owner.token);
    } catch (err) {
      // broken by the user meanwhile (and maybe taken by another): not ours to release any more
      if (!(err instanceof NosError)) throw err;
    }
  }
}
