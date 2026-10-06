import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { createPlan, isHollowPlan } from '../src/plan.js';
import { makeRoots, readJson, writeFile, STATUS_XML } from './helpers.js';

const step = (slug, intent = slug) => ({ slug, intent, status: 'open', description: '', 'spec-file': '' });
const phase = (slug, steps, name = slug) => ({ slug, name, status: 'open', intent: '', description: '', steps });

function samplePlan() {
  return {
    name: 'Auth',
    status: 'open',
    labels: ['backend'],
    phases: [
      phase('data-model', [step('user-table'), step('password-hashing')], 'Data Model'),
      phase('login-api', [step('login-endpoint', 'Expose POST /login')], 'Login API'),
    ],
  };
}

function setup(t) {
  const roots = makeRoots(t);
  const { folder } = createDomain(roots, { idea: '# Auth', slug: 'auth' });
  return { roots, domain: folder, domainDir: path.join(roots.specs, folder) };
}

test('creates a phase folder per phase with an empty spec file per step', (t) => {
  const { roots, domain, domainDir } = setup(t);

  const result = createPlan(roots, { domain, plan: samplePlan() });

  const phasesDir = path.join(domainDir, 'phases');
  assert.deepEqual(readdirSync(phasesDir).sort(), ['phase-1-data-model', 'phase-2-login-api']);
  assert.deepEqual(readdirSync(path.join(phasesDir, 'phase-1-data-model')).sort(), [
    'step-1-user-table.md',
    'step-2-password-hashing.md',
  ]);
  assert.deepEqual(readdirSync(path.join(phasesDir, 'phase-2-login-api')), ['step-3-login-endpoint.md']);
  assert.equal(readFileSync(path.join(phasesDir, 'phase-2-login-api', 'step-3-login-endpoint.md'), 'utf8'), '');

  assert.equal(result.phases.length, 2);
  assert.equal(result.phases[0].folder, 'phase-1-data-model');
  assert.deepEqual(result.phases[0].steps.map((s) => s.id), [1, 2]);
});

test('uses the provided slugs, not names or intents', (t) => {
  const { roots, domain } = setup(t);
  const plan = { phases: [phase('p', [step('s', 'Something else entirely')], 'A Long Phase Name')] };

  const result = createPlan(roots, { domain, plan });

  assert.equal(result.phases[0].folder, 'phase-1-p');
  assert.equal(result.phases[0].steps[0].file, 'step-1-s.md');
});

test('advances phase and step counters in config.json', (t) => {
  const { roots, domain } = setup(t);

  createPlan(roots, { domain, plan: samplePlan() });

  assert.deepEqual(readJson(roots.specs, 'config.json')['id-counters'], { domain: 2, phase: 3, step: 4 });
});

test('continues numbering from existing counters across plans', (t) => {
  const { roots, domain } = setup(t);
  createPlan(roots, { domain, plan: samplePlan() });
  const { folder: other } = createDomain(roots, { idea: '# Other', slug: 'other' });

  const result = createPlan(roots, { domain: other, plan: samplePlan() });

  assert.equal(result.phases[0].folder, 'phase-3-data-model');
  assert.deepEqual(result.phases[1].steps.map((s) => s.file), ['step-6-login-endpoint.md']);
});

test('saves plan.json in the domain with spec-file paths filled in', (t) => {
  const { roots, domain } = setup(t);

  createPlan(roots, { domain, plan: samplePlan() });

  const saved = readJson(roots.specs, `${domain}/plan.json`);
  assert.equal(saved.name, 'Auth');
  assert.equal('labels' in saved, false, 'labels belong to domain.json');
  assert.equal(saved.phases[0].slug, 'data-model');
  assert.equal(
    saved.phases[0].steps[1]['spec-file'],
    `${domain}/phases/phase-1-data-model/step-2-password-hashing.md`,
  );
  assert.equal(saved.phases[1].steps[0]['spec-file'], `${domain}/phases/phase-2-login-api/step-3-login-endpoint.md`);
});

test('accepts the template shape where phases and steps are single objects', (t) => {
  const { roots, domain } = setup(t);
  const plan = { name: 'x', status: 'open', labels: [], phases: phase('only-phase', step('only-step')) };

  createPlan(roots, { domain, plan });

  const saved = readJson(roots.specs, `${domain}/plan.json`);
  assert.equal(Array.isArray(saved.phases), false);
  assert.equal(saved.phases.steps['spec-file'], `${domain}/phases/phase-1-only-phase/step-1-only-step.md`);
});

test('accepts the plan as a JSON string', (t) => {
  const { roots, domain } = setup(t);
  const result = createPlan(roots, { domain, plan: JSON.stringify(samplePlan()) });
  assert.equal(result.phases.length, 2);
});

