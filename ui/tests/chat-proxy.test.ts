// @vitest-environment node
// The dev server's chat routes against a real `nos chat` server in a temp project.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { authorized, chatHandler, COOKIE, keyOf, pairHandler, stateDirOf } from '../src/chat-proxy';

// tests run inside ui/, the CLI sits next to it
const CLI = resolve('../cli/bin/nos.js');
let root = '';
let state = '';
let server: http.Server;
let port = 0;

beforeAll(async () => {
  process.env.NOS_CHAT_PORT = '0';
  root = mkdtempSync(join(tmpdir(), 'nos-chat-ui-'));
  mkdirSync(join(root, 'specs'));
  // relay mode: these tests never start Claude Code (runner mode is covered in cli/test/chat)
  writeFileSync(join(root, 'specs', 'config.json'), JSON.stringify({ chat: { runner: false } }));
  state = stateDirOf(root);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'token'), 'a'.repeat(64) + '\n');
  const chat = chatHandler(root, { cli: CLI });
  const pair = pairHandler(state);
  server = http.createServer((req, res) => {
    if (pair(req, res)) return;
    void chat(req, res);
  });
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
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `localhost:${port}`,
          ...(method === 'POST' && { origin: `http://localhost:${port}` }),
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

test('a faked loopback Host from the network is not local: the socket address counts too', () => {
  const req = (remoteAddress: string, host: string) => ({ socket: { remoteAddress }, headers: { host } }) as never;
  expect(authorized(req('192.168.1.5', 'localhost:5180'), state)).toBe(false);
  expect(authorized(req('127.0.0.1', 'evil.example'), state)).toBe(false);
  expect(authorized(req('::ffff:127.0.0.1', 'localhost:5180'), state)).toBe(true);
});

test('the key matches the CLI: sha256 of the project root', () => {
  expect(keyOf(root)).toMatch(/^[a-f0-9]{12}$/);
});

test('state before the chat is started: no server, no session', async () => {
  const r = await call('GET', '/__chat/state');
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body)).toEqual({ key: keyOf(root), server: false, runner: false, tabs: [] });
  expect((await call('POST', '/__chat/messages', {}, { text: 'x' })).status).toBe(503);
});

test('another device needs the pairing cookie; a cross-origin POST is refused', async () => {
  expect((await call('GET', '/__chat/state', LAN)).status).toBe(401);
  // POSTs only from the page itself (Origin host == Host)
  expect((await call('POST', '/__chat/open', { origin: 'http://evil.example' })).status).toBe(403);
  expect((await call('POST', '/__chat/open', { origin: '' })).status).toBe(403);

  const bad = await call('GET', '/?pair=' + 'b'.repeat(64), LAN);
  expect(bad.status).toBe(403);
  const ok = await call('GET', '/?pair=' + 'a'.repeat(64), LAN);
  expect(ok.status).toBe(302);
  expect(ok.headers.location).toBe('/');
  const cookie = String(ok.headers['set-cookie']).split(';')[0];
  expect(cookie).toBe(`${COOKIE}=${'a'.repeat(64)}`);
  expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
  expect((await call('GET', '/__chat/state', { ...LAN, cookie })).status).toBe(200);
});

test('open starts the project chat server; messages go through, the event stream is passed on', async () => {
  const opened = await call('POST', '/__chat/open');
  expect(opened.status).toBe(200);
  expect(JSON.parse(opened.body)).toMatchObject({ status: 'open', key: keyOf(root) });
  expect(readFileSync(join(state, '.gitignore'), 'utf8')).toBe('*\n');

  const sent = await call('POST', '/__chat/messages', {}, { text: 'hello from the couch' });
  expect(sent.status).toBe(200);
  expect(JSON.parse(sent.body)).toMatchObject({ status: 'queued', presence: 'queued' });

  const st = JSON.parse((await call('GET', '/__chat/state')).body);
  expect(st.server).toBe(true);
  expect(st.tabs.map((t: { key: string }) => t.key)).toEqual([keyOf(root)]);

  // a second tab, addressed by ?key=
  const tab = JSON.parse((await call('POST', '/__chat/new', {}, { title: 'Review' })).body).key;
  expect(tab).toMatch(/^[a-f0-9]{12}$/);
  expect((await call('POST', `/__chat/messages?key=${tab}`, {}, { text: 'in tab two' })).status).toBe(200);
  expect(JSON.parse((await call('POST', `/__chat/stop?key=${tab}`)).body).status).toBe('idle');
  expect((await call('POST', '/__chat/messages?key=../../x', {}, { text: 'x' })).status).toBe(400);
  const tabs = JSON.parse((await call('GET', '/__chat/state')).body).tabs;
  // relay mode names no tab by its first message (the runner does)
  expect(tabs.map((t: { title: string }) => t.title)).toEqual(['New chat', 'Review']);

  const first = await new Promise<string>((done) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__chat/events', headers: { host: 'localhost' } }, (res) => {
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      res.once('data', (c) => {
        done(String(c));
        req.destroy();
      });
    });
  });
  expect(first).toContain('event: sessions');

  // only the user's side of the API: no reply, no await through the dev server
  expect((await call('POST', '/__chat/reply', {}, { text: 'x' })).status).toBe(404);
  expect((await call('POST', '/__chat/end')).status).toBe(200);
  const reopened = JSON.parse((await call('POST', '/__chat/open')).body);
  expect(reopened.status).toBe('user-ended');
  expect(JSON.parse((await call('POST', '/__chat/open?reopen=1')).body).status).toBe('open');
});
