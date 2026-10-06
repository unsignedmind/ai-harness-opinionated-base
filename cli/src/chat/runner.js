// Runs Claude Code headless for a chat tab: one long-lived `claude -p` with stream-json in and out,
// resumed by session id, so every tab is one ongoing Claude Code conversation in the project root.
// Unmodified Claude Code with the user's own login; nothing here reads a token. Tool calls become
// activity lines, text blocks are replies, subagents are tracked from the task events.
import { spawn } from 'node:child_process';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

export const SYSTEM_NOTE =
  'You are driven from the nos chat (spec-ui in a browser, often a phone). The user reads your ' +
  'messages as plain text with code fences, so keep them short and readable on a small screen. Nobody ' +
  'can answer permission prompts: a refused tool means it is not allowed here, say so instead of ' +
  'retrying. Questions with choices: one choice per line, "<letter> - <choice text> [<key>]".';

// environment of the Claude Code session that may have started the server: never inherited
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|MESSAGING_.*|ENTRYPOINT|SESSION_ATTENDED|EXECPATH))$/;

export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_VARS.test(k)));
}

const short = (s, n = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// one line for a tool call: "Bash: npm test", "Edit: src/app.ts"
export function describeTool(name, input = {}) {
  const arg =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.prompt ?? '';
  return arg ? `${name}: ${short(arg)}` : name;
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TASK_END = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped' };

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      : '';

// Subagents of a tab's Claude Code process, from the stream-json lines. An Agent/Task tool call
// starts one. Its tool_result either ends it (a foreground agent) or only says "Async agent
// launched" (a background agent, the default): then the system task_* events carry its progress
// and its end, keyed by the Agent tool_use id (task_id = its agentId). Its own tool calls come with
// its id as parent_tool_use_id. SendMessage to an ended agent resumes it; an agent of an earlier
// process shows up through task_started. line(j) says whether the list changed. Paths in the
// project root are shown relative to it.
export function agentTracker(now = Date.now, root = '') {
  const dirs = root ? [...new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])] : [];
  const rel = (t) => dirs.reduce((s, d) => s.split(d + '/').join('').split(d + '\\').join(''), t);
  const agents = new Map(); // Agent tool_use id -> agent
  const byAgentId = (id) => (id ? [...agents.values()].find((a) => a.agentId === id) : undefined);
  const find = (j) => agents.get(j.tool_use_id) ?? byAgentId(j.task_id);
  const add = (id, type, description, agentId = null) => {
    agents.set(String(id), {
      id: String(id),
      type: short(type || 'general-purpose', 40),
      description: short(description || '', 80),
      status: 'running',
      activity: null,
      tools: 0,
      startedAt: now(),
      endedAt: null,
      agentId,
    });
  };
  const resume = (a) => Object.assign(a, { status: 'running', activity: null, endedAt: null });
  const end = (a, status) => {
    if (a.status !== 'running') return false;
    a.status = status;
    a.activity = null;
    a.endedAt = now();
    return true;
  };
  return {
    list: () => [...agents.values()].map(({ agentId, ...a }) => ({ ...a })),
    running: () => [...agents.values()].some((a) => a.status === 'running'),
    rel,
    line(j) {
      let changed = false;
      const content = Array.isArray(j.message?.content) ? j.message.content : [];
      if (j.type === 'assistant')
        for (const c of content) {
          if (c.type !== 'tool_use') continue;
          const parent = agents.get(j.parent_tool_use_id);
          if (parent && parent.status === 'running') {
            parent.activity = rel(describeTool(c.name, c.input));
            parent.tools++;
            changed = true;
          }
          if (AGENT_TOOLS.has(c.name) && c.id && !agents.has(c.id)) {
            add(c.id, c.input?.subagent_type, c.input?.description || c.input?.prompt);
            changed = true;
          }
          const back = c.name === 'SendMessage' && byAgentId(String(c.input?.to ?? ''));
          if (back && back.status !== 'running') {
            resume(back);
            changed = true;
          }
        }
      else if (j.type === 'user')
        for (const c of content) {
          const a = c.type === 'tool_result' && agents.get(c.tool_use_id);
          if (!a) continue;
          const text = textOf(c.content);
          a.agentId ??= /agentId: (\w+)/.exec(text)?.[1] ?? null;
          if (c.is_error) changed = end(a, 'failed') || changed;
          else if (!/Async agent launched/i.test(text)) changed = end(a, 'done') || changed;
        }
      else if (j.type === 'system' && j.subtype === 'task_started') {
        const a = find(j);
        if (a) {
          a.agentId ??= j.task_id ?? null;
          if (a.status !== 'running') resume(a);
          changed = true;
        } else if (j.task_type === 'local_agent' && j.tool_use_id) {
          add(j.tool_use_id, j.subagent_type, j.description, j.task_id ?? null);
          changed = true;
        }
      } else if (j.type === 'system' && j.subtype === 'task_progress') {
        const a = find(j);
        if (a && a.status === 'running') {
          if (Number.isInteger(j.usage?.tool_uses)) a.tools = j.usage.tool_uses;
          if (!a.activity && j.description) a.activity = short(j.description);
          changed = true;
        }
      } else if (j.type === 'system' && j.subtype === 'task_notification') {
        const a = find(j);
        if (a) changed = end(a, TASK_END[j.status] ?? 'done');
      }
      return changed;
    },
    // the process is gone: whatever still ran went down with it
    finish() {
      let changed = false;
      for (const a of agents.values()) changed = end(a, 'stopped') || changed;
      return changed;
    },
  };
}

