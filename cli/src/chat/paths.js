// Where the chat of a project lives: the project root (the folder with specs/), its state folder
// specs/.chat/ and the session key. Everything is per project, so two projects never share a chat.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_PORT = 4611;
// the spec-ui dev server (ui/vite.config.ts), used for the pairing link
export const SPEC_UI_PORT = 5180;
export const KEY = /^[a-f0-9]{12}$/;

// Walk up from dir to the first folder that holds specs/. Falls back to dir itself, so `--root`
// and a fresh project still work.
export function findRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, 'specs'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(dir);
    cur = up;
  }
}

export function realDir(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

// sha256 of the real project path (plus NUL and the name when given), first 12 hex chars
export function keyOf(dir, name = '') {
  const h = createHash('sha256').update(realDir(dir));
  if (name) h.update('\0').update(name);
  return h.digest('hex').slice(0, 12);
}

export function stateDirOf(root, env = process.env) {
  return env.NOS_CHAT_STATE_DIR ? path.resolve(env.NOS_CHAT_STATE_DIR) : path.join(root, 'specs', '.chat');
}

// creates the state folder with a .gitignore of `*`, so nothing in it is ever committed
export function ensureStateDir(dir) {
  mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

// "chat": { "port": n } in specs/config.json, else 4611. HARNESS-style env override for tests.
export function portOf(root, env = process.env) {
  if (env.NOS_CHAT_PORT) return Number(env.NOS_CHAT_PORT);
  try {
    const cfg = JSON.parse(readFileSync(path.join(root, 'specs', 'config.json'), 'utf8'));
    const p = cfg?.chat?.port;
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {
    // no or bad config: default
  }
  return DEFAULT_PORT;
}

// "chat" in specs/config.json: runner (default true: the chat runs its own Claude Code sessions),
// permissionMode (default "auto"), model, claude (path of the claude executable)
export function chatConfig(root) {
  let c = {};
  try {
    c = JSON.parse(readFileSync(path.join(root, 'specs', 'config.json'), 'utf8'))?.chat ?? {};
  } catch {
    // defaults
  }
  return {
    runner: c.runner !== false,
    permissionMode: typeof c.permissionMode === 'string' ? c.permissionMode : 'auto',
    model: typeof c.model === 'string' ? c.model : undefined,
    claude: typeof c.claude === 'string' && c.claude ? c.claude : 'claude',
  };
}

export const files = (dir) => ({
  sessions: path.join(dir, 'sessions.json'),
  server: path.join(dir, 'server.json'),
  log: path.join(dir, 'server.log'),
});

