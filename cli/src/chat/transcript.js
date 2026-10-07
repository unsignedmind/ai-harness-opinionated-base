// The details view of the chat: what a tab's Claude Code session (or one of its subagents) does,
// read from the transcripts Claude Code writes itself, so nothing new is captured and the history
// survives restarts:
//   <claudeDir>/projects/<slug>/<session>.jsonl                       main session
//   <claudeDir>/projects/<slug>/<session>/subagents/agent-<id>.jsonl  a subagent (+ .meta.json)
// createCondenser turns transcript lines into a short list of items (user prompts, texts, tool
// calls paired with their results, subagent launches, notices); tailTranscript follows a file and
// hands over new and changed items.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeTool } from './runner.js';

export const MAX_FIELD = 4000;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const claudeDir = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude'));
// how Claude Code names a project's folder: every character but letters and digits becomes '-'
export const projectSlug = (root) => String(root).replace(/[^a-zA-Z0-9]/g, '-');

// the main transcript of a session, or null; looks in the other project folders when the slug misses
export function transcriptFile(root, sessionId, env = process.env) {
  if (!UUID.test(String(sessionId))) return null;
  const projects = path.join(claudeDir(env), 'projects');
  const own = path.join(projects, projectSlug(root), `${sessionId}.jsonl`);
  if (existsSync(own)) return own;
  try {
    for (const d of readdirSync(projects)) {
      const f = path.join(projects, d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {
    // no projects folder yet
  }
  return own;
}

// a subagent's transcript, by its agentId or by the tool_use id that started it (from .meta.json)
export function agentFile(main, { agentId, toolUseId } = {}) {
  if (!main) return null;
  const dir = path.join(main.replace(/\.jsonl$/, ''), 'subagents');
  if (agentId) return /^\w+$/.test(agentId) ? path.join(dir, `agent-${agentId}.jsonl`) : null;
  if (!toolUseId) return null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        if (JSON.parse(readFileSync(path.join(dir, f), 'utf8')).toolUseId === toolUseId)
          return path.join(dir, f.replace(/\.meta\.json$/, '.jsonl'));
      } catch {
        // a broken meta file: not this one
      }
    }
  } catch {
    // no subagents yet
  }
  return null;
}

const cap = (s) => {
  const t = String(s ?? '');
  return t.length > MAX_FIELD ? { text: t.slice(0, MAX_FIELD), cut: true } : { text: t, cut: false };
};
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (typeof c?.text === 'string' ? c.text : c?.type === 'image' ? '[image]' : ''))
          .filter(Boolean)
          .join('\n')
      : '';
const tag = (s, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1]?.trim() ?? '';
const firstLine = (s, n = 160) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// what an injected user line (isMeta, notifications, agent messages) shows as: a one-line notice
function noticeOf(text) {
  if (text.startsWith('<task-notification>')) {
    const sum = tag(text, 'summary');
    const status = tag(text, 'status');
    return sum ? `${sum}${status ? ` (${status})` : ''}` : 'Background task update';
  }
  const from = /<agent-message from="([^"]+)">/.exec(text);
  if (from) return `Message from agent ${from[1]}`;
  if (/^\[Request interrupted/.test(text)) return 'Interrupted';
  return null;
}