export function argsFor({ sessionId, resume, mode = 'auto', model, title }) {
  if (!UUID.test(sessionId)) throw new Error('invalid session id');
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-prompts', 'none');
  args.push('--permission-mode', MODES.includes(mode) ? mode : 'auto');
  args.push(resume ? '--resume' : '--session-id', sessionId);
  if (!resume && title) args.push('--name', `nos chat: ${short(title, 40)}`);
  if (model && /^[\w.:-]+$/.test(model)) args.push('--model', model);
  args.push('--append-system-prompt', SYSTEM_NOTE);
  return args;
}

function killTree(child, platform = process.platform) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

export function createRunner({ root, bin = 'claude', mode = 'auto', model, env = process.env, spawnFn = spawn }) {
  return {
    mode,
    // One long-lived Claude Code process for a tab: user messages go in on stdin as stream-json,
    // so they reach Claude at once (also while it works) and background agents keep running after
    // a turn ends. Each top-level text block is a reply as soon as it comes; a turn ends with a
    // `result`. Callbacks: onStarted (the session exists), onBusy(bool), onText, onError,
    // onActivity, onAgents, onExit({ stopped, error }).
    open({
      sessionId,
      resume,
      title,
      onStarted = () => {},
      onBusy = () => {},
      onText = () => {},
      onError = () => {},
      onActivity = () => {},
      onAgents = () => {},
      onExit = () => {},
    }) {
      const child = spawnFn(bin, argsFor({ sessionId, resume, mode, model, title }), {
        cwd: root,
        env: cleanEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const agents = agentTracker(Date.now, root);
      let stopped = false;
      let closed = false;
      let busy = false;
      let gone = false;
      // a reply of this turn is already posted: the result repeats it
      let said = false;
      let errText = '';
      let buf = '';
      let lastUse = Date.now();
      const setBusy = (b) => {
        if (b === busy) return;
        busy = b;
        onBusy(b);
      };
      const exit = (r) => {
        if (gone) return;
        gone = true;
        busy = false;
        if (agents.finish()) onAgents(agents.list());
        onExit(r);
      };

      const onLine = (line) => {
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          return;
        }
        if (!j || typeof j !== 'object') return;
        lastUse = Date.now();
        if (agents.line(j)) onAgents(agents.list());
        if (j.type === 'system' && j.subtype === 'init') {
          said = false;
          onStarted();
          setBusy(true);
        } else if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
          for (const c of j.message.content) {
            if (c.type === 'tool_use') onActivity(agents.rel(describeTool(c.name, c.input)));
            // a subagent's text is not a reply
            else if (c.type === 'text' && c.text?.trim() && !j.parent_tool_use_id) {
              said = true;
              onText(c.text.trim());
            }
          }
        } else if (j.type === 'result') {
          const text = String(j.result ?? '').trim();
          if (j.is_error) onError(text || String(j.subtype ?? 'error'));
          else if (!said && text) onText(text);
          said = false;
          setBusy(false);
        }
      };
      child.stdout.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (c) => {
        errText = (errText + c).slice(-2000);
      });
      child.on('error', (e) =>
        exit({
          stopped,
          error:
            e.code === 'ENOENT'
              ? `Claude Code ("${bin}") was not found on the host. Install it or set "chat": { "claude": "<path>" } in specs/config.json.`
              : e.message,
        }),
      );
      child.on('close', (code) => {
        if (buf.trim()) onLine(buf);
        const quiet = stopped || closed || (!busy && code === 0);
        exit({ stopped, error: quiet ? null : short(errText, 400) || `claude exited with code ${code}` });
      });
      child.stdin.on('error', () => {});

      return {
        get busy() {
          return busy;
        },
        get agentsRunning() {
          return agents.running();
        },
        get lastUse() {
          return lastUse;
        },
        send(prompt) {
          if (gone || closed) return false;
          lastUse = Date.now();
          child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
          setBusy(true);
          return true;
        },
        // no more messages: Claude Code ends once it is done
        close() {
          closed = true;
          child.stdin.end();
        },
        stop() {
          stopped = true;
          killTree(child);
        },
      };
    },
  };
}
