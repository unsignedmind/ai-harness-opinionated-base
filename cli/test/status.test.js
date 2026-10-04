import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { createPlan } from '../src/plan.js';
import { createQuickStep } from '../src/quick-step.js';
import { readValidStatuses, setStatus, STATUS_FILE_PATH } from '../src/status.js';
import { makeTempRoot, readJson, writeFile, STATUS_XML } from './helpers.js';

const step = (slug) => ({ slug, intent: slug, status: 'open', description: '', 'spec-file': '' });
const phase = (slug, steps) => ({ slug, name: slug, status: 'open', intent: '', description: '', steps });

function setup(t, plan) {
  const root = makeTempRoot(t);
  writeFile(root, STATUS_FILE_PATH, STATUS_XML);
  const { folder: domain } = createDomain(root, { idea: '# Auth', slug: 'auth' });
  createPlan(root, {
    domain,
    plan: plan ?? {
      name: 'Auth',
      status: 'open',
      labels: ['backend'],
      phases: [phase('data-model', [step('user-table'), step('hashing')]), phase('login-api', [step('endpoint')])],
    },
  });
  const read = () => readJson(root, `specs/${domain}/plan.json`);
  return { root, domain, read };
}

test('reads plan, phase and step statuses from status.xml', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, STATUS_FILE_PATH, STATUS_XML);
  assert.deepEqual(readValidStatuses(root), {
    plans: ['open', 'in-progress', 'done'],
    phases: ['open', 'implemented', 'in-review'],
    steps: ['open', 'in-specification', 'specified', 'implemented', 'in-review'],
  });
});

test('step-only statuses are valid for steps but not for phases', (t) => {
  const { root, domain, read } = setup(t);

  setStatus(root, { domain, step: '1', status: 'specified' });

  assert.equal(read().phases[0].steps[0].status, 'specified');
  assert.throws(() => setStatus(root, { domain, phase: '1', status: 'specified' }), /for a phase.*open, implemented, in-review/i);
  assert.equal(read().phases[0].status, 'open');
});

test('sets the plan status when only --domain is given', (t) => {
  const { root, domain, read } = setup(t);

  const result = setStatus(root, { domain, status: 'in-progress' });

  assert.equal(result.target, 'plan');
  assert.equal(result.previous, 'open');
  assert.equal(read().status, 'in-progress');
  assert.equal(read().phases[0].status, 'open');
});

test('sets a phase status by phase id', (t) => {
  const { root, domain, read } = setup(t);

  const result = setStatus(root, { domain, phase: '2', status: 'in-review' });

  assert.deepEqual([result.target, result.id, result.slug], ['phase', 2, 'login-api']);
  assert.equal(read().phases[1].status, 'in-review');
  assert.equal(read().phases[0].status, 'open');
  assert.equal(read().status, 'open');
});

test('sets a step status by step id, with or without its phase', (t) => {
  const { root, domain, read } = setup(t);

  setStatus(root, { domain, step: '2', status: 'implemented' });
  setStatus(root, { domain, phase: '2', step: '3', status: 'in-review' });

  const saved = read();
  assert.deepEqual(saved.phases[0].steps.map((s) => s.status), ['open', 'implemented']);
  assert.equal(saved.phases[1].steps[0].status, 'in-review');
  assert.equal(saved.phases[1].status, 'open');
});

test('keeps the rest of plan.json unchanged', (t) => {
  const { root, domain, read } = setup(t);
  const before = read();

  setStatus(root, { domain, step: '1', status: 'implemented' });

  const after = read();
  after.phases[0].steps[0].status = 'open';
  assert.deepEqual(after, before);
});

test('works with the template shape where phases and steps are single objects', (t) => {
  const { root, domain, read } = setup(t, { name: 'x', status: 'open', phases: phase('only', step('one')) });

  setStatus(root, { domain, phase: '1', status: 'implemented' });
  setStatus(root, { domain, step: '1', status: 'in-review' });

  assert.equal(read().phases.status, 'implemented');
  assert.equal(read().phases.steps.status, 'in-review');
});

