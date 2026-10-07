import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(
    first.map((e) => e.event),
    ['chat-sync', 'presence'],
  );
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
  assert.equal(
    (
      await call('POST', `/api/session/${key}/messages`, { text: 'x'.repeat(1024 * 1024 + 10) }).catch(() => ({
        code: 400,
      }))
    ).code,
    400,
  );
  assert.equal((await call('POST', `/api/session/${key}/messages`, { text: 'x'.repeat(32001) })).code, 400);
  assert.equal((await call('POST', `/api/session/${key}/messages`, { text: '  ' })).code, 400);
  assert.deepEqual((await call('POST', `/api/session/${key}/end`)).body, { status: 'ended', endedBy: 'user' });
  assert.equal((await call('POST', `/api/session/${key}/messages`, { text: 'late' })).code, 409);
  assert.equal(
    (await call('POST', '/api/sessions', { dir: (await call('GET', '/api/sessions')).body.sessions[0].dir })).code,
    409,
  );
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

// a tab's Claude Code process the test drives through the callbacks it got
function fakeRunner() {
  const procs = [];
  return {
    procs,
    open(opts) {
      const p = {
        opts,
        sent: [],
        busy: false,
        agentsRunning: false,
        lastUse: Date.now(),
        stopped: false,
        closed: false,
        turn(...texts) {
          opts.onStarted();
          for (const t of texts) opts.onText(t);
          p.busy = false;
          opts.onBusy(false);
        },
        exit(r = {}) {
          p.busy = false;
          opts.onExit({ stopped: p.stopped, error: null, ...r });
        },
      };
      Object.assign(p, {
        send(text) {
          p.sent.push(text);
          p.lastUse = Date.now();
          if (!p.busy) {
            p.busy = true;
            opts.onBusy(true);
          }
          return true;
        },
        close() {
          p.closed = true;
        },
        stop() {
          p.stopped = true;
          setImmediate(() => p.exit());
        },
      });
      procs.push(p);
      return p;
    },
  };
}

