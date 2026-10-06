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
import { gitOk, hasGit, makeProject, makeTempRoot } from '../helpers.js';

// NOS_SPECS_ROOT of the shell running the tests must not pick the project
const ENV = { ...process.env, NOS_CHAT_PORT: '0', NOS_CHAT_IDLE_MS: '20000' };
delete ENV.NOS_SPECS_ROOT;
delete ENV.NOS_CHAT_STATE_DIR;

// a project set up like nos init leaves it (nos.config.json, .specs/config.json), in relay mode: these
// tests answer the chat themselves, no Claude Code is started
function project(t, { git = false } = {}) {
  const { root } = makeProject(t, { git });
  writeFileSync(path.join(root, '.specs', 'config.json'), JSON.stringify({ chat: { runner: false } }));
  return root;
}
const stateOf = (root) => path.join(root, '.specs', '.chat');

// a linked worktree of the project where nos run start puts it, with a subfolder
function worktree(root, name = 'quick-7') {
  const wt = path.join(root, '.claude', 'worktrees', name);
  gitOk(['worktree', 'add', '-q', '-b', name, wt], root);
  mkdirSync(path.join(wt, 'src'));
  return wt;
}

// a sessions.json with one open session of main, one message queued
async function queued(root, text) {
  const dir = stateOf(root);
  mkdirSync(dir, { recursive: true });
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
        pending: [{ id: 'm-1', text, at: 'x' }],
      },
    },
  });
  return { dir, key };
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
  assert.ok(existsSync(path.join(stateOf(root), '.gitignore')));
  const port = JSON.parse(readFileSync(files(stateOf(root)).server, 'utf8')).port;

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
  const stored = readFileSync(path.join(stateOf(root), 'devices.json'), 'utf8');
  if (codeOf(a)) assert.ok(!stored.includes(codeOf(a)));
  assert.deepEqual((await nos(['devices'], { cwd: root })).json, { devices: [] });
  assert.equal((await nos(['devices', '--approve', 'nope'], { cwd: root })).json.status, 'not-found');
  assert.equal((await nos(['devices', '--revoke-all'], { cwd: root })).json.status, 'revoked');
});

test('hook: queued message and no server gives a block decision and empties the queue', async (t) => {
  const root = project(t);
  const { dir, key } = await queued(root, 'Run the tests again');
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

test(
  'hook: a session in a worktree of the project (cwd deep inside it) takes the queue of main',
  { skip: !hasGit },
  async (t) => {
    const root = project(t, { git: true });
    const wt = worktree(root);
    const { dir, key } = await queued(root, 'from the phone');
    const out = await runHook(JSON.stringify({ cwd: path.join(wt, 'src') }), { env: ENV });
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /- from the phone/);
    assert.equal(JSON.parse(readFileSync(files(dir).sessions, 'utf8')).sessions[key].pending.length, 0);
    // no state dir in the worktree
    assert.ok(!existsSync(path.join(wt, '.specs')));
  },
);

test('hook: outside a nos project (no nos.config.json) there is no output', async (t) => {
  const dir = makeTempRoot(t);
  mkdirSync(path.join(dir, 'specs'));
  assert.equal(await runHook(JSON.stringify({ cwd: dir }), { env: ENV }), null);
});

test(
  'a chat started from a worktree cwd uses the same state dir and key as from main',
  { skip: !hasGit },
  async (t) => {
    const root = project(t, { git: true });
    const wt = worktree(root);
    t.after(() => nos(['stop'], { cwd: root }));
    const fromWt = await nos(['open', '--no-open'], { cwd: path.join(wt, 'src') });
    assert.equal(fromWt.json.status, 'open');
    assert.equal(fromWt.json.key, keyOf(root));
    const server = JSON.parse(readFileSync(files(stateOf(root)).server, 'utf8'));
    assert.equal(server.root, root);
    const fromMain = await nos(['open', '--no-open'], { cwd: root });
    assert.equal(fromMain.json.key, fromWt.json.key);
    assert.equal(fromMain.json.url, fromWt.json.url);
    const status = await nos([], { cwd: wt });
    assert.equal(status.json.root, root.split(path.sep).join('/'));
    assert.equal(status.json.server, `http://127.0.0.1:${server.port}/`);
    assert.ok(!existsSync(path.join(wt, '.specs')));
  },
);

test('commands outside a nos project fail with "run nos init"', async (t) => {
  const dir = makeTempRoot(t);
  const r = await nos([], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.json.error, /nos is not set up in .*: run nos init/);
});

test('hook: runner mode (the default) never takes the messages, the queue stays', async (t) => {
  const root = project(t);
  writeFileSync(path.join(root, '.specs', 'config.json'), '{}');
  const { dir, key } = await queued(root, 'for the runner');
  assert.equal(await runHook(JSON.stringify({ cwd: root }), { env: ENV }), null);
  assert.equal(JSON.parse(readFileSync(files(dir).sessions, 'utf8')).sessions[key].pending.length, 1);
});

test('restart: a fresh server process, the tabs survive', async (t) => {
  const root = project(t);
  t.after(() => nos(['stop'], { cwd: root }));
  const serverJson = () => JSON.parse(readFileSync(files(stateOf(root)).server, 'utf8'));
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
