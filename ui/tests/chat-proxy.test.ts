// @vitest-environment node
// The dev server's access layer and chat routes against a real `nos chat` server in a temp project.
// Requests from "another device" come from 127.0.0.1 with a LAN Host header: not this machine.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { createAccess, DEVICE_COOKIE, isLocal, PENDING_COOKIE, type Access } from '../src/access';
import { keyOf, stateDirOf } from '../../cli/src/chat/paths.js';
import { chatHandler, startChatServer } from '../src/chat-proxy';
import { loadTls } from '../src/tls';

// tests run inside ui/, the CLI sits next to it
const CLI = resolve('../cli/bin/nos.js');
let root = '';
// the roots of the temp project as the dev server has them (main = the project, its specs root .specs)
const roots = () => ({ main: root, specs: join(root, '.specs') });
let state = '';
let access: Access;
let server: http.Server;
let port = 0;
let changes = 0;

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (access.handle(req, res)) return;
  if (req.url?.startsWith('/__chat/'))
    return void chatHandler(roots(), { cli: CLI, stateDir: state, access })(req, res);
  res.end(req.url === '/__specs' ? '{"specs":true}' : '<!doctype html>specs');
}

beforeAll(async () => {
  process.env.NOS_CHAT_PORT = '0';
  root = mkdtempSync(join(tmpdir(), 'nos-chat-ui-'));
  // set up like nos init leaves it: the chat needs nos.config.json, its state lives in .specs/.chat
  writeFileSync(join(root, 'nos.config.json'), JSON.stringify({ specs: { dir: '.specs', remote: null } }));
  mkdirSync(join(root, '.specs'));
  // relay mode: these tests never start Claude Code (runner mode is covered in cli/test/chat)
  writeFileSync(join(root, '.specs', 'config.json'), JSON.stringify({ chat: { runner: false } }));
  state = stateDirOf({ specs: join(root, '.specs') });
  access = createAccess({
    stateDir: state,
    onChange: () => changes++,
    link: () => ({ port, scheme: 'http' }),
  });
  server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  try {
    execFileSync(process.execPath, [CLI, 'chat', 'stop', '--root', root]);
  } catch {
    // not running
  }
  server.close();
  rmSync(root, { recursive: true, force: true });
});

type Out = { status: number; body: string; headers: http.IncomingHttpHeaders };
function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Out> {
  return new Promise((done, fail) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const host = headers.host ?? `localhost:${port}`;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host,
          ...(method === 'POST' && { origin: `http://${host}` }),
          ...(data && { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
      },
    );
    req.on('error', fail);
    req.end(data);
  });
}

const LAN = { host: '192.168.1.20:5180' };
const cookieFrom = (h: http.IncomingHttpHeaders, name: string) =>
  ([] as string[])
    .concat(h['set-cookie'] ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(name + '=') && c.length > name.length + 1) ?? '';
const codeOf = (url: string) => new URL(url).searchParams.get('pair')!;

// pairs a device: link → pending → approve on this machine → cookie
async function pairDevice() {
  const code = codeOf(access.newLink().urls[0]?.url ?? `http://x/?pair=${access.store.createCode().code}`);
  const opened = await call('GET', `/?pair=${code}`, LAN);
  const pending = cookieFrom(opened.headers, PENDING_COOKIE);
  const status = JSON.parse((await call('GET', '/__pair/status', { ...LAN, cookie: pending })).body);
  const id = pending.split('=')[1].split('.')[0];
  expect((await call('POST', `/__chat/devices/approve?id=${id}`)).status).toBe(200);
  const done = await call('GET', '/__pair/status', { ...LAN, cookie: pending });
  return {
    id,
    code,
    status,
    opened,
    done,
    cookie: cookieFrom(done.headers, DEVICE_COOKIE),
  };
}

test('this machine = loopback socket and loopback Host; a faked Host from the network is not', () => {
  const req = (remoteAddress: string, host: string) => ({ socket: { remoteAddress }, headers: { host } }) as never;
  expect(isLocal(req('192.168.1.5', 'localhost:5180'))).toBe(false);
  expect(isLocal(req('127.0.0.1', 'evil.example'))).toBe(false);
  expect(isLocal(req('::ffff:127.0.0.1', 'localhost:5180'))).toBe(true);
});

test('unpaired devices: pages lead to the pairing page, everything else is 401', async () => {
  const page = await call('GET', '/', { ...LAN, accept: 'text/html' });
  expect(page.status).toBe(302);
  expect(page.headers.location).toBe('/__pair');
  expect((await call('GET', '/__specs', LAN)).status).toBe(401);
  expect((await call('POST', '/__promote?domain=domain-1-x', LAN)).status).toBe(401);
  expect((await call('GET', '/__chat/state', LAN)).status).toBe(401);
  expect((await call('GET', '/__pair', LAN)).body).toContain('Pair this device');
  // this machine needs nothing
  expect((await call('GET', '/__specs')).body).toBe('{"specs":true}');
});

