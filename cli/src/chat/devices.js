// Paired devices of the chat (spec-ui on the home network). Shared by `nos chat pair|devices` and the
// spec-ui dev server, through <specs>/.chat/devices.json (read fresh, written whole: tmp + rename).
//
// Pairing: a one-time code (10 min, single use) → the device that opens it becomes *pending* and
// shows a 4-digit confirm number → someone on the PC approves it (same number) → on its next status
// poll the device gets its own secret once, as a cookie. Only hashes of codes and secrets are stored.
// A device idle for 30 days is dropped. Every chat action is appended to audit.log.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureStateDir } from './paths.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const IDLE_MS = 30 * 24 * 60 * 60 * 1000;
// lastSeen is written at most this often (a busy chat does not rewrite the file per request)
const SEEN_EVERY_MS = 5 * 60 * 1000;

const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

function same(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

// "Mozilla/5.0 (Linux; Android 14; Pixel 8) … Chrome/129…" → "Android · Chrome"
export function deviceName(userAgent = '') {
  const ua = String(userAgent);
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /Firefox|FxiOS/.test(ua)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${os} · ${browser}`;
}

export function createDeviceStore({ dir, now = () => Date.now() }) {
  const file = path.join(dir, 'devices.json');

  function load() {
    let s;
    try {
      s = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      s = null;
    }
    const state = {
      codes: Array.isArray(s?.codes) ? s.codes : [],
      devices: Array.isArray(s?.devices) ? s.devices : [],
    };
    const t = now();
    state.codes = state.codes.filter((c) => c.expiresAt > t);
    state.devices = state.devices.filter((d) => (d.status === 'pending' ? d.expiresAt > t : d.lastSeen + IDLE_MS > t));
    return state;
  }
  function save(state) {
    ensureStateDir(dir);
    writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  const pub = (d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    approved: !!d.approved,
    confirm: d.status === 'pending' ? d.confirm : undefined,
    ip: d.ip ?? null,
    createdAt: d.createdAt,
    lastSeen: d.lastSeen ?? null,
  });

  return {
    file,
    // a fresh one-time pairing code (the plain code is only returned here)
    createCode(ttlMs = CODE_TTL_MS) {
      const state = load();
      const code = token(24);
      const expiresAt = now() + ttlMs;
      state.codes.push({ hash: hash(code), expiresAt });
      save(state);
      return { code, expiresAt };
    },
    // a device opens the pairing link: the code is used up, the device waits for approval.
    // Returns { id, poll, confirm } (poll: the device's secret for status checks), or null
    redeem(code, { userAgent = '', ip = null } = {}) {
      const state = load();
      const h = hash(code);
      const i = state.codes.findIndex((c) => same(c.hash, h));
      if (i < 0) return null;
      state.codes.splice(i, 1);
      const poll = token();
      const d = {
        id: token(9),
        name: deviceName(userAgent),
        status: 'pending',
        approved: false,
        confirm: String(randomInt(1000, 10000)),
        pollHash: hash(poll),
        ip,
        createdAt: now(),
        expiresAt: now() + PENDING_TTL_MS,
      };
      state.devices.push(d);
      save(state);
      return { id: d.id, poll, confirm: d.confirm };
    },
    // the waiting device asks how it stands; once approved it gets its secret, exactly once
    claim(id, poll) {
      const state = load();
      const d = state.devices.find((x) => x.id === id && x.status === 'pending');
      if (!d || !same(d.pollHash, hash(poll))) return { status: 'gone' };
      if (!d.approved) return { status: 'pending', confirm: d.confirm, name: d.name };
      const secret = token();
      Object.assign(d, { status: 'active', secretHash: hash(secret), lastSeen: now() });
      delete d.pollHash;
      delete d.expiresAt;
      delete d.confirm;
      save(state);
      return { status: 'approved', cookie: `${d.id}.${secret}`, id: d.id, name: d.name };
    },
    // cookie value "<id>.<secret>" → the active device, or null
    verify(cookie) {
      const m = /^([\w-]{8,32})\.([\w-]{20,64})$/.exec(String(cookie ?? ''));
      if (!m) return null;
      const state = load();
      const d = state.devices.find((x) => x.id === m[1] && x.status === 'active');
      if (!d || !same(d.secretHash, hash(m[2]))) return null;
      if (now() - (d.lastSeen ?? 0) > SEEN_EVERY_MS) {
        d.lastSeen = now();
        save(state);
      }
      return pub(d);
    },
    list() {
      return load().devices.map(pub);
    },
    approve(id) {
      const state = load();
      const d = state.devices.find((x) => x.id === id && x.status === 'pending');
      if (!d) return false;
      d.approved = true;
      save(state);
      return true;
    },
    // deny a pending device or revoke an active one
    revoke(id) {
      const state = load();
      const before = state.devices.length;
      state.devices = state.devices.filter((x) => x.id !== id);
      if (state.devices.length === before) return false;
      save(state);
      return true;
    },
    revokeAll() {
      const state = load();
      const n = state.devices.length;
      save({ codes: [], devices: [] });
      return n;
    },
    rename(id, name) {
      const state = load();
      const d = state.devices.find((x) => x.id === id);
      const n = String(name ?? '')
        .trim()
        .slice(0, 40);
      if (!d || !n) return false;
      d.name = n;
      save(state);
      return true;
    },
  };
}

// one line per chat action: time, device, action, tab
export function audit(dir, { device, action, key = '', detail = '' }) {
  try {
    ensureStateDir(dir);
    const line = [new Date().toISOString(), device || '-', action, key, detail.replace(/\s+/g, ' ').slice(0, 120)]
      .join('\t')
      .trimEnd();
    appendFileSync(path.join(dir, 'audit.log'), line + '\n', { mode: 0o600 });
  } catch {
    // never breaks a request
  }
}
