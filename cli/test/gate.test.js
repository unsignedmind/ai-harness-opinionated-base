import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError, SLOT_TIMEOUT } from '../src/exit-codes.js';
import { CACHE_FILE, gateTools, runGate, TAIL_LINES } from '../src/gate.js';
import { lockStatus, takeLock } from '../src/lock.js';
import { slash } from '../src/roots.js';
import {
  gitOk,
  hasGit,
  invokeCli,
  makeProject,
  makeTempRoot,
  readJson,
  runNode,
  srcUrl,
  writeFile,
} from './helpers.js';

const pass = (text) => `node -e "console.log('${text}')"`;
const fail = (text) => `node -e "console.log('${text}'); process.exit(3)"`;
const many = `node -e "for (let i = 1; i <= 100; i++) console.log('line ' + i)"`;
const env = `node -e "console.log('home=' + process.env.NOS_HOME + ' slot=' + process.env.NOS_SLOT)"`;

const project = (t, tools, worktrees = { slots: 1, slotWait: 1 }) =>
  makeProject(t, { config: { 'quality-tools': tools, worktrees } });

// Cache tests: a git project; counter = a passing tool that counts its runs in a file outside the checkout
const noGit = { skip: !hasGit && 'git is not available' };
const gitProject = (t, tools, worktrees = { slots: 1, slotWait: 1 }) =>
  makeProject(t, { git: true, config: { 'quality-tools': tools, worktrees } });
function counter(t) {
  const file = slash(path.join(makeTempRoot(t), 'runs'));
  return {
    cmd: `node -e "require('fs').appendFileSync('${file}', 'x'); console.log('counted')"`,
    runs: () => (existsSync(file) ? readFileSync(file, 'utf8').length : 0),
  };
}

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

  assert.deepEqual(Object.keys(result), ['action', 'pass', 'cache', 'tree', 'tools']);
  assert.equal(result.action, 'gate');
  assert.equal(result.pass, false);
  assert.equal(result.cache, 'unavailable', 'not a git checkout');
  assert.equal(result.tree, null);
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
    assert.deepEqual(Object.keys(tool), [
      'name',
      'cmd',
      'status',
      'exit',
      'signal',
      'timedOut',
      'cached',
      'tail',
      'log',
    ]);
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
    signal: null,
    timedOut: false,
    cached: false,
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

test('runGate: a tool never sees the caller NODE_ENV, NOS_SLOT or run token', async (t) => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    NOS_SLOT: process.env.NOS_SLOT,
    NOS_RUN_TOKEN: process.env.NOS_RUN_TOKEN,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, { NODE_ENV: 'development', NOS_SLOT: '9', NOS_RUN_TOKEN: 'abcd1234' });
  const show = `node -e "console.log([process.env.NODE_ENV, process.env.NOS_SLOT, process.env.NOS_RUN_TOKEN].join(','))"`;
  const { roots } = project(t, { test: show });

  const result = await runGate(roots);

  assert.equal(result.tools[0].tail, ',,');
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

test('runGate kills a tool running longer than the timeout (tree included): fail, timedOut', async (t) => {
  const { roots } = project(t, { test: `node -e "setTimeout(() => {}, 20000)"`, lint: pass('ok') });

  const start = Date.now();
  const result = await runGate(roots, { timeoutMs: 300 });

  assert.ok(Date.now() - start < 10_000, 'did not wait for the tool');
  const [test1, lint] = result.tools;
  assert.equal(test1.status, 'fail');
  assert.equal(test1.timedOut, true);
  assert.match(test1.tail, /killed after the timeout/);
  assert.equal(lint.status, 'pass', 'the next tool still runs');
  assert.equal(result.pass, false);
});

test('quality-tools.timeout is in minutes, default 30', async (t) => {
  const { DEFAULT_PROJECT_CONFIG } = await import('../src/project-config.js');
  assert.equal(DEFAULT_PROJECT_CONFIG['quality-tools'].timeout, 30);
  const template = JSON.parse(readFileSync(new URL('../../templates/nos.config.json', import.meta.url), 'utf8'));
  assert.equal(template['quality-tools'].timeout, 30);
});

