// Stop hook (`nos chat hook`): when a turn ends with chat messages queued and no `await` running,
// hand them to Claude Code as its next input. Returns the hook output object, or null for none.
// Relay mode only: in runner mode the chat server's own Claude Code sessions answer the tabs, so
// the hook never takes their messages (not even when the server is down).
import { liveServer, request } from './client.js';
import { chatConfig, findRoot, files, realDir, stateDirOf } from './paths.js';
import { loadState, saveState } from './sessions.js';

const MAX_LISTED = 20;

export async function runHook(stdinText, { env = process.env } = {}) {
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return null;
  }
  // blocking twice in a row can wedge a session
  if (!input || input.stop_hook_active === true || typeof input.cwd !== 'string') return null;

  const root = findRoot(input.cwd);
  if (chatConfig(root).runner) return null;
  const stateDir = stateDirOf(root, env);
  const file = files(stateDir).sessions;
  const me = realDir(root);
  const state = loadState(file);
  const keys = Object.values(state.sessions)
    .filter((s) => s.status !== 'ended' && s.pending?.length && s.dir === me)
    .map((s) => s.key);
  if (!keys.length) return null;

  const drained = [];
  const live = await liveServer(root, stateDir);
  if (live) {
    // the server owns the file while it runs
    for (const key of keys) {
      try {
        const r = await request(live.port, 'POST', '/api/await', { key, timeoutMs: 0 }, { timeoutMs: 1000 });
        if (r.body.status === 'messages') drained.push(...r.body.items);
      } catch {
        // skip this session
      }
    }
  } else {
    for (const key of keys) {
      drained.push(...state.sessions[key].pending);
      state.sessions[key].pending = [];
    }
    saveState(file, state);
  }
  if (!drained.length) return null;

  const listed = drained.slice(0, MAX_LISTED).map((m) => `- ${m.text.replace(/\n/g, '\n  ')}`);
  if (drained.length > MAX_LISTED) listed.push(`- … and ${drained.length - MAX_LISTED} more`);
  return {
    decision: 'block',
    reason:
      'Local chat: the user sent messages that never reached you.\n' +
      listed.join('\n') +
      '\nAnswer with `nos chat reply`, then run `nos chat await` in the background.',
  };
}