test('pairing: one-time code → waiting with a number → approved on this machine → own cookie', async () => {
  const before = changes;
  const p = await pairDevice();
  expect(p.opened.status).toBe(302);
  expect(p.opened.headers.location).toBe('/__pair');
  expect(String(p.opened.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
  expect(p.status).toMatchObject({
    status: 'pending',
    confirm: expect.stringMatching(/^\d{4}$/),
  });
  expect(JSON.parse(p.done.body)).toEqual({ status: 'paired' });
  expect(p.cookie).toMatch(new RegExp(`^${DEVICE_COOKIE}=${p.id}\\.`));
  expect(changes).toBeGreaterThan(before);

  // the same link a second time: refused
  expect((await call('GET', `/?pair=${p.code}`, LAN)).status).toBe(403);
  // the device now reaches the specs and the chat, but not the device admin
  expect((await call('GET', '/__specs', { ...LAN, cookie: p.cookie })).status).toBe(200);
  const st = await call('GET', '/__chat/state', { ...LAN, cookie: p.cookie });
  expect(JSON.parse(st.body)).toMatchObject({ local: false });
  expect((await call('GET', '/__chat/devices', { ...LAN, cookie: p.cookie })).status).toBe(403);
  expect(
    (
      await call('POST', `/__chat/devices/revoke?id=${p.id}`, {
        ...LAN,
        cookie: p.cookie,
      })
    ).status,
  ).toBe(403);

  // revoked on this machine: out at once
  expect((await call('POST', `/__chat/devices/revoke?id=${p.id}`)).status).toBe(200);
  expect((await call('GET', '/__specs', { ...LAN, cookie: p.cookie })).status).toBe(401);
});

test('a pending device cannot do anything; only this machine approves; deny drops it', async () => {
  const code = access.store.createCode().code;
  const opened = await call('GET', `/?pair=${code}`, LAN);
  const pending = cookieFrom(opened.headers, PENDING_COOKIE);
  const id = pending.split('=')[1].split('.')[0];
  expect((await call('GET', '/__specs', { ...LAN, cookie: pending })).status).toBe(401);
  expect(
    (
      await call('POST', `/__chat/devices/approve?id=${id}`, {
        ...LAN,
        cookie: pending,
      })
    ).status,
  ).toBe(401);
  const list = JSON.parse((await call('GET', '/__chat/devices')).body).devices;
  expect(list.find((d: { id: string }) => d.id === id)).toMatchObject({
    status: 'pending',
    approved: false,
  });
  expect((await call('POST', `/__chat/devices/deny?id=${id}`)).status).toBe(200);
  expect(JSON.parse((await call('GET', '/__pair/status', { ...LAN, cookie: pending })).body)).toEqual({
    status: 'gone',
  });
  // admin calls from another site are refused even on this machine
  expect(
    (
      await call('POST', `/__chat/devices/pair`, {
        origin: 'http://evil.example',
      })
    ).status,
  ).toBe(403);
});

test('chat: open starts the project chat server; messages go through and into the audit log', async () => {
  const opened = await call('POST', '/__chat/open');
  expect(opened.status).toBe(200);
  expect(JSON.parse(opened.body)).toMatchObject({
    status: 'open',
    key: keyOf(root),
  });
  expect(readFileSync(join(state, '.gitignore'), 'utf8')).toBe('*\n');
  // the chat's state lives in the specs root; a handler built from the roots alone finds the server there
  expect(state).toBe(join(root, '.specs', '.chat'));
  const own = await new Promise<{ code: number; body: string }>((done) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body = '') {
        done({ code: res.statusCode, body });
      },
    };
    const req = {
      url: '/__chat/state',
      method: 'GET',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    void chatHandler(roots(), { cli: CLI })(req as never, res as never);
  });
  expect(own.code).toBe(200);
  expect(JSON.parse(own.body)).toMatchObject({ key: keyOf(root), server: true });

  const p = await pairDevice();
  const sent = await call('POST', '/__chat/messages', { ...LAN, cookie: p.cookie }, { text: 'hello from the couch' });
  expect(sent.status).toBe(200);
  expect(JSON.parse(sent.body)).toMatchObject({ status: 'queued' });
  const log = readFileSync(join(state, 'audit.log'), 'utf8');
  expect(log).toMatch(new RegExp(`\\t${p.id}\\tmessage\\t${keyOf(root)}\\thello from the couch`));

  // a second tab, addressed by ?key=
  const tab = JSON.parse((await call('POST', '/__chat/new', {}, { title: 'Review' })).body).key;
  expect((await call('POST', `/__chat/messages?key=${tab}`, {}, { text: 'in tab two' })).status).toBe(200);
  expect((await call('POST', '/__chat/messages?key=../../x', {}, { text: 'x' })).status).toBe(400);
  expect((await call('POST', '/__chat/reply', {}, { text: 'x' })).status).toBe(404);
  expect((await call('POST', '/__chat/open', { origin: 'http://evil.example' })).status).toBe(403);

  // the device's event stream is cut the moment it is revoked
  const closed = new Promise<string>((done) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/__chat/events',
        headers: { ...LAN, cookie: p.cookie },
      },
      (res) => {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        res.once('data', () => void call('POST', `/__chat/devices/revoke?id=${p.id}`));
        res.on('close', () => done('closed'));
        res.on('error', () => done('closed'));
      },
    );
    req.on('error', () => done('closed'));
  });
  expect(await closed).toBe('closed');
});

