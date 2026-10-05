// Dev server side of the chat (src/chat.ts): the spec-ui reaches the project's chat server
// (`nos chat`, 127.0.0.1 only) through these same-origin routes, so EventSource and fetch need no
// CORS and the chat server never faces the network. Only the user's side of the API is passed on.
// Tabs are the chat sessions of this project; `?key=` picks one (default: the project's first):
//   GET  /__chat/state         { key, server, runner, tabs }
//   POST /__chat/open          runs `nos chat open --no-open` (?reopen=1 after the user ended it)
//   POST /__chat/new           { title? } a new tab, its own Claude Code session
//   GET  /__chat/events        project-wide event stream (sessions, chat-sync, presence, activity, ended)
//   POST /__chat/messages      { text }  ?key=
//   POST /__chat/end           close a tab  ?key=
//   POST /__chat/stop          stop the running Claude Code run of a tab  ?key=
//   POST /__chat/title         { title } rename a tab  ?key=
// Couch mode (`npm run dev-to-lan`): requests from this machine pass; any other device needs the
// pairing cookie, set by opening `/?pair=<token>` (token in specs/.chat/token, `nos chat pair`).
// Mutating calls must come from the page itself (Origin host == Host).
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

export const COOKIE = 'nos_chat';
const MAX_BODY = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const nosCli = () => fileURLToPath(new URL('../../cli/bin/nos.js', import.meta.url));

export const stateDirOf = (root: string, env = process.env) =>
  env.NOS_CHAT_STATE_DIR ? resolve(env.NOS_CHAT_STATE_DIR) : join(root, 'specs', '.chat');

const realDir = (dir: string) => {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
};

// same as keyOf in cli/src/chat/paths.js: sha256 of the real project path, first 12 hex chars
export const keyOf = (root: string) => createHash('sha256').update(realDir(root)).digest('hex').slice(0, 12);

