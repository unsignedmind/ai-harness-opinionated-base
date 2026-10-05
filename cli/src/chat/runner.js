// Runs Claude Code headless for a chat tab: one `claude -p` per batch of user messages, resumed by
// session id, so every tab is one ongoing Claude Code conversation in the project root. Unmodified
// Claude Code with the user's own login; nothing here reads a token. Output is stream-json: tool
// calls become activity lines, the final `result` is the reply.
import { spawn } from 'node:child_process';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

export const SYSTEM_NOTE =
  'You are driven from the nos chat (spec-ui in a browser, often a phone). The user reads your final ' +
  'message as plain text with code fences, so keep it short and readable on a small screen. Nobody ' +
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

// Subagents of a run, from the stream-json lines: an Agent/Task tool call starts one, the messages
// with its id as parent_tool_use_id are its own tool calls, its tool_result ends it. A background
// agent's tool_result only says it was launched; its end comes as a system task_* event, if at all.
// line(j) says whether the list changed. Paths in the project root are shown relative to it.
export function agentTracker(now = Date.now, root = '') {
  const dirs = root ? [...new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])] : [];
  const rel = (t) => dirs.reduce((s, d) => s.split(d + '/').join('').split(d + '\\').join(''), t);
  const agents = new Map(); // tool_use id -> agent
  const tasks = new Map(); // task_id -> tool_use id
  const byTask = (j) => agents.get(j.tool_use_id) ?? agents.get(tasks.get(j.task_id));
  const end = (a, status) => {
    if (a.status !== 'running') return false;
    a.status = status;
    a.activity = null;
    a.endedAt = now();
    return true;
  };
  return {
    list: () => [...agents.values()].map(({ background, ...a }) => ({ ...a })),
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
            agents.set(c.id, {
              id: String(c.id),
              type: short(c.input?.subagent_type || 'general-purpose', 40),
              description: short(c.input?.description || c.input?.prompt || '', 80),
              status: 'running',
              activity: null,
              tools: 0,
              startedAt: now(),
              endedAt: null,
              background: !!c.input?.run_in_background,
            });
            changed = true;
          }
        }
      else if (j.type === 'user')
        for (const c of content) {
          const a = c.type === 'tool_result' && agents.get(c.tool_use_id);
          if (a && (c.is_error || !a.background)) changed = end(a, c.is_error ? 'failed' : 'done') || changed;
        }
      else if (j.type === 'system' && j.subtype === 'task_started' && j.task_id && agents.has(j.tool_use_id))
        tasks.set(j.task_id, j.tool_use_id);
      else if (j.type === 'system' && j.subtype === 'task_progress') {
        const a = byTask(j);
        if (a && a.status === 'running') {
          if (j.last_tool_name) a.activity = String(j.last_tool_name);
          if (Number.isInteger(j.usage?.tool_uses)) a.tools = j.usage.tool_uses;
          changed = true;
        }
      } else if (j.type === 'system' && j.subtype === 'task_notification') {
        const a = byTask(j);
        if (a) changed = end(a, TASK_END[j.status] ?? 'done');
      }
      return changed;
    },
    // the run is over: whatever still runs ended with it
    finish(stopped) {
      let changed = false;
      for (const a of agents.values()) changed = end(a, stopped ? 'stopped' : 'done') || changed;
      return changed;
    },
  };
}

export function argsFor({ sessionId, resume, mode = 'auto', model, title }) {
  if (!UUID.test(sessionId)) throw new Error('invalid session id');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
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
    // returns { done: Promise<{ text, error, stopped, created }>, stop() }
    run({ sessionId, resume, prompt, title, onActivity = () => {}, onAgents = () => {} }) {
      const child = spawnFn(bin, argsFor({ sessionId, resume, mode, model, title }), {
        cwd: root,
        env: cleanEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let stopped = false;
      let created = resume;
      let result = null;
      let lastText = '';
      let errText = '';
      let buf = '';
      const agents = agentTracker(Date.now, root);

      const onLine = (line) => {
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          return;
        }
        if (j && typeof j === 'object' && agents.line(j)) onAgents(agents.list());
        if (j.type === 'system' && j.subtype === 'init') created = true;
        else if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
          for (const c of j.message.content) {
            if (c.type === 'tool_use') onActivity(describeTool(c.name, c.input));
            // a subagent's text is not the reply
            else if (c.type === 'text' && c.text?.trim() && !j.parent_tool_use_id) lastText = c.text;
          }
        } else if (j.type === 'result') result = j;
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

      const done = new Promise((resolve) => {
        let settled = false;
        const finish = (r) => {
          if (!settled) {
            settled = true;
            resolve({ created, stopped, ...r });
          }
        };
        child.on('error', (e) =>
          finish({
            error: e.code === 'ENOENT' ? `Claude Code ("${bin}") was not found on the host. Install it or set "chat": { "claude": "<path>" } in specs/config.json.` : e.message,
          }),
        );
        child.on('close', (code) => {
          if (buf.trim()) onLine(buf);
          if (agents.finish(stopped)) onAgents(agents.list());
          if (stopped) return finish({ text: null });
          if (result && !result.is_error) return finish({ text: String(result.result ?? lastText ?? '').trim() || '(no answer)' });
          const why = result?.result || result?.subtype || short(errText, 400) || `claude exited with code ${code}`;
          finish({ error: String(why) });
        });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      return {
        done,
        stop() {
          stopped = true;
          killTree(child);
        },
      };
    },
  };
}