test('chat: opening the details view of a tab is in the audit log, with the subagent', async () => {
  const key = keyOf(root);
  const stream = (path: string) =>
    new Promise<number>((done) => {
      const req = http.get({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}` } }, (res) => {
        res.destroy();
        done(res.statusCode ?? 0);
      });
      req.on('error', () => done(0));
    });
  expect(await stream(`/__chat/transcript-events?key=${key}`)).toBe(200);
  expect(await stream(`/__chat/transcript-events?key=${key}&agent=a1b2c3`)).toBe(200);
  expect(await stream(`/__chat/transcript-events?key=${key}&agent=../x`)).toBe(400);
  const log = readFileSync(join(state, 'audit.log'), 'utf8');
  expect(log).toMatch(new RegExp(`\tlocal\tdetails\t${key}\t?\n`));
  expect(log).toMatch(new RegExp(`\tlocal\tdetails\t${key}\tagent a1b2c3`));
  expect(log).not.toMatch(/details	.*\.\.\/x/);
});

test('dev server start: a running chat server of this version is kept with its tabs, never restarted', async () => {
  const pid = () => JSON.parse(readFileSync(join(state, 'server.json'), 'utf8')).pid;
  const first = await startChatServer(root, CLI);
  const before = pid();
  const again = await startChatServer(root, CLI);
  expect(again).toStrictEqual({ server: first.server, status: 'running' });
  expect(pid()).toBe(before);
  expect(JSON.parse((await call('GET', '/__chat/state')).body)).toMatchObject({ key: keyOf(root), server: true });
});

test('https: the certificate is made once and reused; cookies are Secure', { timeout: 60000 }, async () => {
  const tls = await loadTls(state, ['192.168.1.20'], 'test-host');
  const again = await loadTls(state, ['192.168.1.20'], 'test-host');
  expect(again.fingerprint).toBe(tls.fingerprint);
  expect(tls.fingerprint).toMatch(/^([0-9A-F]{2}:){7}[0-9A-F]{2}$/);
  const other = await loadTls(state, ['10.0.0.9'], 'test-host');
  expect(other.fingerprint).not.toBe(tls.fingerprint);

  const secure = https.createServer({ key: other.key, cert: other.cert }, handler);
  await new Promise<void>((r) => secure.listen(0, '127.0.0.1', r));
  const sport = (secure.address() as { port: number }).port;
  const code = access.store.createCode().code;
  const res = await new Promise<http.IncomingMessage>((done, fail) =>
    https
      .get(
        {
          host: '127.0.0.1',
          port: sport,
          path: `/?pair=${code}`,
          headers: LAN,
          rejectUnauthorized: false,
        },
        done,
      )
      .on('error', fail),
  );
  res.resume();
  secure.close();
  expect(String(res.headers['set-cookie'])).toMatch(/; Secure/);
});

// vite serves HTTPS as HTTP/2 (with HTTP/1 fallback): the host arrives as ":authority"
test('over HTTP/2 this machine is still this machine, and same-origin POSTs pass', { timeout: 60000 }, async () => {
  const tls = await loadTls(state, ['10.0.0.9'], 'test-host');
  const h2 = http2.createSecureServer({ key: tls.key, cert: tls.cert, allowHTTP1: true }, handler as never);
  await new Promise<void>((r) => h2.listen(0, '127.0.0.1', r));
  const p2 = (h2.address() as { port: number }).port;
  const client = http2.connect(`https://localhost:${p2}`, { rejectUnauthorized: false });
  const ask = (headers: Record<string, string>) =>
    new Promise<number>((done, fail) => {
      const r = client.request(headers);
      r.on('response', (h) => done(Number(h[':status'])));
      r.on('error', fail);
      r.resume();
      r.end();
    });
  try {
    expect(await ask({ ':path': '/__chat/devices' })).toBe(200);
    expect(await ask({ ':path': '/__specs' })).toBe(200);
    expect(
      await ask({ ':method': 'POST', ':path': '/__chat/devices/approve?id=nope', origin: `https://localhost:${p2}` }),
    ).toBe(404);
    expect(
      await ask({ ':method': 'POST', ':path': '/__chat/devices/approve?id=nope', origin: 'https://evil.example' }),
    ).toBe(403);
  } finally {
    client.close();
    h2.close();
  }
});
