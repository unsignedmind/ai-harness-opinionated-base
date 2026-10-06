// Dev server side of the chat (src/chat.ts): the spec-ui reaches the project's chat server
// (`nos chat`, 127.0.0.1 only) through these same-origin routes, so EventSource and fetch need no
// CORS and the chat server never faces the network. Only the user's side of the API is passed on.
// Tabs are the chat sessions of this project; `?key=` picks one (default: the project's first):
//   GET  /__chat/state         { key, server, runner, tabs }
//   POST /__chat/open          runs `nos chat open --no-open` (?reopen=1 after the user ended it)
//   POST /__chat/new           { title? } a new tab, its own Claude Code session
//   GET  /__chat/events        project-wide event stream (sessions, chat-sync, presence, activity, ended)
//   GET  /__chat/transcript-events  the steps of a tab (?key=) or its subagent (&agent= or &tool=), pushed
//   POST /__chat/messages      { text }  ?key=
//   POST /__chat/end           close a tab  ?key=
//   POST /__chat/stop          stop the running Claude Code run of a tab  ?key=
//   POST /__chat/title         { title } rename a tab  ?key=
//   GET  /__chat/devices       paired devices (this machine only, src/access.ts), POST …/devices/pair|approve|
//                              deny|revoke|rename ?id=
// Who may call: this machine, or a paired device (src/access.ts gates every request before this).
// Mutating calls must come from the page itself (Origin host == Host). Chat actions and details
// views go to the audit log (<specs>/.chat/audit.log) with the device that did them.
// The project is the main checkout (roots.main): the chat state dir and the session keys come from
// cli/src/chat/paths.js, so the CLI, the chat server and this proxy agree on them.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { audit } from '../../cli/src/chat/devices.js';
import { keyOf, stateDirOf } from '../../cli/src/chat/paths.js';
import type { Roots } from '../../cli/src/roots.js';
import { createAccess, sameOrigin, type Access } from './access.ts';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

const MAX_BODY = 1024 * 1024;

// the nos CLI next to the viewer (from the file path: under jsdom new URL(…, import.meta.url) is jsdom's URL)
export const nosCli = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'bin', 'nos.js');

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
        ...(body && {
          'content-type': 'application/json',
          'content-length': String(body.length),
        }),
      },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, {
        'Content-Type': r.headers['content-type'] ?? 'application/json',
        'Cache-Control': 'no-store',
        ...(r.headers['content-type']?.startsWith('text/event-stream') && {
          'X-Accel-Buffering': 'no',
        }),
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

// `nos chat restart`: the chat server of the project (main), fresh (its running Claude Code runs stop).
// Resolves with the server address, or rejects with why it did not start.
export function restartChatServer(main: string, cli = nosCli()): Promise<string> {
  return new Promise((done, fail) =>
    execFile(process.execPath, [cli, 'chat', 'restart', '--root', main], { timeout: 20000 }, (err, stdout) => {
      try {
        const out = JSON.parse(stdout);
        if (out.server) return done(String(out.server));
        fail(new Error(out.error ?? 'nos chat restart failed'));
      } catch {
        fail(new Error(err?.message ?? 'nos chat restart failed'));
      }
    }),
  );
}

export type ChatHandlerOptions = {
  cli?: string;
  stateDir?: string;
  access?: Access;
};

export function chatHandler(roots: Pick<Roots, 'main' | 'specs'>, opts: ChatHandlerOptions = {}) {
  const root = roots.main;
  const stateDir = opts.stateDir ?? stateDirOf(roots);
  const cli = opts.cli ?? nosCli();
  const access = opts.access ?? createAccess({ stateDir });
  const key = keyOf(root);

  return async (req: Req, res: Res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = url.pathname.replace(/^\/__chat/, '');
    const method = req.method ?? 'GET';
    const who = access.who(req);
    if (!who) return json(res, 401, { error: 'unpaired' });
    if (route === '/devices' || route.startsWith('/devices/'))
      return access.admin(req, res, route, async () => JSON.parse((await readBody(req)).toString() || '{}'));
    if (method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
    const note = (action: string, tab = '', detail = '') =>
      audit(stateDir, { device: access.actor(who), action, key: tab, detail });

    if (method === 'GET' && route === '/state') {
      const port = serverPort(stateDir);
      const r = port ? await get(port, '/api/sessions') : null;
      const body = (r?.code === 200 ? r.body : null) as {
        tabs?: unknown[];
        runner?: boolean;
      } | null;
      // a chat server of an older nos has no tabs: counts as not running, `nos chat open` replaces it
      const live = !!body && Array.isArray(body.tabs);
      return json(res, 200, {
        key,
        server: live,
        runner: live && !!body.runner,
        tabs: live ? body.tabs : [],
        local: who.kind === 'local',
      });
    }
    if (method === 'POST' && route === '/open') {
      note('open');
      const args = [cli, 'chat', 'open', '--no-open', '--root', root];
      if (url.searchParams.get('reopen') === '1') args.push('--reopen');
      execFile(process.execPath, args, { timeout: 15000 }, (err, stdout) => {
        try {
          const out = JSON.parse(stdout);
          return json(res, out.error ? 500 : 200, out);
        } catch {
          return json(res, 500, {
            error: err?.message ?? 'nos chat open failed',
          });
        }
      });
      return;
    }

    const port = serverPort(stateDir);
    if (method === 'GET' && route === '/events') {
      if (!port) return json(res, 503, { error: 'chat server not running' });
      access.track(who, res);
      return forward(res, port, 'GET', '/events-all');
    }
    // details view: the steps of a tab's session or of one of its subagents, pushed
    if (method === 'GET' && route === '/transcript-events') {
      const tab = url.searchParams.get('key') ?? key;
      const agent = url.searchParams.get('agent');
      const tool = url.searchParams.get('tool');
      if (!/^[a-f0-9]{12}$/.test(tab) || (agent && !/^\w+$/.test(agent)) || (tool && !/^[\w-]+$/.test(tool)))
        return json(res, 400, { error: 'invalid key, agent or tool' });
      if (!port) return json(res, 503, { error: 'chat server not running' });
      const q = new URLSearchParams({ key: tab, ...(agent && { agent }), ...(tool && { tool }) });
      // reading a session's steps shows everything Claude read: logged like the writes
      note('details', tab, agent ? `agent ${agent}` : tool ? `tool ${tool}` : '');
      access.track(who, res);
      return forward(res, port, 'GET', `/transcript-events?${q}`);
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
      note('new-tab', '', title);
      return forward(res, port, 'POST', '/api/sessions/new', Buffer.from(JSON.stringify({ dir: root, title })));
    }
    const tab = url.searchParams.get('key') ?? key;
    if (!/^[a-f0-9]{12}$/.test(tab)) return json(res, 400, { error: 'invalid key' });
    let detail = '';
    try {
      const b = JSON.parse(body.toString() || '{}');
      detail = String(b.text ?? b.title ?? '');
    } catch {
      // the chat server answers bad bodies
    }
    note(
      {
        '/messages': 'message',
        '/end': 'close-tab',
        '/stop': 'stop',
        '/title': 'rename',
      }[route] ?? route,
      tab,
      detail,
    );
    return forward(res, port, 'POST', `/api/session/${tab}${route}`, body.length ? body : Buffer.from('{}'));
  };
}
