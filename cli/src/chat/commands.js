// `nos chat <command>`: the only thing Claude Code runs for the local chat. Acts on the chat of the
// project around the current directory (the folder with specs/), so no command takes an id.
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { ensureServer, liveServer, removeServerJson, request, VERSION, writeServerJson } from './client.js';
import { runHook } from './hook.js';
import { launchBrowser } from './launch.js';
import {
  chatConfig,
  ensureStateDir,
  ensureToken,
  files,
  findRoot,
  keyOf,
  portOf,
  realDir,
  SPEC_UI_PORT,
  stateDirOf,
} from './paths.js';
import { createRunner } from './runner.js';
import { createChatServer } from './server.js';
import { createSessionStore } from './sessions.js';

export const CHAT_HELP = `Usage: nos chat [<command>] [options]

Local chat in the spec-ui (or the chat page) for this project. By default the chat server runs
its own headless Claude Code session per chat tab (claude -p, permission mode "auto"). With
"chat": { "runner": false } in specs/config.json a terminal session answers instead (await/reply).
State lives in specs/.chat/ of the project (never committed).

Commands:
  (none)            Server address, version and sessions
  open              Start the server if needed, open or resume the chat, print its url
                    [--name n] [--no-open] [--reopen]
  await             Block until the user writes or ends the chat  [--name n] [--timeout-ms n]
  reply             Send a reply, text from stdin or --text        [--name n] [--text t]
  typing            Set presence: thinking, typing or idle         [--name n] [--state s]
  pending           Sessions with undelivered messages (read from disk)
  end               End the chat as the agent                      [--name n]
  stop              Shut the server down
  pair              Pairing links for devices on the home network  [--rotate]
  server            Run the server in the foreground               [--port n]
  hook              Stop hook: hand queued messages to Claude Code (reads hook JSON on stdin)

Options:
  --root <dir>      Project root (default: nearest folder with specs/ from the current directory)

Results are JSON on stdout. Errors print { "error" } and exit 1.`;

const NEXT = {
  messages:
    'Answer in the chat with `nos chat reply`, then run `nos chat await` again in the background.',
  ended: 'The user sent this and closed the chat. Do what it asks, report in the terminal, and do not reopen the chat.',
  userEnded: 'The user closed the chat. Stop listening and do not reopen it unless asked.',
  waiting: 'No message yet. Run `nos chat await` again.',
  agentEnded: 'The chat was ended. Stop listening.',
  noServer: 'The chat server is not running. Run `nos chat open` if the user wants to chat.',
};

