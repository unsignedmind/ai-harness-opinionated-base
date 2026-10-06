// Where the chat of a project lives: the main checkout of the project (roots.main from the resolver, also
// when called from a worktree), its state folder <specs>/.chat/ and the session key. Everything is per
// project, so two projects never share a chat, and all worktrees of a project share the chat of main.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRoots, slash } from '../roots.js';

export const DEFAULT_PORT = 4611;
// the spec-ui dev server (ui/vite.config.ts), used for the pairing link
export const SPEC_UI_PORT = 5180;
export const KEY = /^[a-f0-9]{12}$/;

// The roots of the project around cwd (or of --root, or NOS_SPECS_ROOT): the chat works with roots.main,
// so a worktree of the project reaches the same chat as main. Throws when nos init never ran there.
export function chatRoots({ root, cwd = process.cwd(), env = process.env } = {}) {
  const roots = resolveRoots({ root, cwd, env });
  if (!roots.configured) {
    const where =
      roots.via === 'root' || roots.via === 'env' ? slash(roots.work) : `${slash(path.resolve(cwd))} or above`;
    throw new Error(`nos is not set up: no nos.config.json in ${where}. Run nos init`);
  }
  return roots;
}

export function realDir(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

// sha256 of the real path of main (plus NUL and the name when given), first 12 hex chars
export function keyOf(main, name = '') {
  const h = createHash('sha256').update(realDir(main));
  if (name) h.update('\0').update(name);
  return h.digest('hex').slice(0, 12);
}

// NOS_CHAT_STATE_DIR (tests), else <specs>/.chat
export function stateDirOf(roots, env = process.env) {
  return env.NOS_CHAT_STATE_DIR ? path.resolve(env.NOS_CHAT_STATE_DIR) : path.join(roots.specs, '.chat');
}

// creates the state folder with a .gitignore of `*`, so nothing in it is ever committed
export function ensureStateDir(dir) {
  mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

// "chat" of <specs>/config.json; throws when the file is missing or bad
const chatOf = (roots) => JSON.parse(readFileSync(path.join(roots.specs, 'config.json'), 'utf8'))?.chat;

// "chat": { "port": n } in <specs>/config.json, else 4611. HARNESS-style env override for tests.
export function portOf(roots, env = process.env) {
  if (env.NOS_CHAT_PORT) return Number(env.NOS_CHAT_PORT);
  try {
    const p = chatOf(roots)?.port;
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {
    // no or bad config: default
  }
  return DEFAULT_PORT;
}

// "chat" in <specs>/config.json: runner (default true: the chat runs its own Claude Code sessions),
// permissionMode (default "auto"), model, claude (path of the claude executable)
export function chatConfig(roots) {
  let c = {};
  try {
    c = chatOf(roots) ?? {};
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
