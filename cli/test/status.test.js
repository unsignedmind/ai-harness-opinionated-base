import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { createPlan } from '../src/plan.js';
import { createQuickStep } from '../src/quick-step.js';
import { FAILED, NosError, USAGE } from '../src/exit-codes.js';
import { writeRun } from '../src/runs.js';
import { readValidStatuses, RUN_STATUSES, setRunStatus, setStatus } from '../src/status.js';
import { invokeCli, makeProject, makeRoots, readJson, writeFile, STATUS_XML } from './helpers.js';

const step = (slug) => ({ slug, intent: slug, status: 'open', description: '', 'spec-file': '' });
const phase = (slug, steps) => ({ slug, name: slug, status: 'open', intent: '', description: '', steps });

function setup(t, plan) {
  const roots = makeRoots(t);
  writeFile(roots.home, 'templates/status.xml', STATUS_XML);
  const { folder: domain } = createDomain(roots, { idea: '# Auth', slug: 'auth' });
  createPlan(roots, {
    domain,
    plan: plan ?? {
      name: 'Auth',
      status: 'open',
      labels: ['backend'],
      phases: [phase('data-model', [step('user-table'), step('hashing')]), phase('login-api', [step('endpoint')])],
    },
  });
  const read = () => readJson(roots.specs, `${domain}/plan.json`);
  return { roots, domain, read };
}

test('reads plan, phase and step statuses from status.xml', (t) => {
  const roots = makeRoots(t);
  writeFile(roots.home, 'templates/status.xml', STATUS_XML);
  assert.deepEqual(readValidStatuses(roots), {
    plans: ['open', 'in-progress', 'done'],
    phases: ['open', 'implemented', 'in-review'],
    steps: ['open', 'in-specification', 'specified', 'implemented', 'in-review'],
  });
});

test('step-only statuses are valid for steps but not for phases', (t) => {
  const { roots, domain, read } = setup(t);

  setStatus(roots, { domain, step: '1', status: 'specified' });

  assert.equal(read().phases[0].steps[0].status, 'specified');
  assert.throws(() => setStatus(roots, { domain, phase: '1', status: 'specified' }), /for a phase.*open, implemented, in-review/i);
  assert.equal(read().phases[0].status, 'open');
});

test('sets the plan status when only --domain is given', (t) => {
  const { roots, domain, read } = setup(t);

  const result = setStatus(roots, { domain, status: 'in-progress' });

  assert.equal(result.target, 'plan');
  assert.equal(result.previous, 'open');
  assert.equal(read().status, 'in-progress');
  assert.equal(read().phases[0].status, 'open');
});

test('sets a phase status by phase id', (t) => {
  const { roots, domain, read } = setup(t);

  const result = setStatus(roots, { domain, phase: '2', status: 'in-review' });

  assert.deepEqual([result.target, result.id, result.slug], ['phase', 2, 'login-api']);
  assert.equal(read().phases[1].status, 'in-review');
  assert.equal(read().phases[0].status, 'open');
  assert.equal(read().status, 'open');
});

test('sets a step status by step id, with or without its phase', (t) => {
  const { roots, domain, read } = setup(t);

  setStatus(roots, { domain, step: '2', status: 'implemented' });
  setStatus(roots, { domain, phase: '2', step: '3', status: 'in-review' });

  const saved = read();
  assert.deepEqual(saved.phases[0].steps.map((s) => s.status), ['open', 'implemented']);
  assert.equal(saved.phases[1].steps[0].status, 'in-review');
  assert.equal(saved.phases[1].status, 'open');
});

test('keeps the rest of plan.json unchanged', (t) => {
  const { roots, domain, read } = setup(t);
  const before = read();

  setStatus(roots, { domain, step: '1', status: 'implemented' });

  const after = read();
  after.phases[0].steps[0].status = 'open';
  assert.deepEqual(after, before);
});