export function readToken(stateDir: string): string | null {
  try {
    const t = readFileSync(join(stateDir, 'token'), 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

// same format as `nos chat pair`
export function ensureToken(stateDir: string): string {
  const t = readToken(stateDir);
  if (t) return t;
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(join(stateDir, '.gitignore'))) writeFileSync(join(stateDir, '.gitignore'), '*\n');
  const fresh = randomBytes(32).toString('hex');
  writeFileSync(join(stateDir, 'token'), fresh + '\n', { mode: 0o600 });
  return fresh;
}

export function sameToken(a: string | null | undefined, b: string | null | undefined) {
  const x = Buffer.from(a ?? '');
  const y = Buffer.from(b ?? '');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export function hostOf(header: string | undefined): string | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d{1,5})?$/.exec(String(header ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

export function cookieOf(req: Req, name = COOKIE): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// This machine: loopback socket AND loopback Host (a LAN client can fake the Host header, a page
// using DNS rebinding cannot fake a loopback Host)
export const isLocal = (req: Req) =>
  LOOPBACK_ADDRS.has(req.socket?.remoteAddress ?? '') && LOOPBACK_HOSTS.has(hostOf(req.headers.host) ?? '');

export function authorized(req: Req, stateDir: string) {
  return isLocal(req) || sameToken(cookieOf(req), readToken(stateDir));
}

// POSTs must come from the page itself
export function sameOrigin(req: Req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

// adapters of VMs, WSL and containers: a phone cannot reach them (same list as `nos chat pair`)
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|br-|veth|utun|tailscale|zerotier/i;

export function pairUrls(
  token: string,
  port: number,
  nets = networkInterfaces(),
): { interface: string; virtual: boolean; url: string }[] {
  return Object.entries(nets)
    .flatMap(([name, list]) =>
      (list ?? [])
        .filter((n) => n.family === 'IPv4' && !n.internal)
        .map((n) => ({
          interface: name,
          virtual: VIRTUAL.test(name),
          url: `http://${n.address}:${port}/?pair=${token}`,
        })),
    )
    .sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

// `/?pair=<token>` (or /dev.html?pair=): sets the pairing cookie and drops the token from the url.
// Returns true when it answered the request.
export function pairHandler(stateDir: string) {
  return (req: Req, res: Res): boolean => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.searchParams.has('pair') || (url.pathname !== '/' && url.pathname !== '/dev.html')) return false;
    if (!sameToken(url.searchParams.get('pair'), readToken(stateDir))) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('This pairing link is not valid (anymore). Get a new one with `nos chat pair` on the host.');
      return true;
    }
    res.statusCode = 302;
    res.setHeader('Set-Cookie', `${COOKIE}=${readToken(stateDir)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    res.setHeader('Location', '/');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return true;
  };
}

function readBody(req: Req): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function serverPort(stateDir: string): number | null {
  try {
    const p = JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8')).port;
    return Number.isInteger(p) ? p : null;
  } catch {
    return null;
  }
}

const json = (res: Res, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

// one call to the chat server; streams the answer back (event stream included)
function forward(res: Res, port: number, method: string, path: string, body?: Buffer) {
  const up = http.request(
    {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body && { 'content-type': 'application/json', 'content-length': String(body.length) }),
      },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, {
        'Content-Type': r.headers['content-type'] ?? 'application/json',
        'Cache-Control': 'no-store',
        ...(r.headers['content-type']?.startsWith('text/event-stream') && { 'X-Accel-Buffering': 'no' }),
      });
      r.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) json(res, 503, { error: 'chat server not running' });
    else res.end();
  });
  res.on('close', () => up.destroy());
  up.end(body);
}

function get(port: number, path: string): Promise<{ code: number; body: unknown } | null> {
  return new Promise((done) => {
    const r = http.get({ host: '127.0.0.1', port, path, timeout: 1000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          done({ code: res.statusCode ?? 0, body: JSON.parse(b) });
        } catch {
          done(null);
        }
      });
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => done(null));
  });
}

export type ChatHandlerOptions = { cli?: string; stateDir?: string };

export function chatHandler(root: string, opts: ChatHandlerOptions = {}) {
  const stateDir = opts.stateDir ?? stateDirOf(root);
  const cli = opts.cli ?? nosCli();
  const key = keyOf(root);

  return async (req: Req, res: Res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = url.pathname.replace(/^\/__chat/, '');
    const method = req.method ?? 'GET';
    if (!authorized(req, stateDir)) return json(res, 401, { error: 'unpaired' });
    if (method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'forbidden' });

    if (method === 'GET' && route === '/state') {
      const port = serverPort(stateDir);
      const r = port ? await get(port, '/api/sessions') : null;
      const body = (r?.code === 200 ? r.body : null) as { tabs?: unknown[]; runner?: boolean } | null;
      // a chat server of an older nos has no tabs: counts as not running, `nos chat open` replaces it
      const live = !!body && Array.isArray(body.tabs);
      return json(res, 200, { key, server: live, runner: live && !!body.runner, tabs: live ? body.tabs : [] });
    }
    if (method === 'POST' && route === '/open') {
      const args = [cli, 'chat', 'open', '--no-open', '--root', root];
      if (url.searchParams.get('reopen') === '1') args.push('--reopen');
      execFile(process.execPath, args, { timeout: 15000 }, (err, stdout) => {
        try {
          const out = JSON.parse(stdout);
          return json(res, out.error ? 500 : 200, out);
        } catch {
          return json(res, 500, { error: err?.message ?? 'nos chat open failed' });
        }
      });
      return;
    }

    const port = serverPort(stateDir);
    if (method === 'GET' && route === '/events') {
      if (!port) return json(res, 503, { error: 'chat server not running' });
      return forward(res, port, 'GET', '/events-all');
    }
    if (method !== 'POST' || !['/messages', '/end', '/stop', '/title', '/new'].includes(route))
      return json(res, 404, { error: 'not found' });
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'body too large' });
    }
    if (!port) return json(res, 503, { error: 'chat server not running' });
    if (route === '/new') {
      let title = '';
      try {
        title = String(JSON.parse(body.toString() || '{}').title ?? '');
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      return forward(res, port, 'POST', '/api/sessions/new', Buffer.from(JSON.stringify({ dir: root, title })));
    }
    const tab = url.searchParams.get('key') ?? key;
    if (!/^[a-f0-9]{12}$/.test(tab)) return json(res, 400, { error: 'invalid key' });
    return forward(res, port, 'POST', `/api/session/${tab}${route}`, body.length ? body : Buffer.from('{}'));
    return json(res, 404, { error: 'not found' });
  };
}
