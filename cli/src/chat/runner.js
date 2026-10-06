// Runs Claude Code headless for a chat tab: one long-lived `claude -p` with stream-json in and out,
// resumed by session id, so every tab is one ongoing Claude Code conversation started in the main checkout
// of the project (a run then enters its worktree with EnterWorktree). Unmodified Claude Code with the
// user's own login; nothing here reads a token. Tool calls become activity lines, text blocks are replies,
// subagents are tracked from the task events, the nos run of the tab from the CLI's run results.
import { spawn } from 'node:child_process';
import { killTree } from '../proc.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

export const SYSTEM_NOTE =
  'You are driven from the nos chat (spec-ui in a browser, often a phone). The user reads your ' +
  'messages as plain text with code fences, so keep them short and readable on a small screen. Nobody ' +
  'can answer permission prompts: a refused tool means it is not allowed here, say so instead of ' +
  'retrying. Questions with choices: one choice per line, "<letter> - <choice text> [<key>]". A ' +
  'message starting with "[to subagent <id>" is the user writing to that subagent: forward the text ' +
  'after the bracket verbatim with SendMessage to that id, then confirm in one short line.';

// environment of the Claude Code session that may have started the server: never inherited
const SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|MESSAGING_.*|ENTRYPOINT|SESSION_ATTENDED|EXECPATH))$/;
// nos variables a tab's session must not inherit either: NOS_SPECS_ROOT would beat the resolver's walk
// from the session's cwd (its worktree), NOS_RUN_TOKEN would hand it the run of another session
const NOS_VARS = new Set(['NOS_SPECS_ROOT', 'NOS_RUN_TOKEN']);

export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_VARS.test(k) && !NOS_VARS.has(k)));
}

const short = (s, n = 80) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// one line for a tool call: "Bash: npm test", "Edit: src/app.ts"
export function describeTool(name, input = {}) {
  const arg =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.url ??
    input.description ??
    input.prompt ??
    '';
  return arg ? `${name}: ${short(arg)}` : name;
}

