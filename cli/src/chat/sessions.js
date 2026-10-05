// Session store of the chat: one JSON file with every session, its transcript and its queue, so a
// queued message survives a server restart. Written whole after each change (tmp file + rename).
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { keyOf, realDir } from './paths.js';

const now = () => new Date().toISOString();

export function loadState(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && s.sessions && typeof s.sessions === 'object') {
      return { counter: Number.isInteger(s.counter) ? s.counter : 0, sessions: s.sessions };
    }
  } catch {
    // missing or unreadable: empty store
  }
  return { counter: 0, sessions: {} };
}

export function saveState(file, state) {
  writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n');
  renameSync(file + '.tmp', file);
}

export function createSessionStore({ file }) {
  const state = loadState(file);
  const save = () => saveState(file, state);
  const get = (key) => state.sessions[key] ?? null;

  return {
    get,
    open(dir, name = '', reopen = false) {
      const key = keyOf(dir, name);
      const s = state.sessions[key];
      if (s) {
        if (s.status === 'ended' && s.endedBy === 'user' && !reopen) return { status: 'refused', key };
        s.status = 'open';
        s.endedBy = null;
        s.updatedAt = now();
      } else {
        const at = now();
        state.sessions[key] = {
          key,
          dir: realDir(dir),
          name,
          status: 'open',
          endedBy: null,
          // tab title, and the Claude Code session that answers this tab (runner mode)
          title: '',
          claudeSession: null,
          claudeStarted: false,
          chat: [],
          pending: [],
          createdAt: at,
          updatedAt: at,
        };
      }
      save();
      return { status: 'open', key };
    },
    // a new tab: its own name, so its own key and its own Claude Code session
    create(dir, title = '') {
      const name = 't-' + randomBytes(4).toString('hex');
      const r = this.open(dir, name);
      state.sessions[r.key].title = title;
      save();
      return r;
    },
    update(key, fields) {
      const s = get(key);
      if (!s) return null;
      for (const k of ['title', 'claudeSession', 'claudeStarted']) if (k in fields) s[k] = fields[k];
      s.updatedAt = now();
      save();
      return s;
    },
    addUserMessage(key, text, endSession = false) {
      const s = get(key);
      if (!s || s.status === 'ended') return null;
      const at = now();
      state.counter += 1;
      const item = { id: `m-${state.counter}`, text, at };
      s.chat.push({ role: 'user', text, at });
      s.pending.push(item);
      if (endSession) {
        s.status = 'ended';
        s.endedBy = 'user';
      }
      s.updatedAt = at;
      save();
      return item;
    },
    takeMessages(key) {
      const s = get(key);
      if (!s) return { status: 'missing' };
      if (s.pending.length) {
        const items = s.pending;
        s.pending = [];
        s.updatedAt = now();
        save();
        return s.status === 'ended'
          ? { status: 'messages', items, sessionEnded: true, endedBy: s.endedBy }
          : { status: 'messages', items };
      }
      if (s.status === 'ended') return { status: 'ended', endedBy: s.endedBy };
      return { status: 'waiting' };
    },
    addAgentReply(key, text) {
      const s = get(key);
      if (!s) return null;
      const at = now();
      s.chat.push({ role: 'agent', text, at });
      s.updatedAt = at;
      save();
      return at;
    },
    end(key, by) {
      const s = get(key);
      if (!s) return null;
      s.status = 'ended';
      s.endedBy = by;
      s.updatedAt = now();
      save();
      return s;
    },
    list() {
      return Object.values(state.sessions).map((s) => ({
        key: s.key,
        dir: s.dir,
        name: s.name,
        status: s.status,
        endedBy: s.endedBy,
        pending: s.pending.length,
        title: s.title ?? '',
        claudeSession: s.claudeSession ?? null,
        messages: s.chat.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    },
  };
}
