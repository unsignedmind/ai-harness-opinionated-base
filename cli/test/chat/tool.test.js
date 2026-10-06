// End-to-end: the real `nos chat` commands against a detached server on a free port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { request } from '../../src/chat/client.js';
import { runChat } from '../../src/chat/commands.js';
import { runHook } from '../../src/chat/hook.js';
import { files, keyOf } from '../../src/chat/paths.js';
import { saveState } from '../../src/chat/sessions.js';
import { makeTempRoot } from '../helpers.js';

const ENV = { ...process.env, NOS_CHAT_PORT: '0', NOS_CHAT_IDLE_MS: '20000' };

function project(t) {
  const root = makeTempRoot(t);
  mkdirSync(path.join(root, 'specs'));
  // relay mode: these tests answer the chat themselves, no Claude Code is started
  writeFileSync(path.join(root, 'specs', 'config.json'), JSON.stringify({ chat: { runner: false } }));
  return root;
}

async function nos(args, { cwd, stdin = '' }) {
  let out = '';
  const code = await runChat(args, {
    cwd,
    env: ENV,
    stdout: { write: (s) => (out += s) },
    stderr: { write: () => {} },
    readStdin: async () => stdin,
    launch: () => true,
  });
  return { code, json: JSON.parse(out) };
}

test('open, await, message, reply, pending, end, stop', async (t) => {
  const root = project(t);
  const sub = path.join(root, 'nested');
  mkdirSync(sub);
  t.after(() => nos(['stop'], { cwd: root }));

  assert.equal((await nos(['await', '--timeout-ms', '10'], { cwd: root })).json.status, 'no-server');

  const open = await nos(['open', '--no-open'], { cwd: sub });
  assert.equal(open.code, 0);
  assert.equal(open.json.status, 'open');
  assert.equal(open.json.key, keyOf(root));
  assert.ok(existsSync(path.join(root, 'specs', '.chat', '.gitignore')));
  const port = JSON.parse(readFileSync(files(path.join(root, 'specs', '.chat')).server, 'utf8')).port;

  const waiting = await nos(['await', '--timeout-ms', '200'], { cwd: root });
  assert.equal(waiting.json.status, 'waiting');
  assert.match(waiting.json.next_step, /nos chat await/);

  await request(port, 'POST', `/api/session/${open.json.key}/messages`, { text: 'hello' });
  assert.equal((await nos(['pending'], { cwd: root })).json.status, 'pending');
  const got = await nos(['await'], { cwd: root });
  assert.equal(got.json.status, 'messages');
  assert.equal(got.json.items[0].text, 'hello');

  const reply = await nos(['reply'], { cwd: root, stdin: 'hi from the agent\n' });
  assert.equal(reply.json.status, 'sent');
  const s = (await request(port, 'GET', `/api/session/${open.json.key}`)).body;
  assert.deepEqual(s.chat.at(-1).text, 'hi from the agent');

  const status = await nos([], { cwd: root });
  assert.equal(status.json.server, `http://127.0.0.1:${port}/`);

  // the user ends the chat: open is refused, await reports ended
  await request(port, 'POST', `/api/session/${open.json.key}/end`, {});
  assert.equal((await nos(['open', '--no-open'], { cwd: root })).json.status, 'user-ended');
  assert.equal((await nos(['await'], { cwd: root })).json.status, 'ended');
  assert.equal((await nos(['open', '--no-open', '--reopen'], { cwd: root })).json.status, 'open');
});

test('pair prints a one-time https link; devices lists, approves and revokes', async (t) => {
  const root = project(t);
  const a = (await nos(['pair'], { cwd: root })).json;
  const b = (await nos(['pair'], { cwd: root })).json;
  const codeOf = (r) => (r.urls[0] ? new URL(r.urls[0].url).searchParams.get('pair') : null);
  if (a.urls.length) {
    assert.match(a.urls[0].url, /^https:\/\//);
    assert.notEqual(codeOf(a), codeOf(b));
  }
  // the plain code is never stored
  const stored = readFileSync(path.join(root, 'specs', '.chat', 'devices.json'), 'utf8');
  if (codeOf(a)) assert.ok(!stored.includes(codeOf(a)));
  assert.deepEqual((await nos(['devices'], { cwd: root })).json, { devices: [] });
  assert.equal((await nos(['devices', '--approve', 'nope'], { cwd: root })).json.status, 'not-found');
  assert.equal((await nos(['devices', '--revoke-all'], { cwd: root })).json.status, 'revoked');
});

test('hook: queued message and no server gives a block decision and empties the queue', async (t) => {
  const root = project(t);
  const dir = path.join(root, 'specs', '.chat');
  mkdirSync(dir);
  const key = keyOf(root);
  const { realpathSync } = await import('node:fs');
  saveState(files(dir).sessions, {
    counter: 1,
    sessions: {
      [key]: {
        key,
        dir: realpathSync.native(root),
        name: '',
        status: 'open',
        endedBy: null,
        chat: [],
        pending: [{ id: 'm-1', text: 'Run the tests again', at: 'x' }],
      },
    },
  });
  assert.equal(await runHook(JSON.stringify({ cwd: root, stop_hook_active: true }), { env: ENV }), null);
  const out = await runHook(JSON.stringify({ cwd: root, stop_hook_active: false }), { env: ENV });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /- Run the tests again/);
  assert.equal(JSON.parse(readFileSync(files(dir).sessions, 'utf8')).sessions[key].pending.length, 0);
  assert.equal(await runHook(JSON.stringify({ cwd: root }), { env: ENV }), null);
  assert.equal(await runHook('not json', { env: ENV }), null);
  writeFileSync(files(dir).sessions, '{bad');
  assert.equal(await runHook(JSON.stringify({ cwd: root }), { env: ENV }), null);
});

test('hook: runner mode (the default) never takes the messages, the queue stays', async (t) => {
  const root = project(t);
  writeFileSync(path.join(root, 'specs', 'config.json'), '{}');
  const dir = path.join(root, 'specs', '.chat');
  mkdirSync(dir);
  const key = keyOf(root);
  const { realpathSync } = await import('node:fs');
  saveState(files(dir).sessions, {
    counter: 1,
    sessions: {
      [key]: {
        key,
        dir: realpathSync.native(root),
        name: '',
        status: 'open',
        endedBy: null,
        chat: [],
        pending: [{ id: 'm-1', text: 'for the runner', at: 'x' }],
      },
    },
  });
  assert.equal(await runHook(JSON.stringify({ cwd: root }), { env: ENV }), null);
  assert.equal(JSON.parse(readFileSync(files(dir).sessions, 'utf8')).sessions[key].pending.length, 1);
});

test('restart: a fresh server process, the tabs survive', async (t) => {
  const root = project(t);
  t.after(() => nos(['stop'], { cwd: root }));
  const serverJson = () => JSON.parse(readFileSync(files(path.join(root, 'specs', '.chat')).server, 'utf8'));
  const open = await nos(['open', '--no-open'], { cwd: root });
  const before = serverJson();
  const r = await nos(['restart'], { cwd: root });
  assert.equal(r.json.status, 'restarted');
  const after = serverJson();
  assert.notEqual(after.pid, before.pid);
  assert.equal(r.json.server, `http://127.0.0.1:${after.port}/`);
  const tabs = (await request(after.port, 'GET', '/api/sessions')).body.tabs;
  assert.deepEqual(
    tabs.map((x) => x.key),
    [open.json.key],
  );
  // no server yet: restart just starts one
  await nos(['stop'], { cwd: root });
  assert.equal((await nos(['restart'], { cwd: root })).json.status, 'restarted');
});