const OPTIONS = {
  root: { type: 'string' },
  name: { type: 'string' },
  'no-open': { type: 'boolean' },
  reopen: { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  text: { type: 'string' },
  state: { type: 'string' },
  port: { type: 'string' },
  rotate: { type: 'boolean' },
};

export function withNextStep(r) {
  if (r.status === 'messages') return { ...r, next_step: r.sessionEnded ? NEXT.ended : NEXT.messages };
  if (r.status === 'ended') return { ...r, next_step: r.endedBy === 'user' ? NEXT.userEnded : NEXT.agentEnded };
  if (r.status === 'waiting') return { ...r, next_step: NEXT.waiting };
  if (r.status === 'no-server') return { ...r, next_step: NEXT.noServer };
  if (r.status === 'runner') return { ...r, next_step: NEXT.runner };
  return r;
}

// adapters of VMs, WSL and containers: a phone cannot reach them
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|br-|veth|utun|tailscale|zerotier/i;

// pairing links: one per IPv4 address of this machine, to the spec-ui dev server; real adapters first
export function pairUrls(token, nets = networkInterfaces(), port = SPEC_UI_PORT) {
  return Object.entries(nets)
    .flatMap(([name, list]) =>
      (list ?? [])
        .filter((n) => n.family === 'IPv4' && !n.internal)
        .map((n) => ({ interface: name, virtual: VIRTUAL.test(name), url: `http://${n.address}:${port}/?pair=${token}` })),
    )
    .sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

function idleOf(env) {
  const v = env.NOS_CHAT_IDLE_MS;
  if (v === undefined || v === '') return 1800000;
  if (v === '0' || v === 'off') return 0;
  return Number(v) || 1800000;
}

async function serve(root, stateDir, port, { env, stderr }) {
  ensureStateDir(stateDir);
  const store = createSessionStore({ file: files(stateDir).sessions });
  const cfg = chatConfig(root);
  const runner = cfg.runner
    ? createRunner({ root: realDir(root), bin: cfg.claude, mode: cfg.permissionMode, model: cfg.model, env })
    : null;
  const chat = createChatServer({
    runner,
    store,
    version: VERSION,
    root: realDir(root),
    idleMs: idleOf(env),
    onStop: () => {
      removeServerJson(stateDir);
      stderr.write('nos chat: server stopped\n');
      process.exit(0);
    },
  });
  let bound;
  try {
    bound = await chat.listen(port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || port === 0) throw err;
    bound = await chat.listen(0);
  }
  writeServerJson(stateDir, {
    pid: process.pid,
    port: bound,
    version: VERSION,
    root: realDir(root),
    startedAt: new Date().toISOString(),
  });
  stderr.write(
    `nos chat: listening on http://127.0.0.1:${bound}/ for ${realDir(root)}` +
      (runner ? ` (own Claude Code sessions, permission mode ${cfg.permissionMode})\n` : ' (relay)\n'),
  );
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void chat.stop());
  return new Promise(() => {}); // runs until stopped
}

export async function runChat(argv, io = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    readStdin = async () => {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    },
    launch = launchBrowser,
  } = io;
  const print = (o) => stdout.write(JSON.stringify(o, null, 2) + '\n');
  const [cmd = 'status', ...args] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help' || args.includes('--help')) {
    stdout.write(CHAT_HELP + '\n');
    return 0;
  }

  try {
    if (cmd === 'hook') {
      // never breaks the session: any problem means no output and exit 0
      const out = await runHook(await readStdin().catch(() => ''), { env }).catch(() => null);
      if (out) stdout.write(JSON.stringify(out) + '\n');
      return 0;
    }

    const { values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false });
    const root = values.root ? realDir(values.root) : findRoot(cwd);
    const stateDir = stateDirOf(root, env);
    const name = values.name ?? '';
    const key = keyOf(root, name);

    switch (cmd) {
      case 'status': {
        const live = await liveServer(root, stateDir);
        print({
          server: live ? `http://127.0.0.1:${live.port}/` : null,
          version: live?.version ?? VERSION,
          root,
          sessions: createSessionStore({ file: files(stateDir).sessions }).list(),
        });
        return 0;
      }
      case 'server': {
        const port = values.port !== undefined ? Number(values.port) : portOf(root, env);
        await serve(root, stateDir, port, { env, stderr });
        return 0;
      }
      case 'open': {
        const port = await ensureServer(root, stateDir, { env, log: (m) => stderr.write(`nos chat: ${m}\n`) });
        const r = await request(port, 'POST', '/api/sessions', { dir: root, name, reopen: values.reopen === true });
        if (r.code === 409) {
          print({ status: 'user-ended', key: r.body.key, next_step: 'The user ended this chat. Reopen only when asked: `nos chat open --reopen`.' });
          return 0;
        }
        if (r.code !== 200) throw new Error(r.body.error ?? `open failed (${r.code})`);
        const url = `http://127.0.0.1:${port}/chat/${r.body.key}`;
        if (!values['no-open']) launch(url);
        print({
          status: 'open',
          url,
          key: r.body.key,
          specUi: `http://localhost:${SPEC_UI_PORT}/ (chat button in the header)`,
          next_step: 'Run `nos chat await` in the background now.',
        });
        return 0;
      }
      case 'pending': {
        const sessions = createSessionStore({ file: files(stateDir).sessions })
          .list()
          .filter((s) => s.pending > 0 && s.status !== 'ended');
        print({ status: sessions.length ? 'pending' : 'clear', sessions });
        return 0;
      }
      case 'pair': {
        const token = ensureToken(stateDir, values.rotate === true);
        print({
          status: 'ok',
          rotated: values.rotate === true,
          urls: pairUrls(token),
          note: 'Open the link of the network the phone is on (not a virtual adapter) while the spec-ui runs with `npm run dev-to-lan`. --rotate unpairs every device.',
        });
        return 0;
      }
    }

    const live = await liveServer(root, stateDir);
    if (!live) {
      print(withNextStep({ status: 'no-server' }));
      return 0;
    }
    const port = live.port;
    const call = async (method, p, body) => {
      const r = await request(port, method, p, body);
      if (r.code >= 400) throw new Error(r.body.error ?? `request failed (${r.code})`);
      return r.body;
    };

    switch (cmd) {
      case 'await': {
        const t = values['timeout-ms'];
        const body = { key, ...(t !== undefined && { timeoutMs: Number(t) }) };
        print(withNextStep(await call('POST', '/api/await', body)));
        return 0;
      }
      case 'reply': {
        const text = values.text ?? (await readStdin());
        print(await call('POST', `/api/session/${key}/reply`, { text: text.replace(/\s+$/, '') }));
        return 0;
      }
      case 'typing':
        print(await call('POST', `/api/session/${key}/typing`, { state: values.state ?? 'typing' }));
        return 0;
      case 'end':
        print(await call('POST', `/api/session/${key}/agent-end`, {}));
        return 0;
      case 'stop':
        print(await call('POST', '/shutdown', {}));
        return 0;
      default:
        throw new Error(`Unknown chat command "${cmd}". Run "nos chat --help".`);
    }
  } catch (err) {
    print({ error: err.message });
    return 1;
  }
}

