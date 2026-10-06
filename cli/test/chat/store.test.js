import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSessionStore } from '../../src/chat/sessions.js';
import { chatConfig, chatRoots, keyOf, portOf, stateDirOf } from '../../src/chat/paths.js';
import { gitOk, hasGit, makeProject, makeTempRoot } from '../helpers.js';

const storeIn = (dir) => createSessionStore({ file: path.join(dir, 'sessions.json') });

test('the key is the same for every spelling of a path, and differs per name', (t) => {
  const root = makeTempRoot(t);
  const k = keyOf(root);
  assert.match(k, /^[a-f0-9]{12}$/);
  assert.equal(keyOf(root + path.sep), k);
  assert.equal(keyOf(path.join(root, 'x', '..')), k);
  assert.notEqual(keyOf(root, 'other'), k);
});

test('chatRoots: from main and from nested folders the chat is the one of main, state in <specs>/.chat', (t) => {
  const { root } = makeProject(t);
  const nested = path.join(root, '.claude', 'skills', 'nos', 'ui');
  mkdirSync(nested, { recursive: true });
  for (const cwd of [root, nested, path.join(root, '.specs')]) {
    const roots = chatRoots({ cwd, env: {} });
    assert.equal(roots.main, root, cwd);
    assert.equal(stateDirOf(roots, {}), path.join(root, '.specs', '.chat'));
  }
  assert.equal(chatRoots({ root, cwd: nested, env: {} }).main, root);
  assert.equal(stateDirOf({ specs: path.join(root, '.specs') }, { NOS_CHAT_STATE_DIR: root }), root);
});

test(
  'chatRoots: nested git repos (nos itself, .specs) resolve to the project, not to the nested repo',
  { skip: !hasGit },
  (t) => {
    const { root } = makeProject(t, { git: true });
    const nos = path.join(root, '.claude', 'skills', 'nos');
    mkdirSync(path.join(nos, 'cli'), { recursive: true });
    gitOk(['init', '-q'], nos);
    gitOk(['init', '-q'], path.join(root, '.specs'));
    for (const cwd of [path.join(nos, 'cli'), path.join(root, '.specs')]) {
      const roots = chatRoots({ cwd, env: {} });
      assert.equal(roots.main, root, cwd);
      assert.equal(keyOf(roots.main), keyOf(root));
    }
  },
);

test('chatRoots: a worktree of the project gives main, so the same state dir and key', { skip: !hasGit }, (t) => {
  const { root } = makeProject(t, { git: true });
  const wt = path.join(root, '.claude', 'worktrees', 'quick-7');
  gitOk(['worktree', 'add', '-q', '-b', 'quick-7', wt], root);
  mkdirSync(path.join(wt, 'src'));
  const fromMain = chatRoots({ cwd: root, env: {} });
  const fromWt = chatRoots({ cwd: path.join(wt, 'src'), env: {} });
  assert.equal(fromWt.inWorktree, true);
  assert.equal(fromWt.main, root);
  assert.equal(stateDirOf(fromWt, {}), stateDirOf(fromMain, {}));
  assert.equal(keyOf(fromWt.main), keyOf(fromMain.main));
  // --root at the worktree: the same
  assert.equal(chatRoots({ root: wt, env: {} }).main, root);
});

test('chatRoots: a folder without nos.config.json is refused with "run nos init"', (t) => {
  const dir = makeTempRoot(t);
  mkdirSync(path.join(dir, 'specs'));
  assert.throws(() => chatRoots({ cwd: dir, env: {} }), /nos is not set up.*Run nos init/);
  assert.throws(() => chatRoots({ root: dir, env: {} }), /nos is not set up/);
});

test('portOf and chatConfig read "chat" of <specs>/config.json, else the defaults', (t) => {
  const { root, roots } = makeProject(t);
  assert.equal(portOf(roots, {}), 4611);
  assert.equal(chatConfig(roots).runner, true);
  writeFileSync(path.join(root, '.specs', 'config.json'), JSON.stringify({ chat: { port: 4700, runner: false } }));
  assert.equal(portOf(roots, {}), 4700);
  assert.equal(portOf(roots, { NOS_CHAT_PORT: '4621' }), 4621);
  assert.equal(chatConfig(roots).runner, false);
  // the old place is not read
  mkdirSync(path.join(root, 'specs'));
  writeFileSync(path.join(root, 'specs', 'config.json'), JSON.stringify({ chat: { port: 4800 } }));
  assert.equal(portOf(roots, {}), 4700);
});

test('a user-ended session refuses a plain reopen and accepts reopen; agent-ended reopens', (t) => {
  const dir = makeTempRoot(t);
  const s = storeIn(dir);
  const { key } = s.open(dir);
  s.end(key, 'user');
  assert.deepEqual(s.open(dir), { status: 'refused', key });
  assert.equal(s.get(key).status, 'ended');
  assert.deepEqual(s.open(dir, '', true), { status: 'open', key });
  s.end(key, 'agent');
  assert.equal(s.open(dir).status, 'open');
  assert.equal(s.get(key).endedBy, null);
});

test('takeMessages drains once, then returns waiting', (t) => {
  const dir = makeTempRoot(t);
  const s = storeIn(dir);
  const { key } = s.open(dir);
  assert.deepEqual(s.takeMessages('000000000000'), { status: 'missing' });
  assert.deepEqual(s.takeMessages(key), { status: 'waiting' });
  s.addUserMessage(key, 'one');
  s.addUserMessage(key, 'two');
  const r = s.takeMessages(key);
  assert.equal(r.status, 'messages');
  assert.deepEqual(
    r.items.map((i) => [i.id, i.text]),
    [
      ['m-1', 'one'],
      ['m-2', 'two'],
    ],
  );
  assert.deepEqual(s.takeMessages(key), { status: 'waiting' });
  assert.equal(s.get(key).chat.length, 2);
});

test('an ended session refuses messages; a final batch carries sessionEnded', (t) => {
  const dir = makeTempRoot(t);
  const s = storeIn(dir);
  const { key } = s.open(dir);
  s.addUserMessage(key, 'bye', true);
  assert.equal(s.addUserMessage(key, 'again'), null);
  assert.deepEqual((({ status, sessionEnded, endedBy }) => ({ status, sessionEnded, endedBy }))(s.takeMessages(key)), {
    status: 'messages',
    sessionEnded: true,
    endedBy: 'user',
  });
  assert.deepEqual(s.takeMessages(key), { status: 'ended', endedBy: 'user' });
});

test('pending messages survive a reload from disk; a corrupt file gives an empty store', (t) => {
  const dir = makeTempRoot(t);
  const s = storeIn(dir);
  const { key } = s.open(dir);
  s.addUserMessage(key, 'keep me');
  s.addAgentReply(key, 'ok');
  const again = storeIn(dir);
  assert.equal(again.list()[0].pending, 1);
  assert.equal(again.takeMessages(key).items[0].text, 'keep me');
  writeFileSync(path.join(dir, 'sessions.json'), '{nope');
  assert.deepEqual(storeIn(dir).list(), []);
});