test('works with the template shape where phases and steps are single objects', (t) => {
  const { roots, domain, read } = setup(t, { name: 'x', status: 'open', phases: phase('only', step('one')) });

  setStatus(roots, { domain, phase: '1', status: 'implemented' });
  setStatus(roots, { domain, step: '1', status: 'in-review' });

  assert.equal(read().phases.status, 'implemented');
  assert.equal(read().phases.steps.status, 'in-review');
});

test('rejects statuses not valid for the target category', (t) => {
  const { roots, domain, read } = setup(t);
  const before = readFileSync(path.join(roots.specs, `${domain}/plan.json`), 'utf8');

  assert.throws(() => setStatus(roots, { domain, status: 'implemented' }), /invalid status "implemented" for a plan.*open, in-progress, done/i);
  assert.throws(() => setStatus(roots, { domain, step: '1', status: 'done' }), /for a step.*open, in-specification, specified, implemented, in-review/i);
  assert.throws(() => setStatus(roots, { domain, phase: '1', status: 'In-Review' }), /invalid status/i);

  assert.equal(readFileSync(path.join(roots.specs, `${domain}/plan.json`), 'utf8'), before);
  assert.equal(read().status, 'open');
});

test('rejects unknown or mismatched ids', (t) => {
  const { roots, domain } = setup(t);
  assert.throws(() => setStatus(roots, { domain, phase: '9', status: 'open' }), /phase 9 is not in this plan/i);
  assert.throws(() => setStatus(roots, { domain, step: '9', status: 'open' }), /step 9 is not in this plan/i);
  assert.throws(() => setStatus(roots, { domain, phase: '1', step: '3', status: 'open' }), /step 3 is not in phase 1/i);
  assert.throws(() => setStatus(roots, { domain, step: 'abc', status: 'open' }), /invalid step id "abc"/i);
  assert.throws(() => setStatus(roots, { domain, phase: '0', status: 'open' }), /invalid phase id "0"/i);
});

test('rejects missing inputs, domains without a plan and a missing status.xml', (t) => {
  const { roots, domain } = setup(t);
  assert.throws(() => setStatus(roots, { domain }), /missing input: status/i);
  assert.throws(() => setStatus(roots, { status: 'open' }), /missing input: domain. set-status/i);

  const { folder: unplanned } = createDomain(roots, { idea: '# Other', slug: 'other' });
  assert.throws(() => setStatus(roots, { domain: unplanned, status: 'open' }), /has no plan\.json/);

  const bare = makeRoots(t);
  createDomain(bare, { idea: '# X', slug: 'x' });
  assert.throws(() => setStatus(bare, { domain: 'domain-1-x', status: 'open' }), /missing .*status\.xml/i);
});

test('sets the status of a quick step, also in a domain without plan.json', (t) => {
  const roots = makeRoots(t);
  writeFile(roots.home, 'templates/status.xml', STATUS_XML);
  const { folder: domain } = createDomain(roots, { idea: '# Auth', slug: 'auth' });
  createQuickStep(roots, { domain, step: { slug: 'fix-typo', intent: 'Fix' } });

  const result = setStatus(roots, { domain, step: '1', status: 'specified' });

  assert.deepEqual(
    [result.target, result.id, result.slug, result.previous, result.status, result.quick],
    ['step', 1, 'fix-typo', 'open', 'specified', true],
  );
  assert.equal(result.planPath, path.join(roots.specs, domain, 'quick-steps', 'quick-steps.json'));
  assert.equal(readJson(roots.specs, `${domain}/quick-steps/quick-steps.json`)[0].status, 'specified');
  assert.throws(() => setStatus(roots, { domain, step: '9', status: 'open' }), /not a quick step.*no plan\.json/i);
  assert.throws(() => setStatus(roots, { domain, status: 'open' }), /has no plan\.json/);
});