test('runGate: e2e alone is not set up without --e2e', async (t) => {
  const { roots } = project(t, { e2e: pass('e2e') });
  await assert.rejects(runGate(roots), /not set up/);
  assert.equal((await runGate(roots, { e2e: true })).pass, true);
});

test('runGate: SIGINT kills the running tool, releases the e2e lease and rejects "gate interrupted"', async (t) => {
  const { roots } = project(t, { e2e: `node -e "setTimeout(() => {}, 20000)"` });
  const signals = new EventEmitter();

  const running = runGate(roots, { e2e: true, signals });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(lockStatus(roots, 'slot-1').held, true);
  signals.emit('SIGINT');

  await assert.rejects(running, (err) => {
    assert.ok(err instanceof NosError);
    assert.equal(err.code, FAILED);
    assert.match(err.message, /gate interrupted by SIGINT/);
    return true;
  });
  assert.equal(lockStatus(roots, 'slot-1').held, false, 'lease released');
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('runGate --e2e takes over a slot lease whose process is gone and reports reclaimed', async (t) => {
  const { roots } = project(t, { e2e: env });
  const dead = await runNode(`
    import { takeLock } from '${srcUrl('lock.js')}';
    takeLock(${JSON.stringify(roots)}, 'slot-1', { run: 'quick-9', token: 'deadbeef', command: 'exec dev' });`);
  assert.equal(dead.code, 0, dead.stderr);

  const result = await runGate(roots, { e2e: true });

  assert.equal(result.pass, true);
  assert.equal(result.tools.at(-1).tail, `home=${roots.home} slot=1`);
  assert.equal(result.reclaimed.slot, 1);
  assert.equal(result.reclaimed.holder.token, 'deadbeef');
  assert.equal(lockStatus(roots, 'slot-1').held, false);
});

test('SLOT_TIMEOUT details carry pass of the tools run so far', async (t) => {
  const { roots } = project(t, { test: fail('x'), e2e: pass('e2e') });
  takeLock(roots, 'slot-1', { token: 'other' });
  await assert.rejects(
    runGate(roots, { e2e: true, slot: { waitMs: 50, pollMs: 10 } }),
    (err) => err.code === SLOT_TIMEOUT && err.details.pass === false && err.details.tools.length === 4,
  );
});

// ---------------------------------------------------------------------------------------------------------
// cache

test('cache: a second gate on the same content runs nothing; cached passes keep their tail, the log says so', noGit, async (t) => {
  const a = counter(t);
  const b = counter(t);
  const { roots } = gitProject(t, { test: a.cmd, lint: b.cmd });

  const first = await runGate(roots);
  assert.equal(first.cache, 'saved');
  assert.match(first.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    first.tools.map((tool) => tool.cached),
    [false, false, false, false],
  );

  const second = await runGate(roots);

  assert.equal(a.runs(), 1);
  assert.equal(b.runs(), 1);
  assert.equal(second.pass, true);
  assert.equal(second.cache, 'saved');
  assert.equal(second.tree, first.tree);
  const [test1, lint, formatCheck] = second.tools;
  assert.deepEqual(
    [test1.status, test1.exit, test1.cached, test1.tail],
    ['pass', 0, true, 'counted'],
  );
  assert.equal(lint.cached, true);
  assert.equal(formatCheck.status, 'not-configured');
  assert.match(readFileSync(test1.log, 'utf8'), new RegExp(`^nos: cached pass of .* on tree ${first.tree}[^]*counted`));
  assert.ok(readJson(roots.specs, `.runs/logs/main/${CACHE_FILE}`).trees[first.tree].tools.test);
});

test('cache: uncommitted and untracked files count; committing exactly the gated content hits (develop, then review)', noGit, async (t) => {
  const a = counter(t);
  const { root, roots } = gitProject(t, { test: a.cmd });
  await runGate(roots);

  writeFile(root, 'src/x.txt', 'x\n');
  const dirty = await runGate(roots);
  assert.equal(a.runs(), 2, 'an untracked file changes the content');
  assert.equal(dirty.tools[0].cached, false);

  gitOk(['add', 'src/x.txt'], root);
  gitOk(['commit', '-m', 'step-1: x'], root);
  const committed = await runGate(roots);
  assert.equal(a.runs(), 2);
  assert.equal(committed.tools[0].cached, true);
  assert.equal(committed.tree, dirty.tree);

  writeFile(root, '.specs/scratch.txt', 'ignored\n');
  assert.equal((await runGate(roots)).tools[0].cached, true, 'an ignored file is not part of the content');
});

test('cache: only passes are kept; a failed tool runs again, its passing sibling does not', noGit, async (t) => {
  const b = counter(t);
  const { roots } = gitProject(t, { test: fail('boom'), lint: b.cmd });
  await runGate(roots);

  const second = await runGate(roots);

  assert.equal(second.pass, false);
  assert.deepEqual(
    [second.tools[0].status, second.tools[0].cached, second.tools[0].tail],
    ['fail', false, 'boom'],
  );
  assert.equal(second.tools[1].cached, true);
  assert.equal(b.runs(), 1);
});

test('cache: a pass counts only for the same command', noGit, async (t) => {
  const a = counter(t);
  const b = counter(t);
  const { roots } = gitProject(t, { test: a.cmd, lint: b.cmd });
  const first = await runGate(roots);
  const file = path.join(roots.specs, '.runs', 'logs', 'main', CACHE_FILE);
  const cache = JSON.parse(readFileSync(file, 'utf8'));
  cache.trees[first.tree].tools.test.cmd = 'npm test';
  writeFile(path.dirname(file), CACHE_FILE, cache);

  const second = await runGate(roots);

  assert.deepEqual(
    second.tools.slice(0, 2).map((tool) => tool.cached),
    [false, true],
  );
  assert.equal(a.runs(), 2);
  assert.equal(b.runs(), 1);
});

test('cache: --fresh and quality-tools.cache false run every tool and keep nothing', noGit, async (t) => {
  const a = counter(t);
  const { root, roots } = gitProject(t, { test: a.cmd });
  await runGate(roots);

  const fresh = await invokeCli(['gate', '--fresh'], { cwd: root });
  assert.equal(fresh.code, 0, fresh.err);
  assert.equal(fresh.json.cache, 'off');
  assert.equal(fresh.json.tree, null);
  assert.equal(fresh.json.tools[0].cached, false);
  assert.equal(a.runs(), 2);

  const { roots: off } = gitProject(t, { test: a.cmd, cache: false });
  await runGate(off);
  const again = await runGate(off);
  assert.equal(again.cache, 'off');
  assert.equal(a.runs(), 4);
  assert.equal(existsSync(path.join(off.specs, '.runs', 'logs', 'main', CACHE_FILE)), false);
});

test('cache: a tool that changes the content keeps nothing (tree-changed)', noGit, async (t) => {
  const b = counter(t);
  const writer = `node -e "require('fs').writeFileSync('out-' + Date.now() + '.txt', 'x')"`;
  const { roots } = gitProject(t, { test: writer, lint: b.cmd });

  const first = await runGate(roots);
  assert.equal(first.cache, 'tree-changed');
  const second = await runGate(roots);

  assert.equal(second.tools[1].cached, false);
  assert.equal(b.runs(), 2);
});

test('cache: a cached e2e takes no slot', noGit, async (t) => {
  const e = counter(t);
  const { roots } = gitProject(t, { e2e: e.cmd });
  await runGate(roots, { e2e: true });
  takeLock(roots, 'slot-1', { token: 'other', command: 'exec dev' });

  const second = await runGate(roots, { e2e: true, slot: { waitMs: 50, pollMs: 10 } });

  assert.equal(second.pass, true);
  assert.equal(second.tools.at(-1).cached, true);
  assert.equal(e.runs(), 1);
});

test('cache: interrupted gate keeps nothing', noGit, async (t) => {
  const a = counter(t);
  const { roots } = gitProject(t, { test: a.cmd, e2e: `node -e "setTimeout(() => {}, 20000)"` });
  const signals = new EventEmitter();

  const running = runGate(roots, { e2e: true, signals });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  signals.emit('SIGINT');
  await assert.rejects(running, /gate interrupted/);

  assert.equal(existsSync(path.join(roots.specs, '.runs', 'logs', 'main', CACHE_FILE)), false);
});
