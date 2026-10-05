import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { request } from '../../src/chat/client.js';
import { allowed, hostOf } from '../../src/chat/guard.js';
import { createChatServer } from '../../src/chat/server.js';
import { createSessionStore } from '../../src/chat/sessions.js';
import { makeTempRoot } from '../helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('guard: foreign Host or Origin is refused, missing Origin and [::1] with port pass', () => {
  const req = (host, origin) => ({ headers: { host, ...(origin && { origin }) } });
  assert.equal(hostOf('[::1]:4611'), '[::1]');
  assert.equal(allowed(req('127.0.0.1:4611')), true);
  assert.equal(allowed(req('[::1]:4611')), true);
  assert.equal(allowed(req('localhost')), true);
  assert.equal(allowed(req('evil.example')), false);
  assert.equal(allowed(req('127.0.0.1:4611', 'http://evil.example')), false);
  assert.equal(allowed(req('127.0.0.1:4611', 'http://localhost:5180')), true);
  assert.equal(allowed(req('127.0.0.1:4611', 'null')), false);
});

async function start(t, opts = {}) {
  const dir = makeTempRoot(t);
  const store = createSessionStore({ file: path.join(dir, 'sessions.json') });
  const chat = createChatServer({ store, version: 'test', root: dir, sweepMs: 20, heartbeatMs: 50, ...opts });
  const port = await chat.listen(0);
  t.after(() => chat.stop());
  const call = (method, p, body) => request(port, method, p, body);
  const { body } = await call('POST', '/api/sessions', { dir });
  return { dir, store, chat, port, call, key: body.key };
}

