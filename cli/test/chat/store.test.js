import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSessionStore } from '../../src/chat/sessions.js';
import { findRoot, keyOf, portOf, stateDirOf } from '../../src/chat/paths.js';
import { makeTempRoot } from '../helpers.js';

const storeIn = (dir) => createSessionStore({ file: path.join(dir, 'sessions.json') });

test('the key is the same for every spelling of a path, and differs per name', (t) => {
  const root = makeTempRoot(t);
  const k = keyOf(root);
  assert.match(k, /^[a-f0-9]{12}$/);
  assert.equal(keyOf(root + path.sep), k);
  assert.equal(keyOf(path.join(root, 'x', '..')), k);
  assert.notEqual(keyOf(root, 'other'), k);
});

test('findRoot walks up to the folder with specs/, state lives in specs/.chat', (t) => {
  const root = makeTempRoot(t);
  mkdirSync(path.join(root, 'specs'));
  mkdirSync(path.join(root, '.claude', 'skills', 'nos', 'ui'), { recursive: true });
  assert.equal(findRoot(path.join(root, '.claude', 'skills', 'nos', 'ui')), root);
  assert.equal(stateDirOf(root, {}), path.join(root, 'specs', '.chat'));
  assert.equal(stateDirOf(root, { NOS_CHAT_STATE_DIR: root }), root);
});

test('portOf reads chat.port from specs/config.json, else 4611', (t) => {
  const root = makeTempRoot(t);
  assert.equal(portOf(root, {}), 4611);
  mkdirSync(path.join(root, 'specs'));
  writeFileSync(path.join(root, 'specs', 'config.json'), JSON.stringify({ chat: { port: 4700 } }));
  assert.equal(portOf(root, {}), 4700);
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
  assert.deepEqual(r.items.map((i) => [i.id, i.text]), [['m-1', 'one'], ['m-2', 'two']]);
  assert.deepEqual(s.takeMessages(key), { status: 'waiting' });
  assert.equal(s.get(key).chat.length, 2);
});

test('an ended session refuses messages; a final batch carries sessionEnded', (t) => {
  const dir = makeTempRoot(t);
  const s = storeIn(dir);
  const { key } = s.open(dir);
  s.addUserMessage(key, 'bye', true);
  assert.equal(s.addUserMessage(key, 'again'), null);
  assert.deepEqual(
    (({ status, sessionEnded, endedBy }) => ({ status, sessionEnded, endedBy }))(s.takeMessages(key)),
    { status: 'messages', sessionEnded: true, endedBy: 'user' },
  );
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