test('runner: one process per tab, messages go in at once (also mid-turn), replies show as they come', async (t) => {
  const runner = fakeRunner();
  const { call, key, chat, store } = await start(t, { runner });
  await call('POST', `/api/session/${key}/messages`, { text: '[context: specs/a.md]\nRun the tests' });
  assert.equal(runner.procs.length, 1);
  const proc = runner.procs[0];
  assert.equal(proc.opts.resume, false);
  assert.match(proc.opts.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(proc.sent, ['[context: specs/a.md]\nRun the tests']);
  assert.equal(store.get(key).title, 'Run the tests');
  assert.equal(chat.presenceFor(key), 'thinking');

  // a reply before the turn ends shows at once
  proc.opts.onStarted();
  assert.equal(store.get(key).claudeStarted, true);
  proc.opts.onText('Running them.');
  assert.equal(store.get(key).chat.at(-1).text, 'Running them.');
  // sent mid-turn: straight into the same process
  await call('POST', `/api/session/${key}/messages`, { text: 'and lint' });
  assert.deepEqual(proc.sent.at(-1), 'and lint');
  assert.equal(runner.procs.length, 1);
  assert.equal(store.get(key).pending.length, 0);

  proc.opts.onActivity('Bash: npm test');
  proc.opts.onAgents([{ id: 'toolu_1', type: 'Explore', status: 'running' }]);
  proc.agentsRunning = true;
  const tabs = async () => (await call('GET', '/api/sessions')).body.tabs;
  assert.deepEqual((await tabs())[0].agents, [{ id: 'toolu_1', type: 'Explore', status: 'running' }]);
  proc.turn('All 42 pass.');
  assert.equal(store.get(key).chat.at(-1).text, 'All 42 pass.');
  // the turn is over, the subagent still works: ready to type, the tab still counts as running
  assert.equal(chat.presenceFor(key), 'ready');
  assert.equal((await tabs())[0].running, true);

  // stop: the process ends, its subagents with it
  const stop = await call('POST', `/api/session/${key}/stop`);
  assert.equal(stop.body.status, 'stopping');
  await sleep(10);
  assert.equal(proc.stopped, true);
  assert.equal(store.get(key).chat.at(-1).text, '_Stopped._');
  assert.equal(chat.presenceFor(key), 'ready');
  // the next message opens a new process that resumes the session
  await call('POST', `/api/session/${key}/messages`, { text: 'again' });
  assert.equal(runner.procs.length, 2);
  assert.equal(runner.procs[1].opts.resume, true);
  assert.equal(runner.procs[1].opts.sessionId, proc.opts.sessionId);
  // a terminal await must not take the messages
  assert.equal((await call('POST', '/api/await', { key, timeoutMs: 0 })).body.status, 'runner');
});

test('runner: a process with nothing to do closes after procIdleMs, not while a subagent works', async (t) => {
  const runner = fakeRunner();
  const { call, key } = await start(t, { runner, procIdleMs: 30 });
  await call('POST', `/api/session/${key}/messages`, { text: 'go' });
  const proc = runner.procs[0];
  proc.agentsRunning = true;
  proc.turn('Started.');
  proc.lastUse = 0;
  await sleep(80);
  assert.equal(proc.closed, false);
  proc.agentsRunning = false;
  await sleep(80);
  assert.equal(proc.closed, true);
  proc.exit();
  await sleep(10);
  await call('POST', `/api/session/${key}/messages`, { text: 'later' });
  assert.equal(runner.procs.length, 2);
});

test('runner: tabs are their own sessions; errors show up as replies', async (t) => {
  const runner = fakeRunner();
  const { call, dir, key, store } = await start(t, { runner });
  const tab = (await call('POST', '/api/sessions/new', { dir, title: 'Review' })).body.key;
  assert.notEqual(tab, key);
  const tabs = (await call('GET', '/api/sessions')).body.tabs;
  assert.deepEqual(
    tabs.map((s) => s.title),
    ['New chat', 'Review'],
  );
  await call('POST', `/api/session/${tab}/messages`, { text: 'go' });
  await call('POST', `/api/session/${key}/messages`, { text: 'go too' });
  assert.equal(runner.procs.length, 2);
  assert.notEqual(runner.procs[0].opts.sessionId, runner.procs[1].opts.sessionId);
  runner.procs[0].opts.onError('auto mode unavailable');
  assert.equal(store.get(tab).chat.at(-1).text, '⚠ auto mode unavailable');
  runner.procs[0].exit({ error: 'Claude Code ("claude") was not found on the host.' });
  await sleep(10);
  assert.match(store.get(tab).chat.at(-1).text, /^⚠ Claude Code/);
  // ending a tab stops its process
  await call('POST', `/api/session/${key}/end`);
  assert.equal(runner.procs[1].stopped, true);
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
      runner.procs[0].opts.onActivity('Read: README.md');
    }, 50);
  });
  assert.deepEqual(
    got.slice(0, 2).map((e) => e.event),
    ['sessions', 'chat-sync'],
  );
  assert.equal(got[0].data.runner, true);
  const act = got.find((e) => e.event === 'activity');
  assert.deepEqual(act.data, { key, text: 'Read: README.md' });
});

// ---- details view: the transcript of a tab, pushed ----

function sse(port, p, until) {
  return new Promise((resolve) => {
    const got = [];
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      if (res.statusCode !== 200) return resolve({ status: res.statusCode, got });
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block);
          if (ev) got.push({ event: ev[1], data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
          if (until(got)) {
            req.destroy();
            resolve({ status: 200, got });
          }
        }
      });
    });
    req.on('error', () => {});
  });
}