// reads SSE events until `count` arrived
function events(port, key, count) {
  return new Promise((resolve, reject) => {
    const got = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/events/${key}` }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block);
          if (ev) got.push({ event: ev[1], data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
          if (got.length >= count) {
            req.destroy();
            resolve(got);
          }
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
}

test('health, 403 for a foreign host, 404 for unknown keys', async (t) => {
  const { port, call } = await start(t);
  assert.deepEqual((await call('GET', '/health')).body.app, 'nos-chat');
  const r = await new Promise((resolve) =>
    http.get({ host: '127.0.0.1', port, path: '/health', headers: { host: 'evil.example' } }, resolve),
  );
  assert.equal(r.statusCode, 403);
  assert.equal((await call('POST', '/api/session/abcdefabcdef/messages', { text: 'x' })).code, 404);
});

test('a parked await returns when a message is posted', async (t) => {
  const { call, key, chat } = await start(t);
  const parked = call('POST', '/api/await', { key });
  await sleep(50);
  assert.equal(chat.presenceFor(key), 'listening');
  const sent = await call('POST', `/api/session/${key}/messages`, { text: 'Run the tests' });
  assert.equal(sent.body.status, 'queued');
  const r = (await parked).body;
  assert.equal(r.status, 'messages');
  assert.equal(r.items[0].text, 'Run the tests');
  assert.equal(chat.presenceFor(key), 'thinking');
});

test('of two parked awaits, one gets the batch', async (t) => {
  const { call, key } = await start(t);
  const a = call('POST', '/api/await', { key, timeoutMs: 400 });
  const b = call('POST', '/api/await', { key, timeoutMs: 400 });
  await sleep(50);
  await call('POST', `/api/session/${key}/messages`, { text: 'hi' });
  const statuses = (await Promise.all([a, b])).map((r) => r.body.status).sort();
  assert.deepEqual(statuses, ['messages', 'waiting']);
});

test('await with timeoutMs 0 answers at once; thinking and typing expire', async (t) => {
  const { call, key, chat } = await start(t, { thinkingMs: 60, typingMs: 30 });
  assert.equal((await call('POST', '/api/await', { key, timeoutMs: 0 })).body.status, 'waiting');
  await call('POST', `/api/session/${key}/typing`, { state: 'typing' });
  assert.equal(chat.presenceFor(key), 'typing');
  await sleep(40);
  assert.equal(chat.presenceFor(key), 'waiting');
  await call('POST', `/api/session/${key}/typing`, { state: 'thinking' });
  assert.equal(chat.presenceFor(key), 'thinking');
  await sleep(80);
  assert.equal(chat.presenceFor(key), 'waiting');
  await call('POST', `/api/session/${key}/messages`, { text: 'x' });
  assert.equal(chat.presenceFor(key), 'queued');
});

test('a new event stream gets chat-sync then presence; a reply is pushed', async (t) => {
  const { port, call, key } = await start(t);
  const first = await events(port, key, 2);
  assert.deepEqual(first.map((e) => e.event), ['chat-sync', 'presence']);
  const later = events(port, key, 4);
  await sleep(50);
  await call('POST', `/api/session/${key}/reply`, { text: 'All 42 pass.' });
  const got = await later;
  const sync = got.filter((e) => e.event === 'chat-sync').pop();
  assert.equal(sync.data.chat.at(-1).role, 'agent');
});

test('shutdown answers parked awaits with waiting', async (t) => {
  const { call, key, chat } = await start(t);
  const parked = call('POST', '/api/await', { key });
  await sleep(50);
  await chat.stop();
  const r = (await parked).body;
  assert.equal(r.status, 'waiting');
  assert.match(r.note, /server stopping/);
});

test('a body over 1 MiB and text over 32,000 characters get 400; ended gets 409', async (t) => {
  const { call, key } = await start(t);
  assert.equal((await call('POST', `/api/session/${key}/messages`, { text: 'x'.repeat(1024 * 1024 + 10) }).catch(() => ({ code: 400 }))).code, 400);
  assert.equal((await call('POST', `/api/session/${key}/messages`, { text: 'x'.repeat(32001) })).code, 400);
  assert.equal((await call('POST', `/api/session/${key}/messages`, { text: '  ' })).code, 400);
  assert.deepEqual((await call('POST', `/api/session/${key}/end`)).body, { status: 'ended', endedBy: 'user' });
  assert.equal((await call('POST', `/api/session/${key}/messages`, { text: 'late' })).code, 409);
  assert.equal((await call('POST', '/api/sessions', { dir: (await call('GET', '/api/sessions')).body.sessions[0].dir })).code, 409);
});

test('the chat page escapes the boot JSON', async (t) => {
  const { port, call, key } = await start(t);
  await call('POST', `/api/session/${key}/messages`, { text: '</script><script>alert(1)</script>' });
  const html = await new Promise((resolve) =>
    http.get({ host: '127.0.0.1', port, path: `/chat/${key}` }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ b, csp: res.headers['content-security-policy'] }));
    }),
  );
  assert.ok(!html.b.includes('</script><script>alert'));
  assert.match(html.csp, /default-src 'self'/);
});

// ---- runner mode: the server answers with its own Claude Code session per tab ----

function fakeRunner() {
  const runs = [];
  return {
    runs,
    run(opts) {
      let resolve;
      const done = new Promise((r) => (resolve = r));
      const run = { opts, finish: (r) => resolve({ created: true, stopped: false, ...r }), stopped: false };
      runs.push(run);
      return {
        done,
        stop() {
          run.stopped = true;
          resolve({ created: true, stopped: true, text: null });
        },
      };
    },
  };
}

test('runner: a message starts a run, the result becomes the reply, the session is resumed next time', async (t) => {
  const runner = fakeRunner();
  const { call, key, chat, store } = await start(t, { runner });
  await call('POST', `/api/session/${key}/messages`, { text: '[context: specs/a.md]\nRun the tests' });
  assert.equal(runner.runs.length, 1);
  const first = runner.runs[0].opts;
  assert.equal(first.resume, false);
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(first.prompt, '[context: specs/a.md]\nRun the tests');
  assert.equal(store.get(key).title, 'Run the tests');
  assert.equal(chat.presenceFor(key), 'thinking');

  // sent while running: queued for the next run
  await call('POST', `/api/session/${key}/messages`, { text: 'and lint' });
  assert.equal(runner.runs.length, 1);
  first.onActivity('Bash: npm test');
  runner.runs[0].finish({ text: 'All 42 pass.' });
  await sleep(10);
  assert.equal(store.get(key).chat.find((m) => m.role === 'agent').text, 'All 42 pass.');
  assert.equal(runner.runs.length, 2);
  assert.equal(runner.runs[1].opts.resume, true);
  assert.equal(runner.runs[1].opts.sessionId, first.sessionId);
  assert.equal(runner.runs[1].opts.prompt, 'and lint');

  // stop
  const stop = await call('POST', `/api/session/${key}/stop`);
  assert.equal(stop.body.status, 'stopping');
  await sleep(10);
  assert.equal(store.get(key).chat.at(-1).text, '_Stopped._');
  assert.equal(chat.presenceFor(key), 'ready');
  // a terminal await must not take the messages
  assert.equal((await call('POST', '/api/await', { key, timeoutMs: 0 })).body.status, 'runner');
});

test('runner: tabs are their own sessions; errors show up as replies', async (t) => {
  const runner = fakeRunner();
  const { call, dir, key, store } = await start(t, { runner });
  const tab = (await call('POST', '/api/sessions/new', { dir, title: 'Review' })).body.key;
  assert.notEqual(tab, key);
  const tabs = (await call('GET', '/api/sessions')).body.tabs;
  assert.deepEqual(tabs.map((s) => s.title), ['New chat', 'Review']);
  await call('POST', `/api/session/${tab}/messages`, { text: 'go' });
  await call('POST', `/api/session/${key}/messages`, { text: 'go too' });
  assert.equal(runner.runs.length, 2);
  assert.notEqual(runner.runs[0].opts.sessionId, runner.runs[1].opts.sessionId);
  runner.runs[0].finish({ text: null, error: 'Claude Code ("claude") was not found on the host.' });
  await sleep(10);
  assert.match(store.get(tab).chat.at(-1).text, /^⚠ Claude Code/);
  // ending a tab stops its run
  await call('POST', `/api/session/${key}/end`);
  assert.equal(runner.runs[1].stopped, true);
});

test('project-wide stream: sessions, then a chat-sync per tab, events carry the key', async (t) => {
  const runner = fakeRunner();
  const { port, call, key } = await start(t, { runner });
  const got = await new Promise((resolve) => {
    const out = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/events-all' }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block);
          if (ev) out.push({ event: ev[1], data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
          if (out.some((e) => e.event === 'activity')) {
            req.destroy();
            resolve(out);
          }
        }
      });
    });
    req.on('error', () => {});
    setTimeout(async () => {
      await call('POST', `/api/session/${key}/messages`, { text: 'hi' });
      runner.runs[0].opts.onActivity('Read: README.md');
    }, 50);
  });
  assert.deepEqual(got.slice(0, 2).map((e) => e.event), ['sessions', 'chat-sync']);
  assert.equal(got[0].data.runner, true);
  const act = got.find((e) => e.event === 'activity');
  assert.deepEqual(act.data, { key, text: 'Read: README.md' });
});