test('rejects missing inputs', (t) => {
  const { roots, domain } = setup(t);
  assert.throws(() => createPlan(roots, { plan: samplePlan() }), /missing input: domain/i);
  assert.throws(() => createPlan(roots, { domain }), /missing input: plan/i);
});

test('rejects a domain that does not exist or is badly named', (t) => {
  const { roots } = setup(t);
  assert.throws(() => createPlan(roots, { domain: 'domain-9-nope', plan: samplePlan() }), /does not exist/);
  assert.throws(() => createPlan(roots, { domain: '../escape', plan: samplePlan() }), /domain-<id>-<slug>/);
});

test('rejects invalid plans before changing anything', (t) => {
  const { roots, domain, domainDir } = setup(t);
  const configBefore = readJson(roots.specs, 'config.json');
  const reject = (plan, pattern) => assert.throws(() => createPlan(roots, { domain, plan }), pattern);

  reject('{not json', /invalid plan json/i);
  reject({ name: 'x', phases: [] }, /at least one phase/i);
  reject({ phases: [phase('p', [])] }, /phase "p" has no steps/i);
  reject({ phases: [{ name: 'No Slug', steps: [step('a')] }] }, /missing input: slug of phase 1/i);
  reject({ phases: [phase('Bad Slug', [step('a')])] }, /invalid slug for slug of phase 1/i);
  reject({ phases: [phase('p', [step('ok'), { intent: 'x' }])] }, /missing input: slug of step 2 in phase "p"/i);

  assert.deepEqual(readJson(roots.specs, 'config.json'), configBefore);
  assert.equal(existsSync(path.join(domainDir, 'phases')), false);
  assert.equal(existsSync(path.join(domainDir, 'plan.json')), false);
});

test('refuses to plan a domain that already has a plan.json with phases', (t) => {
  const { roots, domain } = setup(t);
  writeFile(roots.specs, `${domain}/plan.json`, { name: 'Auth', phases: [{ slug: 'x', steps: [] }] });
  assert.throws(() => createPlan(roots, { domain, plan: samplePlan() }), /already has a plan\.json/);
});

test('refuses to plan over an empty plan.json when phase folders exist', (t) => {
  const { roots, domain } = setup(t);
  writeFile(roots.specs, `${domain}/plan.json`, { name: 'Auth', phases: [] });
  writeFile(roots.specs, `${domain}/phases/phase-1-old/step-1-a.md`, '');
  assert.throws(() => createPlan(roots, { domain, plan: samplePlan() }), /already has a plan\.json/);
});

// ── hollow plans ──

test('--hollow writes an empty open plan named after domain.json', (t) => {
  const { roots, domain, domainDir } = setup(t);
  writeFile(roots.specs, `${domain}/domain.json`, { name: 'User auth', labels: [], 'cross-cutting': false });
  writeFile(roots.home, 'templates/status.xml', STATUS_XML);

  const result = createPlan(roots, { domain, hollow: true });

  assert.deepEqual(readJson(roots.specs, `${domain}/plan.json`), { name: 'User auth', status: 'open', phases: [] });
  assert.deepEqual(result, { domain, planPath: path.join(domainDir, 'plan.json'), phases: [], hollow: true });
  assert.equal(existsSync(path.join(domainDir, 'phases')), false);
  assert.equal(isHollowPlan(domainDir), true);
});

test('--hollow falls back to the idea heading for the name, without status.xml to open', (t) => {
  const roots = makeRoots(t);
  const { folder } = createDomain(roots, { idea: '# Idea: Dark mode\n\ntext', slug: 'dark-mode' });
  writeFile(roots.specs, `${folder}/domain.json`, { labels: [] });
  createPlan(roots, { domain: folder, hollow: true });
  assert.deepEqual(readJson(roots.specs, `${folder}/plan.json`), { name: 'Dark mode', status: 'open', phases: [] });
});

test('--hollow refuses an existing plan.json and a plan input', (t) => {
  const { roots, domain } = setup(t);
  assert.throws(() => createPlan(roots, { domain, hollow: true, plan: samplePlan() }), /takes no plan/);
  createPlan(roots, { domain, hollow: true });
  assert.throws(() => createPlan(roots, { domain, hollow: true }), /already has a plan\.json/);
});

test('create-plan fills a hollow plan', (t) => {
  const { roots, domain, domainDir } = setup(t);
  createPlan(roots, { domain, hollow: true });

  const result = createPlan(roots, { domain, plan: samplePlan() });

  assert.deepEqual(readdirSync(path.join(domainDir, 'phases')).sort(), ['phase-1-data-model', 'phase-2-login-api']);
  assert.equal(readJson(roots.specs, `${domain}/plan.json`).phases.length, 2);
  assert.equal(result.phases.length, 2);
  assert.equal(isHollowPlan(domainDir), false);
});
