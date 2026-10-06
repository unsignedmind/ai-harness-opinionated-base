import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FAILED, HELD, NosError, USAGE } from './exit-codes.js';
import { writeFileAtomic } from './fs-atomic.js';
import { pidAlive, sleepSync } from './proc.js';
import { slash } from './roots.js';

// Locks: <specs>/.locks/<name>/holder.json. The directory is created by mkdir (atomic: exactly one taker
// wins), holder.json = { run, token, pid, command, taken }. The same token re-takes its own lock (a
// crashed command resumes). Never broken automatically: releaseLock with { break: true } is the user's call.
// The one exception are slot leases (slots.js): reclaimDeadLock frees a slot whose leasing process is gone.
export const LOCKS_DIR = '.locks';
export const HOLDER_FILE = 'holder.json';
// a taker between mkdir and writing holder.json: others wait this long for the file before reporting
const HOLDER_GRACE_MS = 1000;
const POLL_MS = 25;
const LOCK_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const locksDir = (roots) => path.join(roots.specs, LOCKS_DIR);

export function lockPath(roots, name) {
  if (typeof name !== 'string' || !LOCK_NAME.test(name)) {
    throw new NosError(USAGE, `Invalid lock name "${name}": lowercase letters, digits and dashes`);
  }
  return path.join(locksDir(roots), name);
}

// A random token for a holder that is not a run (ids, slot leases)
export const randomToken = () => randomBytes(4).toString('hex');

// A holder as printed: without its token (a token is a run's holder credential; it stays on disk only)
export const publicHolder = (holder) => {
  if (!holder || typeof holder !== 'object') return holder;
  const { token, ...rest } = holder;
  return rest;
};

const ageSecOf = (holder) => {
  const taken = Date.parse(holder?.taken ?? '');
  return Number.isNaN(taken) ? null : Math.max(0, Math.round((Date.now() - taken) / 1000));
};

// holder.json: the holder, undefined when missing, null when unreadable (reported as an unknown holder)
function readHolder(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, HOLDER_FILE), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    return null;
  }
}

// holder.json atomically. false when the lock folder vanished meanwhile (broken by the user).
function writeHolder(dir, holder) {
  try {
    writeFileAtomic(path.join(dir, HOLDER_FILE), JSON.stringify(holder, null, 2) + '\n');
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new NosError(FAILED, `Cannot write ${slash(path.join(dir, HOLDER_FILE))}: ${err.message}`);
  }
}

// What a refusal and lockStatus report about a holder
function describe(name, dir, holder) {
  return {
    lock: name,
    path: slash(dir),
    holder: holder ?? null,
    ageSec: ageSecOf(holder),
    pidAlive: holder ? pidAlive(holder.pid) : false,
  };
}

function heldError(name, dir, holder) {
  const details = { ...describe(name, dir, holder), hint: `nos lock release ${name} --break` };
  const by = holder ? `run ${holder.run ?? '-'}, ${holder.command ?? '?'}, pid ${holder.pid}` : 'an unknown holder';
  const age = details.ageSec == null ? '' : ` for ${details.ageSec}s`;
  return new NosError(HELD, `lock ${name} is held by ${by}${age}`, details);
}

// One attempt: { ok: true, holder, reentrant } | { ok: false, holder } (holder undefined: being written or gone)
function tryTake(dir, holder) {
  try {
    mkdirSync(dir);
  } catch (err) {
    // EPERM/EACCES: Windows while the directory is being deleted by a release
    if (err.code === 'EPERM' || err.code === 'EACCES') return { ok: false, holder: undefined };
    if (err.code !== 'EEXIST') throw new NosError(FAILED, `Cannot create ${slash(dir)}: ${err.message}`);
    const current = readHolder(dir);
    if (current && current.token === holder.token) {
      const refreshed = { ...current, pid: holder.pid, taken: holder.taken };
      if (!writeHolder(dir, refreshed)) return { ok: false, holder: undefined };
      // a --break and another taker may have come between read and write: the file must still be ours
      const check = readHolder(dir);
      if (check?.token !== holder.token) return { ok: false, holder: check };
      return { ok: true, holder: refreshed, reentrant: true };
    }
    return { ok: false, holder: current };
  }
  if (!writeHolder(dir, holder)) return { ok: false, holder: undefined };
  return { ok: true, holder, reentrant: false };
}