test('transcript-events: the tab session steps, then appended ones; a subagent by id; bad params 400', async (t) => {
  const home = makeTempRoot(t);
  const { port, key, store, dir } = await start(t, { claudeEnv: { CLAUDE_CONFIG_DIR: home } });
  const sid = '76275042-a4c6-49b2-847a-44d65cf907b9';
  const folder = path.join(home, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(path.join(folder, sid, 'subagents'), { recursive: true });
  const line = (j) => JSON.stringify(j) + '\n';
  writeFileSync(path.join(folder, `${sid}.jsonl`), line({ type: 'user', uuid: 'u1', message: { content: 'hi' } }));
  writeFileSync(
    path.join(folder, sid, 'subagents', 'agent-a796.jsonl'),
    line({ type: 'user', uuid: 's1', isSidechain: true, message: { content: 'Do the step' } }),
  );

  // no Claude Code session yet: an empty list
  const empty = await sse(port, `/transcript-events?key=${key}`, (g) => g.length >= 1);
  assert.deepEqual(empty.got[0].data, { items: [], initial: true, truncated: false });

  store.update(key, { claudeSession: sid });
  const main = sse(port, `/transcript-events?key=${key}`, (g) => g.length >= 2);
  setTimeout(
    () =>
      appendFileSync(
        path.join(folder, `${sid}.jsonl`),
        line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hello' }] } }),
      ),
    100,
  );
  const { got } = await main;
  assert.deepEqual(
    got[0].data.items.map((i) => i.text),
    ['hi'],
  );
  assert.equal(got[0].data.initial, true);
  assert.deepEqual(
    got[1].data.items.map((i) => [i.kind, i.text]),
    [['text', 'hello']],
  );

  const sub = await sse(port, `/transcript-events?key=${key}&agent=a796`, (g) => g.length >= 1);
  assert.deepEqual(
    sub.got[0].data.items.map((i) => [i.label, i.text]),
    [['Task', 'Do the step']],
  );
  assert.equal((await sse(port, `/transcript-events?key=${key}&agent=../x`, () => true)).status, 400);
  assert.equal((await sse(port, `/transcript-events?key=nope`, () => true)).status, 400);
});

test('transcript-events: a transcript Claude Code moves to the worktree folder (EnterWorktree) is followed on the same stream', async (t) => {
  const home = makeTempRoot(t);
  const { port, key, store, dir } = await start(t, { claudeEnv: { CLAUDE_CONFIG_DIR: home } });
  const sid = '76275042-a4c6-49b2-847a-44d65cf907b9';
  const folder = path.join(home, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  const wt = path.join(home, 'projects', `${dir}/.claude/worktrees/quick-68`.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  mkdirSync(wt, { recursive: true });
  const line = (j) => JSON.stringify(j) + '\n';
  writeFileSync(path.join(folder, `${sid}.jsonl`), line({ type: 'user', uuid: 'u1', message: { content: 'hi' } }));
  store.update(key, { claudeSession: sid });

  const stream = sse(port, `/transcript-events?key=${key}`, (g) => g.length >= 2);
  setTimeout(() => {
    renameSync(path.join(folder, `${sid}.jsonl`), path.join(wt, `${sid}.jsonl`));
    appendFileSync(
      path.join(wt, `${sid}.jsonl`),
      line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'in the worktree' }] } }),
    );
  }, 100);
  const { got } = await stream;
  assert.deepEqual(
    got.map((g) => [g.data.initial, g.data.items.map((i) => i.text)]),
    [
      [true, ['hi']],
      [true, ['hi', 'in the worktree']],
    ],
  );
});

test('runner: a nos run of a tab (onRun) is stored, shown in the tabs, the session and a sessions event', async (t) => {
  const runner = fakeRunner();
  const { port, call, key, store } = await start(t, { runner });
  await call('POST', `/api/session/${key}/messages`, { text: 'start quick step 7' });
  assert.equal((await call('GET', `/api/session/${key}`)).body.run, null);
  assert.equal((await call('GET', '/api/sessions')).body.tabs[0].run, null);
  // the fields of the run file
  const run = {
    kind: 'quick',
    id: 7,
    domain: 'domain-3-x',
    branch: 'quick-7',
    worktree: 'D:/p/.claude/worktrees/quick-7',
  };
  const pushed = sse(port, '/events-all', (got) => got.some((e) => e.event === 'sessions' && e.data.sessions[0]?.run));
  await sleep(30);
  runner.procs[0].opts.onRun(run);
  const { got } = await pushed;
  assert.deepEqual(got.findLast((e) => e.event === 'sessions').data.sessions[0].run, run);
  assert.deepEqual(store.get(key).run, run);
  assert.deepEqual((await call('GET', `/api/session/${key}`)).body.run, run);
  assert.deepEqual((await call('GET', '/api/sessions')).body.tabs[0].run, run);
  assert.deepEqual((await call('GET', '/api/sessions')).body.sessions[0].run, run);
  // cleanup or abandon: the run is gone
  runner.procs[0].opts.onRun(null);
  assert.equal(store.get(key).run, null);
  assert.equal((await call('GET', `/api/session/${key}`)).body.run, null);
});