test('plan steps and quick steps of one domain are told apart by id', (t) => {
  const { roots, domain, read } = setup(t);
  createQuickStep(roots, { domain, step: { slug: 'quick', intent: 'Quick' } });

  setStatus(roots, { domain, step: '4', status: 'implemented' });
  setStatus(roots, { domain, step: '1', status: 'specified' });

  assert.equal(readJson(roots.specs, `${domain}/quick-steps/quick-steps.json`)[0].status, 'implemented');
  assert.equal(read().phases[0].steps[0].status, 'specified');
  assert.throws(() => setStatus(roots, { domain, phase: '1', step: '4', status: 'open' }), /step 4 is not in phase 1/i);
});

test('a legacy spec-file with the specs/ prefix is refused: run the migration', (t) => {
  const { roots, domain } = setup(t);
  createQuickStep(roots, { domain, step: { slug: 'quick', intent: 'Quick' } });
  const quickFile = `${domain}/quick-steps/quick-steps.json`;
  const quick = readJson(roots.specs, quickFile);
  quick[0]['spec-file'] = `specs/${quick[0]['spec-file']}`;
  writeFile(roots.specs, quickFile, quick);
  const planFile = `${domain}/plan.json`;
  const plan = readJson(roots.specs, planFile);
  plan.phases[0].steps[0]['spec-file'] = `specs/${plan.phases[0].steps[0]['spec-file']}`;
  writeFile(roots.specs, planFile, plan);

  assert.throws(() => setStatus(roots, { domain, step: '4', status: 'implemented' }), /legacy spec-file "specs\/domain-1-auth\/.*run the migration/);
  assert.throws(() => setStatus(roots, { domain, step: '1', status: 'implemented' }), /legacy spec-file/);
});

// ---- set-status --run: statuses of a whole run (the real status.xml has merged and discarded)

const REAL_STATUS_XML = readFileSync(new URL('../../templates/status.xml', import.meta.url), 'utf8');
const isCode = (code) => (err) => err instanceof NosError && err.code === code;

// domain-1-auth: plan (phase 1: steps 1, 2; phase 2: step 3) and quick step 4
function runSetup(t) {
  const roots = makeRoots(t);
  writeFile(roots.home, 'templates/status.xml', REAL_STATUS_XML);
  const { folder: domain } = createDomain(roots, { idea: '# Auth', slug: 'auth' });
  createPlan(roots, {
    domain,
    plan: { name: 'Auth', status: 'open', phases: [phase('a', [step('s1'), step('s2')]), phase('b', [step('s3')])] },
  });
  createQuickStep(roots, { domain, step: { slug: 'fix', intent: 'fix' } });
  const plan = () => readJson(roots.specs, `${domain}/plan.json`);
  const quick = () => readJson(roots.specs, `${domain}/quick-steps/quick-steps.json`);
  const setAll = (status) => {
    for (const id of ['1', '2', '3']) setStatus(roots, { domain, step: id, status });
  };
  return { roots, domain, plan, quick, setAll };
}

const stepStatuses = (plan) => plan.phases.flatMap((p) => p.steps.map((s) => s.status));
const planFile = (roots, domain) => path.join(roots.specs, domain, 'plan.json');

test('status.xml has merged and discarded for plans and steps, not for phases', () => {
  const section = (tag) => REAL_STATUS_XML.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
  for (const status of RUN_STATUSES) {
    assert.match(section('plans'), new RegExp(`<name>${status}</name>`));
    assert.match(section('steps'), new RegExp(`<name>${status}</name>`));
    assert.doesNotMatch(section('phases'), new RegExp(`<name>${status}</name>`));
  }
});

test('plain set-status refuses merged and discarded with a hint to --run', (t) => {
  const { roots, domain, plan } = runSetup(t);
  for (const status of RUN_STATUSES) {
    assert.throws(() => setStatus(roots, { domain, status }), (err) => isCode(FAILED)(err) && /--run/.test(err.message));
    assert.throws(() => setStatus(roots, { domain, step: '4', status }), /set-status --run/);
  }
  assert.equal(plan().status, 'open');
});

test('plan merged: plan and steps done -> merged, phases unchanged, one write; a rerun changes nothing', (t) => {
  const { roots, domain, plan, setAll } = runSetup(t);
  setAll('done');
  setStatus(roots, { domain, phase: '1', status: 'done' });
  setStatus(roots, { domain, status: 'done' });

  const result = setRunStatus(roots, { run: 'plan-1', status: 'merged' });

  assert.equal(result.action, 'set-status');
  assert.equal(result.run, 'plan-1');
  assert.equal(result.domain, domain);
  assert.equal(result.file, planFile(roots, domain).split(path.sep).join('/'));
  assert.deepEqual(
    result.changes.map((c) => [c.target, c.id, c.previous, c.status]),
    [
      ['plan', 1, 'done', 'merged'],
      ['step', 1, 'done', 'merged'],
      ['step', 2, 'done', 'merged'],
      ['step', 3, 'done', 'merged'],
    ],
  );
  const saved = plan();
  assert.equal(saved.status, 'merged');
  assert.deepEqual(stepStatuses(saved), ['merged', 'merged', 'merged']);
  assert.deepEqual(
    saved.phases.map((p) => p.status),
    ['done', 'open'],
    'phases unchanged',
  );
  assert.deepEqual(setRunStatus(roots, { run: 'plan-1', status: 'merged' }).changes, []);
});

test('plan merged: a plan or step not done is a violation, nothing written', (t) => {
  const { roots, domain, setAll } = runSetup(t);
  setAll('done');
  setStatus(roots, { domain, step: '2', status: 'reviewed' });
  setStatus(roots, { domain, status: 'done' });
  const before = readFileSync(planFile(roots, domain), 'utf8');
  assert.throws(
    () => setRunStatus(roots, { run: 'plan-1', status: 'merged' }),
    (err) => isCode(FAILED)(err) && err.details.violations.length === 1 && err.details.violations[0].id === 2,
  );
  assert.equal(readFileSync(planFile(roots, domain), 'utf8'), before);
  setStatus(roots, { domain, status: 'in-progress' });
  assert.throws(() => setRunStatus(roots, { run: 'plan-1', status: 'merged' }), /plan 1 is in-progress/);
});

test('plan discarded: plan and every step not merged -> discarded; a merged plan cannot be discarded', (t) => {
  const { roots, domain, plan } = runSetup(t);
  setStatus(roots, { domain, status: 'in-progress' });
  setStatus(roots, { domain, step: '1', status: 'done' });
  const saved = plan();
  saved.phases[0].steps[1].status = 'merged';
  writeFile(roots.specs, `${domain}/plan.json`, saved);

  const result = setRunStatus(roots, { run: 'plan-1', status: 'discarded' });

  assert.deepEqual(
    result.changes.map((c) => [c.target, c.id, c.previous]),
    [
      ['plan', 1, 'in-progress'],
      ['step', 1, 'done'],
      ['step', 3, 'open'],
    ],
  );
  assert.equal(plan().status, 'discarded');
  assert.deepEqual(stepStatuses(plan()), ['discarded', 'merged', 'discarded']);

  const merged = plan();
  merged.status = 'merged';
  writeFile(roots.specs, `${domain}/plan.json`, merged);
  assert.throws(() => setRunStatus(roots, { run: 'plan-1', status: 'discarded' }), /plan 1 is merged/);
});

test('quick: done -> merged, anything except merged -> discarded; only the step of the run changes', (t) => {
  const { roots, domain, quick, plan } = runSetup(t);
  assert.throws(() => setRunStatus(roots, { run: 'quick-4', status: 'merged' }), /step 4 is open/);
  setStatus(roots, { domain, step: '4', status: 'done' });
  const dry = setRunStatus(roots, { run: 'quick-4', status: 'merged', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(quick()[0].status, 'done', 'a dry run writes nothing');

  const result = setRunStatus(roots, { run: 'quick-4', status: 'merged' });
  assert.deepEqual(result.changes, [{ target: 'step', id: 4, slug: 'fix', previous: 'done', status: 'merged' }]);
  assert.match(result.file, /quick-steps\/quick-steps\.json$/);
  assert.equal(quick()[0].status, 'merged');
  assert.equal(plan().status, 'open', 'the plan is untouched');
  assert.throws(() => setRunStatus(roots, { run: 'quick-4', status: 'discarded' }), /step 4 is merged/);

  const other = runSetup(t);
  setStatus(other.roots, { domain: other.domain, step: '4', status: 'in-review' });
  assert.equal(setRunStatus(other.roots, { run: 'quick-4', status: 'discarded' }).changes[0].previous, 'in-review');
  assert.equal(other.quick()[0].status, 'discarded');
});

test('set-status --run: the domain comes from the run file; bad input is refused', (t) => {
  const { roots, domain } = runSetup(t);
  writeRun(roots, { kind: 'quick', id: 4, domain, phase: 'develop' });
  setStatus(roots, { domain, step: '4', status: 'done' });
  assert.equal(setRunStatus(roots, { run: 'quick-4', status: 'merged' }).domain, domain);
  assert.throws(() => setRunStatus(roots, { run: 'quick-4', status: 'done' }), isCode(USAGE));
  assert.throws(() => setRunStatus(roots, { run: 'step-4', status: 'merged' }), isCode(USAGE));
  assert.throws(() => setRunStatus(roots, { run: 'quick-99', status: 'merged' }), /No quick step for run quick-99/);
  assert.throws(() => setRunStatus(roots, { run: 'plan-9', status: 'merged' }), /No domain for run plan-9/);
});

test('nos set-status --run <run> merged|discarded via the CLI', async (t) => {
  const { root, roots } = makeProject(t);
  const { folder: domain } = createDomain(roots, { idea: '# A', slug: 'a' });
  createQuickStep(roots, { domain, step: { slug: 'fix', intent: 'fix' } });
  setStatus(roots, { domain, step: '1', status: 'done' });

  const refused = await invokeCli(['set-status', '--domain', domain, '--step', '1', '--status', 'merged'], {
    cwd: root,
  });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /set-status --run/);

  const done = await invokeCli(['set-status', '--run', 'quick-1', 'merged'], { cwd: root });
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(Object.keys(done.json), ['action', 'run', 'domain', 'status', 'file', 'changes']);
  assert.equal(done.json.changes[0].status, 'merged');

  const usage = await invokeCli(['set-status', '--run', 'quick-1', '--domain', domain, 'merged'], { cwd: root });
  assert.equal(usage.code, 2);
  const missing = await invokeCli(['set-status', '--run', 'quick-1'], { cwd: root });
  assert.equal(missing.code, 2);
  const violation = await invokeCli(['set-status', '--run', 'quick-1', '--status', 'discarded'], { cwd: root });
  assert.equal(violation.code, 1);
  assert.match(violation.err, /step 1 is merged/);
});

test('nos set-status --run needs the holder token while the run file exists', async (t) => {
  const { root, roots } = makeProject(t);
  const { folder: domain } = createDomain(roots, { idea: '# A', slug: 'a' });
  createQuickStep(roots, { domain, step: { slug: 'fix', intent: 'fix' } });
  setStatus(roots, { domain, step: '1', status: 'done' });
  writeRun(roots, { kind: 'quick', id: 1, domain, token: 'aaaa1111', phase: 'develop' });

  const missing = await invokeCli(['set-status', '--run', 'quick-1', 'merged'], { cwd: root });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /--token required/);
  const other = await invokeCli(['set-status', '--run', 'quick-1', 'merged', '--token', 'bbbb2222'], { cwd: root });
  assert.equal(other.code, 4);
  assert.doesNotMatch(other.out, /aaaa1111/);
  const env = await invokeCli(['set-status', '--run', 'quick-1', 'merged'], { cwd: root, env: { NOS_RUN_TOKEN: 'aaaa1111' } });
  assert.equal(env.code, 0, env.err);
  assert.equal(env.json.changes[0].status, 'merged');
});
