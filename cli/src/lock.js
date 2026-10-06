import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, HELD, NosError, USAGE } from './exit-codes.js';
import { pidAlive, sleepSync } from './proc.js';
import { slash } from './roots.js';

// Locks: <specs>/.locks/<name>/holder.json. The directory is created by mkdir (atomic: exactly one taker
// wins), holder.json = { run, token, pid, command, taken }. The same token re-takes its own lock (a
// crashed command resumes). Never broken automatically: releaseLock with { break: true } is the user's call.
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

const ageSecOf = (holder) => {
  const taken = Date.parse(holder?.taken ?? '');
  return Number.isNaN(taken) ? null : Math.max(0, Math.round((Date.now() - taken) / 1000));
};

function readHolder(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, HOLDER_FILE), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    return null; // unreadable: reported as an unknown holder
  }
}

// holder.json via tmp + rename: a reader never sees half a file
function writeHolder(dir, holder) {
  const file = path.join(dir, HOLDER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(holder, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows: the target is open in a reader for a moment
      if (attempt >= 20 || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
      sleepSync(POLL_MS);
    }
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

// One attempt: { ok: true, holder, reentrant } | { ok: false, holder } (holder undefined: being written)
function tryTake(dir, holder) {
  try {
    mkdirSync(dir);
  } catch (err) {
    // EPERM/EACCES: Windows while the directory is being deleted by a release
    if (err.code === 'EPERM' || err.code === 'EACCES') return { ok: false, holder: undefined };
    if (err.code !== 'EEXIST') throw err;
    const current = readHolder(dir);
    if (current && current.token === holder.token) {
      const refreshed = { ...current, pid: holder.pid, taken: holder.taken };
      writeHolder(dir, refreshed);
      return { ok: true, holder: refreshed, reentrant: true };
    }
    return { ok: false, holder: current };
  }
  writeHolder(dir, holder);
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
  rmSync(path.join(dir, HOLDER_FILE), { force: true });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return {
    lock: name,
    path: slash(dir),
    released: true,
    broken: force && holder?.token !== token,
    holder: holder ?? null,
  };
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