test('rejects statuses not valid for the target category', (t) => {
  const { root, domain, read } = setup(t);
  const before = readFileSync(path.join(root, `specs/${domain}/plan.json`), 'utf8');

  assert.throws(() => setStatus(root, { domain, status: 'implemented' }), /invalid status "implemented" for a plan.*open, in-progress, done/i);
  assert.throws(() => setStatus(root, { domain, step: '1', status: 'done' }), /for a step.*open, in-specification, specified, implemented, in-review/i);
  assert.throws(() => setStatus(root, { domain, phase: '1', status: 'In-Review' }), /invalid status/i);

  assert.equal(readFileSync(path.join(root, `specs/${domain}/plan.json`), 'utf8'), before);
  assert.equal(read().status, 'open');
});

test('rejects unknown or mismatched ids', (t) => {
  const { root, domain } = setup(t);
  assert.throws(() => setStatus(root, { domain, phase: '9', status: 'open' }), /phase 9 is not in this plan/i);
  assert.throws(() => setStatus(root, { domain, step: '9', status: 'open' }), /step 9 is not in this plan/i);
  assert.throws(() => setStatus(root, { domain, phase: '1', step: '3', status: 'open' }), /step 3 is not in phase 1/i);
  assert.throws(() => setStatus(root, { domain, step: 'abc', status: 'open' }), /invalid step id "abc"/i);
  assert.throws(() => setStatus(root, { domain, phase: '0', status: 'open' }), /invalid phase id "0"/i);
});

test('rejects missing inputs, domains without a plan and a missing status.xml', (t) => {
  const { root, domain } = setup(t);
  assert.throws(() => setStatus(root, { domain }), /missing input: status/i);
  assert.throws(() => setStatus(root, { status: 'open' }), /missing input: domain. set-status/i);

  const { folder: unplanned } = createDomain(root, { idea: '# Other', slug: 'other' });
  assert.throws(() => setStatus(root, { domain: unplanned, status: 'open' }), /has no plan\.json/);

  const bare = makeTempRoot(t);
  createDomain(bare, { idea: '# X', slug: 'x' });
  assert.throws(() => setStatus(bare, { domain: 'domain-1-x', status: 'open' }), /missing .*status\.xml/i);
});

test('sets the status of a quick step, also in a domain without plan.json', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, STATUS_FILE_PATH, STATUS_XML);
  const { folder: domain } = createDomain(root, { idea: '# Auth', slug: 'auth' });
  createQuickStep(root, { domain, step: { slug: 'fix-typo', intent: 'Fix' } });

  const result = setStatus(root, { domain, step: '1', status: 'specified' });

  assert.deepEqual(
    [result.target, result.id, result.slug, result.previous, result.status, result.quick],
    ['step', 1, 'fix-typo', 'open', 'specified', true],
  );
  assert.equal(result.planPath, path.join(root, 'specs', domain, 'quick-steps', 'quick-steps.json'));
  assert.equal(readJson(root, `specs/${domain}/quick-steps/quick-steps.json`)[0].status, 'specified');
  assert.throws(() => setStatus(root, { domain, step: '9', status: 'open' }), /not a quick step.*no plan\.json/i);
  assert.throws(() => setStatus(root, { domain, status: 'open' }), /has no plan\.json/);
});

test('plan steps and quick steps of one domain are told apart by id', (t) => {
  const { root, domain, read } = setup(t);
  createQuickStep(root, { domain, step: { slug: 'quick', intent: 'Quick' } });

  setStatus(root, { domain, step: '4', status: 'implemented' });
  setStatus(root, { domain, step: '1', status: 'specified' });

  assert.equal(readJson(root, `specs/${domain}/quick-steps/quick-steps.json`)[0].status, 'implemented');
  assert.equal(read().phases[0].steps[0].status, 'specified');
  assert.throws(() => setStatus(root, { domain, phase: '1', step: '4', status: 'open' }), /step 4 is not in phase 1/i);
});
