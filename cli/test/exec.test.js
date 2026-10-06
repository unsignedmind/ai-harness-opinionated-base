import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILED, NosError, SLOT_TIMEOUT, USAGE } from '../src/exit-codes.js';
import { execCommand } from '../src/exec.js';
import { lockStatus, takeLock } from '../src/lock.js';
import { slash } from '../src/roots.js';
import { invokeCli, makeProject } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nos.js');

// writes NOS_SLOT and NOS_HOME into out.txt in the work root, then exits with code
const record = (code) =>
  `node -e "require('fs').writeFileSync('out.txt', process.env.NOS_SLOT + ' ' + process.env.NOS_HOME); process.exit(${code})"`;

const project = (t, commands, worktrees = { slots: 1, slotWait: 1 }) =>
  makeProject(t, { config: { 'project-commands': commands, worktrees } });

test('execCommand passes the exit code through and runs in the work root with NOS_HOME, no slot', async (t) => {
  const { root, roots } = project(t, { install: record(0), 'deploy-test': record(5) });

  assert.equal(await execCommand(roots, 'install', { stdio: 'ignore' }), 0);
  assert.equal(readFileSync(path.join(root, 'out.txt'), 'utf8'), `undefined ${roots.home}`);
  assert.equal(await execCommand(roots, 'deploy-test', { stdio: 'ignore' }), 5);
});

test('execCommand dev holds a slot until the child exits, NOS_SLOT in its env', async (t) => {
  const { root, roots } = project(
    t,
    {
      dev: `node -e "require('fs').writeFileSync('out.txt', process.env.NOS_SLOT); setTimeout(() => process.exit(2), 300)"`,
    },
    { slots: 2, slotWait: 1 },
  );
  takeLock(roots, 'slot-1', { token: 'other' });

  const running = execCommand(roots, 'dev', { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lockStatus(roots, 'slot-2').holder?.command, 'exec dev', 'held while the server runs');

  assert.equal(await running, 2);
  assert.equal(readFileSync(path.join(root, 'out.txt'), 'utf8'), '2');
  assert.equal(lockStatus(roots, 'slot-2').held, false, 'released after exit');
});

test('execCommand: unknown name -> USAGE, null command -> FAILED, dev without slot -> SLOT_TIMEOUT', async (t) => {
  const { roots } = project(t, { dev: record(0) });
  const code = (c) => (err) => err instanceof NosError && err.code === c;

  await assert.rejects(execCommand(roots, 'build'), code(USAGE));
  await assert.rejects(execCommand(roots, 'install'), code(FAILED));
  takeLock(roots, 'slot-1', { token: 'other', command: 'exec dev' });
  await assert.rejects(execCommand(roots, 'dev', { slot: { waitMs: 50, pollMs: 10 } }), code(SLOT_TIMEOUT));
});

test('nos exec: exit code passthrough, 1 not configured, 2 unknown or missing name, 7 no slot', async (t) => {
  const { root, roots } = project(t, { 'deploy-test': record(4), dev: record(0) });
  // the child inherits stdio: run the binary so the test runner's stdout stays clean
  const nos = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });

  assert.equal((await nos(['exec', 'deploy-test'])).code, 4);
  assert.equal((await nos(['exec', 'install'])).code, 1);
  assert.equal((await invokeCli(['exec', 'build'], { cwd: root })).code, 2);
  assert.equal((await invokeCli(['exec'], { cwd: root })).code, 2);

  takeLock(roots, 'slot-1', { token: 'other', command: 'gate e2e' });
  const blocked = await invokeCli(['exec', 'dev'], { cwd: root });
  assert.equal(blocked.code, 7);
  assert.equal(blocked.json.action, 'exec');
  assert.equal(blocked.json.details.holders[0].holder.command, 'gate e2e');
});

test('execCommand dev: SIGINT / SIGTERM stop the server tree, the lease is released', async (t) => {
  const { roots } = project(t, { dev: `node -e "setInterval(() => {}, 1000)"` });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const signals = new EventEmitter();
    const running = execCommand(roots, 'dev', { stdio: 'ignore', signals });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(lockStatus(roots, 'slot-1').held, true);

    signals.emit(signal);
    const code = await running;

    assert.equal(code, signal === 'SIGINT' ? 130 : 143, signal);
    assert.equal(lockStatus(roots, 'slot-1').held, false, signal);
    assert.equal(signals.listenerCount(signal), 0, 'handlers removed');
  }
});

test("execCommand stdio 'log': output to <specs>/.runs/logs/<run>/<name>.log, resolves { code, log }", async (t) => {
  const { roots } = project(t, { install: `node -e "console.log('installed'); process.exit(3)"` });

  const result = await execCommand(roots, 'install', { stdio: 'log', run: 'quick-7' });

  assert.deepEqual(result, {
    code: 3,
    log: slash(path.join(roots.specs, '.runs', 'logs', 'quick-7', 'install.log')),
  });
  assert.match(readFileSync(result.log, 'utf8'), /^installed/);
});
