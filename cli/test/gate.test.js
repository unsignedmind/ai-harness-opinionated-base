import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError, SLOT_TIMEOUT } from '../src/exit-codes.js';
import { gateTools, runGate, TAIL_LINES } from '../src/gate.js';
import { lockStatus, takeLock } from '../src/lock.js';
import { slash } from '../src/roots.js';
import { invokeCli, makeProject } from './helpers.js';

const pass = (text) => `node -e "console.log('${text}')"`;
const fail = (text) => `node -e "console.log('${text}'); process.exit(3)"`;
const many = `node -e "for (let i = 1; i <= 100; i++) console.log('line ' + i)"`;
const env = `node -e "console.log('home=' + process.env.NOS_HOME + ' slot=' + process.env.NOS_SLOT)"`;

const project = (t, tools, worktrees = { slots: 1, slotWait: 1 }) =>
  makeProject(t, { config: { 'quality-tools': tools, worktrees } });

test('gateTools: order test, lint, format-check, typecheck, additional, e2e; cmd null when not configured', () => {
  const tools = gateTools(
    { test: 't', lint: null, typecheck: ' ', e2e: 'e', additional: ['knip', { name: 'i18n', cmd: 'x' }, null] },
    { e2e: true },
  );
  assert.deepEqual(tools, [
    { name: 'test', cmd: 't' },
    { name: 'lint', cmd: null },
    { name: 'format-check', cmd: null },
    { name: 'typecheck', cmd: null },
    { name: 'additional-1', cmd: 'knip' },
    { name: 'i18n', cmd: 'x' },
    { name: 'additional-3', cmd: null },
    { name: 'e2e', cmd: 'e' },
  ]);
  assert.equal(gateTools({ e2e: 'e' }).length, 4, 'no e2e without the option');
});

test('runGate runs every tool, also after a failure; JSON shape, logs, tail of 60 lines', async (t) => {
  const { roots } = project(t, { test: fail('boom'), lint: many, typecheck: pass('ok'), additional: [pass('extra')] });

  const result = await runGate(roots);

  assert.deepEqual(Object.keys(result), ['action', 'pass', 'tools']);
  assert.equal(result.action, 'gate');
  assert.equal(result.pass, false);
  assert.deepEqual(
    result.tools.map((tool) => [tool.name, tool.status, tool.exit]),
    [
      ['test', 'fail', 3],
      ['lint', 'pass', 0],
      ['format-check', 'not-configured', null],
      ['typecheck', 'pass', 0],
      ['additional-1', 'pass', 0],
    ],
  );
  for (const tool of result.tools)
    assert.deepEqual(Object.keys(tool), ['name', 'cmd', 'status', 'exit', 'tail', 'log']);
  const [test1, lint, formatCheck] = result.tools;
  assert.equal(test1.cmd, fail('boom'));
  assert.equal(test1.tail, 'boom');
  assert.equal(test1.log, slash(path.join(roots.specs, '.runs', 'logs', 'main', 'test.log')));
  assert.equal(lint.tail.split('\n').length, TAIL_LINES);
  assert.equal(lint.tail.split('\n')[0], 'line 41');
  assert.match(readFileSync(lint.log, 'utf8'), /^line 1\r?\nline 2/, 'full output in the log');
  assert.deepEqual(formatCheck, {
    name: 'format-check',
    cmd: null,
    status: 'not-configured',
    exit: null,
    tail: '',
    log: null,
  });
});

test('runGate: tools run in the work root with NOS_HOME, NOS_SLOT only for e2e; e2e only with the option', async (t) => {
  const { roots } = project(t, { test: env, e2e: env }, { slots: 2, slotWait: 1 });
  takeLock(roots, 'slot-1', { token: 'other', command: 'dev' });

  const without = await runGate(roots);
  assert.deepEqual(
    without.tools.map((tool) => tool.name),
    ['test', 'lint', 'format-check', 'typecheck'],
  );

  const withE2e = await runGate(roots, { e2e: true, run: 'quick-7' });
  assert.equal(withE2e.pass, true);
  const e2e = withE2e.tools.at(-1);
  assert.equal(e2e.name, 'e2e');
  assert.equal(e2e.tail, `home=${roots.home} slot=2`, 'smallest free slot');
  assert.equal(withE2e.tools[0].tail, `home=${roots.home} slot=undefined`);
  assert.equal(e2e.log, slash(path.join(roots.specs, '.runs', 'logs', 'quick-7', 'e2e.log')));
  assert.equal(lockStatus(roots, 'slot-2').held, false, 'lease released');
});

test('runGate --e2e with e2e null reports it not-configured and takes no slot', async (t) => {
  const { roots } = project(t, { test: pass('ok') });
  takeLock(roots, 'slot-1', { token: 'other' });

  const result = await runGate(roots, { e2e: true });

  assert.equal(result.pass, true);
  assert.equal(result.tools.at(-1).status, 'not-configured');
});

test('runGate without quality tools: not set up (FAILED)', async (t) => {
  const { roots } = makeProject(t);
  await assert.rejects(
    runGate(roots),
    (err) => err instanceof NosError && err.code === FAILED && /not set up/.test(err.message),
  );
});

test('runGate --e2e without a free slot: SLOT_TIMEOUT with holders and the tools run so far', async (t) => {
  const { roots } = project(t, { test: pass('ok'), e2e: pass('e2e') });
  takeLock(roots, 'slot-1', { run: 'quick-8', token: 'other', command: 'exec dev' });

  await assert.rejects(
    runGate(roots, { e2e: true, slot: { waitMs: 100, pollMs: 20 } }),
    (err) =>
      err instanceof NosError &&
      err.code === SLOT_TIMEOUT &&
      err.details.holders[0].holder.run === 'quick-8' &&
      err.details.tools[0].name === 'test',
  );
});

test('nos gate: exit 0 on pass, exit 1 with the JSON on a failed tool, 1 when not set up', async (t) => {
  const { root } = project(t, { test: pass('ok') });
  const ok = await invokeCli(['gate'], { cwd: root });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json.pass, true);

  const { root: failing } = project(t, { test: fail('boom'), lint: fail('bad') });
  const failed = await invokeCli(['gate'], { cwd: failing });
  assert.equal(failed.code, 1);
  assert.equal(failed.json.action, 'gate');
  assert.equal(failed.json.pass, false);
  assert.equal(failed.err, 'nos: gate failed: test, lint\n');

  const { root: bare } = makeProject(t);
  const notSetUp = await invokeCli(['gate'], { cwd: bare });
  assert.equal(notSetUp.code, 1);
  assert.equal(notSetUp.out, '');
  assert.match(notSetUp.err, /quality tools are not set up/);
});

test('nos gate --e2e with every slot held: exit 7 with { action, error, exit, details } after slotWait', async (t) => {
  const { root, roots } = project(t, { test: pass('ok'), e2e: pass('e2e') }, { slots: 1, slotWait: 1 });
  takeLock(roots, 'slot-1', { run: 'quick-8', token: 'other', command: 'exec dev' });

  const start = Date.now();
  const res = await invokeCli(['gate', '--e2e'], { cwd: root });

  assert.ok(Date.now() - start >= 950, 'waited slotWait');
  assert.equal(res.code, 7);
  assert.deepEqual(Object.keys(res.json), ['action', 'error', 'exit', 'details']);
  assert.equal(res.json.action, 'gate');
  assert.equal(res.json.exit, 7);
  assert.equal(res.json.details.slots, 1);
  assert.equal(res.json.details.holders[0].holder.command, 'exec dev');
  assert.match(res.err, /^nos: no free slot of 1 within 1s/);
});
