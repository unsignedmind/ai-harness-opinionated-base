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
    run({ sessionId, resume, prompt, title, onActivity = () => {} }) {
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

      const onLine = (line) => {
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          return;
        }
        if (j.type === 'system' && j.subtype === 'init') created = true;
        else if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
          for (const c of j.message.content) {
            if (c.type === 'tool_use') onActivity(describeTool(c.name, c.input));
            else if (c.type === 'text' && c.text?.trim()) lastText = c.text;
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