// paths in the project root (main), relative to it (both slash forms)
export function relTo(root = '') {
  const dirs = root ? [...new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])] : [];
  return (t) =>
    dirs.reduce(
      (s, d) =>
        s
          .split(d + '/')
          .join('')
          .split(d + '\\')
          .join(''),
      t,
    );
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
// its id as parent_tool_use_id. SendMessage to an agent resumes it: then its events and tool calls
// come under the SendMessage id, whose own tool_result is no end. An agent of an earlier process
// shows up through task_started. line(j) says whether the list changed. Paths in the project root
// are shown relative to it.
export function agentTracker(now = Date.now, root = '') {
  const rel = relTo(root);
  const agents = new Map(); // Agent tool_use id -> agent
  const ids = new Map(); // every tool_use id an agent runs under (Agent call, resuming SendMessage) -> agent
  const calls = new Set(); // ids of Agent/Task calls: only their tool_result can end an agent
  const byAgentId = (id) => (id ? [...agents.values()].find((a) => a.agentId === id) : undefined);
  const find = (j) => ids.get(j.tool_use_id) ?? byAgentId(j.task_id);
  const add = (id, type, description, agentId = null) => {
    const a = {
      id: String(id),
      type: short(type || 'general-purpose', 40),
      description: short(description || '', 80),
      status: 'running',
      activity: null,
      tools: 0,
      startedAt: now(),
      endedAt: null,
      agentId,
    };
    agents.set(a.id, a);
    ids.set(a.id, a);
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
    list: () => [...agents.values()].map((a) => ({ ...a })),
    running: () => [...agents.values()].some((a) => a.status === 'running'),
    rel,
    line(j) {
      let changed = false;
      const content = Array.isArray(j.message?.content) ? j.message.content : [];
      if (j.type === 'assistant')
        for (const c of content) {
          if (c.type !== 'tool_use') continue;
          const parent = ids.get(j.parent_tool_use_id);
          if (parent && parent.status === 'running') {
            parent.activity = rel(describeTool(c.name, c.input));
            parent.tools++;
            changed = true;
          }
          if (AGENT_TOOLS.has(c.name) && c.id && !ids.has(c.id)) {
            calls.add(String(c.id));
            add(c.id, c.input?.subagent_type, c.input?.description || c.input?.prompt);
            changed = true;
          }
          const back = c.name === 'SendMessage' && byAgentId(String(c.input?.to ?? ''));
          if (back) {
            if (c.id) ids.set(String(c.id), back);
            if (back.status !== 'running') resume(back);
            changed = true;
          }
        }
      else if (j.type === 'user')
        for (const c of content) {
          const a = c.type === 'tool_result' && ids.get(c.tool_use_id);
          if (!a) continue;
          const text = textOf(c.content);
          a.agentId ??= /agentId: (\w+)/.exec(text)?.[1] ?? null;
          if (c.is_error) changed = end(a, 'failed') || changed;
          // a foreground agent's report; "Async agent launched" or a resume ack is no end
          else if (calls.has(c.tool_use_id) && !/Async agent launched/i.test(text)) changed = end(a, 'done') || changed;
        }
      else if (j.type === 'system' && j.subtype === 'task_started') {
        const a = find(j);
        if (a) {
          a.agentId ??= j.task_id ?? null;
          if (j.tool_use_id) ids.set(String(j.tool_use_id), a);
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

// The end of the JSON object that starts at text[start] ('{'), -1 when it does not close
function closeOf(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// The outermost JSON objects in a text (CLI output, single line or pretty-printed, maybe between other
// lines), in order. Text that is no JSON is skipped.
export function jsonObjects(text) {
  const found = [];
  for (let i = text.indexOf('{'); i >= 0;) {
    const end = closeOf(text, i);
    let value;
    try {
      value = end > 0 ? JSON.parse(text.slice(i, end + 1)) : undefined;
    } catch {
      value = undefined;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      found.push(value);
      i = text.indexOf('{', end + 1);
    } else i = text.indexOf('{', i + 1);
  }
  return found;
}

const RUN_ACTION = /"action"\s*:\s*"run-(start|cleanup|abandon)"/;
const field = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? v : null);

// The nos run a tool result reports (D-8): the result of `nos run start` → { kind, id, domain, branch,
// worktree } (never the token), of `nos run cleanup` or `nos run abandon` → null, anything else (no run
// result, an error report { action, error, … }, output that is no JSON) → undefined. The last one wins.
// content: the tool_result content, a string or an array of { type: 'text', text } items.
export function runOf(content) {
  const text = textOf(content);
  if (!RUN_ACTION.test(text)) return undefined;
  let run;
  for (const o of jsonObjects(text)) {
    if ('error' in o) continue;
    if (o.action === 'run-start' && o.run && typeof o.run === 'object') {
      const r = { kind: field(o.run.kind), id: field(o.run.id), domain: field(o.run.domain) };
      Object.assign(r, { branch: field(o.run.branch), worktree: field(o.run.worktree) });
      if (r.id !== null || r.worktree !== null) run = r;
    } else if (o.action === 'run-cleanup' || o.action === 'run-abandon') run = null;
  }
  return run;
}

// A shell call of the tab's own session that runs `nos run start|cleanup|abandon` (nos.js by path or a
// `nos` alias). Only the results of these calls are parsed for runOf, so a Read or grep of a file holding
// such JSON never counts. A background shell call (run_in_background) is not covered: its output comes
// later through another tool.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const RUN_CALL = /\bnos(\.js)?\b[\s\S]*\brun\s+(start|cleanup|abandon)\b/;
export function isRunCall(name, input) {
  return SHELL_TOOLS.has(name) && typeof input?.command === 'string' && RUN_CALL.test(input.command);
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

export function createRunner({ root, bin = 'claude', mode = 'auto', model, env = process.env, spawnFn = spawn }) {
  return {
    mode,
    // One long-lived Claude Code process for a tab: user messages go in on stdin as stream-json,
    // so they reach Claude at once (also while it works) and background agents keep running after
    // a turn ends. Each top-level text block is a reply as soon as it comes; a turn ends with a
    // `result`. Callbacks: onStarted (the session exists), onBusy(bool), onText, onError,
    // onActivity, onAgents, onRun(run or null: a nos run started or ended, see runOf), onExit({ stopped, error }).
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
      onRun = () => {},
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
      // tool_use ids of the session's own `nos run …` shell calls whose result is still to come
      const runCalls = new Set();
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
            if (c.type === 'tool_use') {
              onActivity(agents.rel(describeTool(c.name, c.input)));
              // subagents never start runs, the orchestrating session does
              if (!j.parent_tool_use_id && c.id && isRunCall(c.name, c.input)) runCalls.add(String(c.id));
            }
            // a subagent's text is not a reply
            else if (c.type === 'text' && c.text?.trim() && !j.parent_tool_use_id) {
              said = true;
              onText(c.text.trim());
            }
          }
        } else if (j.type === 'user' && !j.parent_tool_use_id && Array.isArray(j.message?.content)) {
          for (const c of j.message.content) {
            if (c?.type !== 'tool_result' || !runCalls.delete(String(c.tool_use_id))) continue;
            if (c.is_error) continue;
            const run = runOf(c.content);
            if (run !== undefined) onRun(run);
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
              ? `Claude Code ("${bin}") was not found on the host. Install it or set "chat": { "claude": "<path>" } in <specs>/config.json.`
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