// Takes lock name for holder { run, token, command }. pid and taken are filled in.
// Held by another token -> waits up to waitMs, then NosError HELD { lock, path, holder, ageSec, pidAlive, hint }.
// Returns { lock, path, holder, reentrant }.
export function takeLock(roots, name, { run = null, token, command = null } = {}, { waitMs = 0 } = {}) {
  if (!token) throw new NosError(FAILED, `lock ${name}: a token is required`);
  const dir = lockPath(roots, name);
  mkdirSync(locksDir(roots), { recursive: true });
  const start = Date.now();
  for (;;) {
    const holder = { run, token, pid: process.pid, command, taken: new Date().toISOString() };
    const res = tryTake(dir, holder);
    if (res.ok) return { lock: name, path: slash(dir), holder: res.holder, reentrant: res.reentrant };
    const waited = Date.now() - start;
    // a missing holder.json is a taker mid-write: wait for it at least HOLDER_GRACE_MS
    const limit = res.holder === undefined ? Math.max(waitMs, HOLDER_GRACE_MS) : waitMs;
    if (waited >= limit) throw heldError(name, dir, res.holder);
    sleepSync(Math.min(POLL_MS, limit - waited));
  }
}

function removeLockDir(dir) {
  rmSync(path.join(dir, HOLDER_FILE), { force: true });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// Releases lock name. Only the holder's token, or { break: true } (any holder).
// Not held -> { released: false }. Returns { lock, path, released, broken, holder }.
export function releaseLock(roots, name, token, { break: force = false } = {}) {
  const dir = lockPath(roots, name);
  const holder = readHolder(dir);
  const exists = holder !== undefined || dirExists(dir);
  if (!exists) return { lock: name, path: slash(dir), released: false, broken: false, holder: null };
  if (!force) {
    if (!token) throw new NosError(FAILED, `lock ${name}: --token required (or --break)`);
    if (!holder || holder.token !== token) throw heldError(name, dir, holder);
  }
  removeLockDir(dir);
  return {
    lock: name,
    path: slash(dir),
    released: true,
    broken: force && holder?.token !== token,
    holder: holder ?? null,
  };
}

// Frees lock name when its holder is still `dead` (same token) and that holder's process is gone.
// Only for slot leases. A guard lock reclaim-<name> makes check-and-remove exclusive: two reclaimers never
// remove a lease a third process took meanwhile. Returns true when the lock was removed.
export function reclaimDeadLock(roots, name, dead) {
  if (!dead?.token || pidAlive(dead.pid)) return false;
  const dir = lockPath(roots, name);
  const guard = `reclaim-${name}`;
  const token = randomToken();
  try {
    takeLock(roots, guard, { token, command: `reclaim ${name}` });
  } catch (err) {
    if (!(err instanceof NosError)) throw err;
    // a guard left by a reclaimer that died mid-reclaim: its process is gone, remove it for the next try
    const stale = err.details?.holder;
    if (stale && !pidAlive(stale.pid)) removeLockDir(lockPath(roots, guard));
    return false;
  }
  try {
    const current = readHolder(dir);
    if (current?.token !== dead.token || pidAlive(current.pid)) return false;
    removeLockDir(dir);
    return true;
  } finally {
    releaseLock(roots, guard, token);
  }
}

function dirExists(dir) {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

// { lock, path, held, holder, ageSec, pidAlive }
export function lockStatus(roots, name) {
  const dir = lockPath(roots, name);
  const holder = readHolder(dir);
  const held = holder !== undefined || dirExists(dir);
  return { ...describe(name, dir, held ? holder : null), held };
}

// lockStatus of every lock in <specs>/.locks, by name
export function listLocks(roots) {
  let names;
  try {
    names = readdirSync(locksDir(roots), { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isDirectory() && LOCK_NAME.test(entry.name))
    .map((entry) => lockStatus(roots, entry.name))
    .sort((a, b) => a.lock.localeCompare(b.lock, 'en', { numeric: true }));
}
