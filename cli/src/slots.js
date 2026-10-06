import { setTimeout as sleep } from 'node:timers/promises';
import { NosError, SLOT_TIMEOUT } from './exit-codes.js';
import { lockStatus, randomToken, releaseLock, takeLock } from './lock.js';
import { worktreesConfig } from './project-config.js';

// Slots: leases on ports, not a run attribute. Lock slot-<n>, n in 1..worktrees.slots of main's
// nos.config.json. A command that starts a server (gate --e2e, exec dev) holds one while it runs and
// passes NOS_SLOT=n to its child. None free -> poll until worktrees.slotWait seconds, then SLOT_TIMEOUT.
export const SLOT_POLL_MS = 2000;

export const slotLock = (n) => `slot-${n}`;

const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
const nonNegative = (value, fallback) => (typeof value === 'number' && value >= 0 ? value : fallback);

// The smallest free slot taken for holder, null when all are held
function tryTakeSlot(roots, slots, holder) {
  for (let n = 1; n <= slots; n++) {
    try {
      takeLock(roots, slotLock(n), holder);
      return n;
    } catch (err) {
      if (!(err instanceof NosError)) throw err;
    }
  }
  return null;
}

// Runs fn(slot) while holding the smallest free slot; the lease is released when fn settles (also on throw).
// options: label (holder.command), holder ({ run } of the caller), pollMs, waitMs (default slotWait * 1000;
// slotWait may be fractional). Timeout -> NosError SLOT_TIMEOUT { slots, slotWait, holders }.
export async function withSlot(roots, fn, { label = null, holder = {}, pollMs = SLOT_POLL_MS, waitMs } = {}) {
  const config = worktreesConfig(roots);
  const slots = positiveInt(config.slots, 1);
  const slotWait = nonNegative(config.slotWait, 600);
  const limit = waitMs ?? slotWait * 1000;
  const lease = { run: holder.run ?? null, token: randomToken(), command: label };
  const start = Date.now();
  let slot;
  for (;;) {
    slot = tryTakeSlot(roots, slots, lease);
    if (slot) break;
    const waited = Date.now() - start;
    if (waited >= limit) {
      const holders = Array.from({ length: slots }, (_, i) => ({ slot: i + 1, ...lockStatus(roots, slotLock(i + 1)) }));
      throw new NosError(SLOT_TIMEOUT, `no free slot of ${slots} within ${limit / 1000}s`, {
        slots,
        slotWait: limit / 1000,
        holders,
      });
    }
    await sleep(Math.min(pollMs, limit - waited));
  }
  try {
    return await fn(slot);
  } finally {
    try {
      releaseLock(roots, slotLock(slot), lease.token);
    } catch (err) {
      // broken by the user meanwhile (and maybe taken by another): not ours to release any more
      if (!(err instanceof NosError)) throw err;
    }
  }
}