// Stateful: feed(line) returns the items it added or changed (a tool item changes when its result
// comes). Items: { id, kind, at, ... } with kind user | text | tool | agent | notice.
export function createCondenser({ rel = (t) => t } = {}) {
  const byId = new Map();
  let first = true;
  return {
    feed(j) {
      if (!j || typeof j !== 'object') return [];
      const out = [];
      const put = (item) => {
        byId.set(item.id, item);
        out.push(item);
      };
      const at = j.timestamp ?? null;
      const content = j.message?.content;
      const base = String(j.uuid ?? `${j.type}-${byId.size}`);

      if (j.type === 'user' && typeof content === 'string') {
        const cmd = tag(content, 'command-name');
        const notice = noticeOf(content);
        // a subagent's transcript starts with its task
        if (first && j.isSidechain) put({ id: base, kind: 'user', at, label: 'Task', ...cap(content) });
        else if (notice) put({ id: base, kind: 'notice', at, text: notice });
        else if (j.isMeta || content.startsWith('<system-reminder>')) {
          // injected context (skill text, reminders): not shown
        } else if (cmd) put({ id: base, kind: 'user', at, ...cap(cmd + (tag(content, 'command-args') ? ' ' + tag(content, 'command-args') : '')) });
        else put({ id: base, kind: 'user', at, ...cap(content) });
      } else if (j.type === 'attachment' && j.attachment?.type === 'queued_command' && typeof j.attachment.prompt === 'string') {
        // a message that came while Claude worked: the user's (human), or one the main session
        // passed to this subagent (coordinator); task-notifications come this way too
        const prompt = j.attachment.prompt.trim();
        const notice = noticeOf(prompt);
        if (notice) put({ id: base, kind: 'notice', at, text: notice });
        else if (prompt)
          put({ id: base, kind: 'user', at, label: j.attachment.origin?.kind === 'coordinator' ? 'From Claude' : 'You', ...cap(prompt) });
      } else if (j.type === 'user' && Array.isArray(content)) {
        content.forEach((c, i) => {
          if (c?.type === 'tool_result') {
            const item = byId.get(String(c.tool_use_id));
            if (!item) return;
            const text = textOf(c.content);
            if (item.kind === 'agent') {
              item.agentId ??= /agentId: (\w+)/.exec(text)?.[1] ?? null;
              if (c.is_error) item.state = 'error';
            } else {
              const o = cap(text);
              item.output = o.text;
              item.outputCut = o.cut;
              item.state = c.is_error ? 'error' : 'ok';
            }
            out.push(item);
          } else if (c?.type === 'text' && !j.isMeta) {
            const notice = noticeOf(c.text);
            if (notice) put({ id: `${base}-${i}`, kind: 'notice', at, text: notice });
          }
        });
      } else if (j.type === 'assistant' && Array.isArray(content)) {
        content.forEach((c, i) => {
          if (c?.type === 'text' && c.text?.trim()) put({ id: `${base}-${i}`, kind: 'text', at, ...cap(c.text.trim()) });
          else if (c?.type === 'thinking' && c.thinking?.trim()) put({ id: `${base}-${i}`, kind: 'thinking', at, ...cap(c.thinking.trim()) });
          else if (c?.type === 'tool_use' && c.id) {
            const id = String(c.id);
            if (AGENT_TOOLS.has(c.name))
              put({
                id,
                kind: 'agent',
                at,
                type: String(c.input?.subagent_type || 'general-purpose'),
                description: firstLine(c.input?.description || c.input?.prompt || '', 80),
                agentId: null,
                state: 'running',
              });
            else {
              const input = cap(JSON.stringify(c.input ?? {}, null, 2));
              put({
                id,
                kind: 'tool',
                at,
                name: String(c.name),
                summary: rel(describeTool(c.name, c.input ?? {})),
                input: input.text,
                inputCut: input.cut,
                output: null,
                outputCut: false,
                state: 'running',
              });
            }
          }
        });
      }
      if (j.type === 'user' || j.type === 'assistant') first = false;
      return out;
    },
  };
}

// Follows a transcript: onItems(items, { initial, truncated }) first with the last `limit` items,
// then with each change. Waits for a file that does not exist yet. Returns close().
// Claude Code moves a session's transcript (with its subagents folder) to another project folder
// when the session changes its cwd (EnterWorktree, ExitWorktree): with `locate` (() => the path the
// transcript has now), a poll that misses the file asks it, and when it is elsewhere the tail
// switches to it and starts over with an initial list, as a reconnect would.
// No fs.watch on Windows: it holds a handle on the file's folder, so Claude Code could not move the
// session folder a watched subagent transcript is in (EPERM); a shorter poll instead.
const WATCH = process.platform !== 'win32';
export function tailTranscript(
  file,
  onItems,
  { limit = 400, rel, pollMs = WATCH ? 1000 : 500, locate, watch: useWatch = WATCH } = {},
) {
  let condenser = createCondenser({ rel });
  let offset = 0;
  let rest = '';
  let started = false;
  let closed = false;
  let watcher = null;

  const moved = () => {
    if (!locate || existsSync(file)) return;
    let next;
    try {
      next = locate();
    } catch {
      return;
    }
    if (!next || next === file || !existsSync(next)) return;
    // a watch on the old path is stale: drop it, read() watches the new one
    try {
      watcher?.close();
    } catch {
      // already gone
    }
    watcher = null;
    file = next;
    condenser = createCondenser({ rel });
    offset = 0;
    rest = '';
    started = false;
  };
  const read = () => {
    if (closed) return;
    let fd;
    try {
      fd = openSync(file, 'r');
    } catch {
      // not there yet: an empty list now, the steps as Claude Code writes them
      if (!started) begin([]);
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < offset) {
        offset = 0;
        rest = '';
      }
      if (size === offset) return started || begin([]);
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = rest + buf.toString('utf8');
      const cut = text.lastIndexOf('\n');
      rest = cut < 0 ? text : text.slice(cut + 1);
      const changed = new Map();
      for (const line of cut < 0 ? [] : text.slice(0, cut).split('\n')) {
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        for (const item of condenser.feed(j)) changed.set(item.id, item);
      }
      if (!started) begin([...changed.values()]);
      else if (changed.size) onItems([...changed.values()].map((i) => ({ ...i })), { initial: false, truncated: false });
    } finally {
      closeSync(fd);
    }
    if (useWatch && !watcher) {
      try {
        watcher = watch(file, () => read());
        watcher.on('error', () => {});
      } catch {
        // polling alone
      }
    }
  };
  function begin(items) {
    started = true;
    const truncated = items.length > limit;
    onItems((truncated ? items.slice(-limit) : items).map((i) => ({ ...i })), { initial: true, truncated });
  }
  const timer = setInterval(() => {
    moved();
    read();
  }, pollMs);
  read();
  return {
    close() {
      closed = true;
      clearInterval(timer);
      watcher?.close();
    },
  };
}
