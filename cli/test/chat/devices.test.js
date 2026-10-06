import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { audit, createDeviceStore, deviceName, IDLE_MS } from '../../src/chat/devices.js';
import { ensureStateDir, stateDirOf } from '../../src/chat/paths.js';
import { initProject } from '../../src/init.js';
import { gitOk, hasGit, makeProject, makeTempRoot } from '../helpers.js';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36';

function setup(t) {
  const dir = ensureStateDir(path.join(makeTempRoot(t), '.specs', '.chat'));
  let clock = 1_000_000;
  const store = createDeviceStore({ dir, now: () => clock });
  return { dir, store, tick: (ms) => (clock += ms) };
}

test('a pairing code works once, then never again', (t) => {
  const { store } = setup(t);
  const { code } = store.createCode();
  const first = store.redeem(code, { userAgent: UA, ip: '192.168.1.5' });
  assert.ok(first);
  assert.match(first.confirm, /^\d{4}$/);
  assert.equal(store.redeem(code, { userAgent: UA }), null);
  assert.equal(store.redeem('made-up', {}), null);
  assert.equal(store.list()[0].name, 'Android · Chrome');
});

test('a code expires after 10 minutes; an unapproved device after another 10', (t) => {
  const { store, tick } = setup(t);
  const { code } = store.createCode();
  tick(10 * 60 * 1000 + 1);
  assert.equal(store.redeem(code), null);
  const late = store.redeem(store.createCode().code);
  tick(10 * 60 * 1000 + 1);
  assert.deepEqual(store.claim(late.id, late.poll), { status: 'gone' });
});

test('approval: pending until approved on the PC, then the secret is handed out exactly once', (t) => {
  const { store, dir } = setup(t);
  const r = store.redeem(store.createCode().code, { userAgent: UA });
  assert.deepEqual(store.claim(r.id, r.poll), { status: 'pending', confirm: r.confirm, name: 'Android · Chrome' });
  assert.deepEqual(store.claim(r.id, 'wrong-poll-secret'), { status: 'gone' });
  assert.equal(store.verify(`${r.id}.whatever-secret-1234567890`), null);
  assert.equal(store.approve(r.id), true);
  const ok = store.claim(r.id, r.poll);
  assert.equal(ok.status, 'approved');
  assert.deepEqual(store.claim(r.id, r.poll), { status: 'gone' });
  const device = store.verify(ok.cookie);
  assert.equal(device.id, r.id);
  assert.equal(device.status, 'active');
  // only hashes on disk
  const raw = readFileSync(path.join(dir, 'devices.json'), 'utf8');
  assert.ok(!raw.includes(ok.cookie.split('.')[1]));
  assert.ok(!raw.includes(r.poll));
  // a tampered secret fails
  assert.equal(store.verify(ok.cookie.slice(0, -2) + 'xx'), null);
});

test('deny, revoke, revoke all, rename; idle devices drop out after 30 days', (t) => {
  const { store, tick } = setup(t);
  const pair = () => {
    const r = store.redeem(store.createCode().code, { userAgent: UA });
    store.approve(r.id);
    return { id: r.id, cookie: store.claim(r.id, r.poll).cookie };
  };
  const denied = store.redeem(store.createCode().code);
  assert.equal(store.revoke(denied.id), true);
  assert.deepEqual(store.claim(denied.id, denied.poll), { status: 'gone' });

  const a = pair();
  const b = pair();
  assert.equal(store.rename(a.id, 'My phone'), true);
  assert.equal(store.list().find((d) => d.id === a.id).name, 'My phone');
  assert.equal(store.revoke(a.id), true);
  assert.equal(store.verify(a.cookie), null);
  assert.ok(store.verify(b.cookie));
  tick(IDLE_MS + 1);
  assert.equal(store.verify(b.cookie), null);
  const c = pair();
  assert.equal(store.revokeAll(), 1);
  assert.equal(store.verify(c.cookie), null);
});

test('audit log lines; the state folder keeps them out of git with its own * .gitignore', (t) => {
  const { dir } = setup(t);
  audit(dir, { device: 'abc', action: 'message', key: 'k1', detail: 'Run\nthe tests' });
  const log = readFileSync(path.join(dir, 'audit.log'), 'utf8');
  assert.match(log, /\tabc\tmessage\tk1\tRun the tests\n$/);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
});

// git check-ignore exits 0 when the path is ignored, 1 when not
const ignored = (cwd, file) => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', file], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

test(
  '<specs>/.chat (devices, audit log, tls) is ignored by the .specs repo and by the project',
  { skip: !hasGit },
  (t) => {
    const { root, roots } = makeProject(t, { git: true });
    initProject(roots);
    const dir = stateDirOf(roots, {});
    assert.equal(dir, path.join(root, '.specs', '.chat'));
    // before the state dir exists: the .specs/.gitignore of nos init alone keeps it out of the specs history
    for (const f of ['audit.log', 'devices.json', 'tls/cert.pem']) assert.ok(ignored(roots.specs, `.chat/${f}`), f);
    ensureStateDir(dir);
    audit(dir, { action: 'pair' });
    writeFileSync(path.join(dir, 'devices.json'), '{}');
    for (const f of ['audit.log', 'devices.json', 'tls/cert.pem']) {
      assert.ok(ignored(roots.specs, `.chat/${f}`), f);
      assert.ok(ignored(root, `.specs/.chat/${f}`), f);
    }
    // git add -A in .specs takes none of it
    gitOk(['add', '-A'], roots.specs);
    assert.doesNotMatch(gitOk(['status', '--porcelain'], roots.specs), /\.chat/);
  },
);

test('device names from the user agent', () => {
  assert.equal(
    deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1'),
    'iPhone · Safari',
  );
  assert.equal(deviceName(''), 'Device · Browser');
});
