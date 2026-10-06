import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { createPlan } from '../src/plan.js';
import { NosError } from '../src/exit-codes.js';
import { updatePlan } from '../src/update-plan.js';
import { makeRoots, readJson, writeFile } from './helpers.js';

const step = (slug) => ({ slug, intent: slug, status: 'open', description: '', 'spec-file': '' });
const phase = (slug, steps) => ({ slug, name: slug, status: 'open', intent: '', description: '', steps });

// domain-1-auth with phase-1-data-model (step-1-user-table, step-2-hashing) and phase-2-login-api (step-3-endpoint)
function setup(t) {
  const roots = makeRoots(t);
  const { folder: domain } = createDomain(roots, { idea: '# Auth', slug: 'auth' });
  createPlan(roots, {
    domain,
    plan: {
      name: 'Auth',
      status: 'open',
      labels: [],
      phases: [phase('data-model', [step('user-table'), step('hashing')]), phase('login-api', [step('endpoint')])],
    },
  });
  const phasesDir = path.join(roots.specs, domain, 'phases');
  return {
    roots,
    domain,
    phasesDir,
    current: () => readJson(roots.specs, `${domain}/plan.json`),
    tree: () =>
      Object.fromEntries(readdirSync(phasesDir).sort().map((f) => [f, readdirSync(path.join(phasesDir, f)).sort()])),
  };
}

test('an unchanged plan changes nothing on disk', (t) => {
  const { roots, domain, current, tree } = setup(t);
  const before = tree();

  const result = updatePlan(roots, { domain, plan: current() });

  assert.deepEqual(tree(), before);
  assert.deepEqual(result.created, { phases: [], steps: [] });
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.deleted, { phases: [], steps: [] });
  assert.deepEqual(readJson(roots.specs, 'config.json')['id-counters'], { domain: 2, phase: 3, step: 4 });
});

test('creates new phases and steps with new ids and fills their spec-file', (t) => {
  const { roots, domain, phasesDir, current, tree } = setup(t);
  const plan = current();
  plan.phases[0].steps.push(step('indexes'));
  plan.phases.push(phase('sessions', [step('session-store'), step('expiry')]));

  const result = updatePlan(roots, { domain, plan });

  assert.deepEqual(tree(), {
    'phase-1-data-model': ['step-1-user-table.md', 'step-2-hashing.md', 'step-4-indexes.md'],
    'phase-2-login-api': ['step-3-endpoint.md'],
    'phase-3-sessions': ['step-5-session-store.md', 'step-6-expiry.md'],
  });
  assert.deepEqual(result.created.phases, [{ id: 3, folder: 'phase-3-sessions', path: path.join(phasesDir, 'phase-3-sessions') }]);
  assert.equal(result.created.steps[0].specFile, `${domain}/phases/phase-1-data-model/step-4-indexes.md`);
  assert.deepEqual(result.created.steps.map((s) => s.id), [4, 5, 6]);
  const saved = current();
  assert.equal(saved.phases[0].steps[2]['spec-file'], `${domain}/phases/phase-1-data-model/step-4-indexes.md`);
  assert.equal(saved.phases[2].steps[1]['spec-file'], `${domain}/phases/phase-3-sessions/step-6-expiry.md`);
  assert.deepEqual(readJson(roots.specs, 'config.json')['id-counters'], { domain: 2, phase: 4, step: 7 });
});

test('deletes empty step files and phase folders that are no longer in the plan', (t) => {
  const { roots, domain, current, tree } = setup(t);
  const plan = current();
  plan.phases[0].steps.splice(1, 1);
  plan.phases.splice(1, 1);

  const result = updatePlan(roots, { domain, plan });

  assert.deepEqual(tree(), { 'phase-1-data-model': ['step-1-user-table.md'] });
  assert.deepEqual(result.deleted.phases.map((p) => p.folder), ['phase-2-login-api']);
  assert.deepEqual(result.deleted.steps.map((s) => s.id).sort(), [2, 3]);
});

test('moves a kept step to another phase and renames it, keeping id and content', (t) => {
  const { roots, domain, phasesDir, current, tree } = setup(t);
  writeFile(roots.specs, `${domain}/phases/phase-1-data-model/step-2-hashing.md`, '# Hashing spec');
  const plan = current();
  const [hashing] = plan.phases[0].steps.splice(1, 1);
  hashing.slug = 'password-hashing';
  plan.phases[1].steps.push(hashing);

  const result = updatePlan(roots, { domain, plan });

  assert.deepEqual(tree(), {
    'phase-1-data-model': ['step-1-user-table.md'],
    'phase-2-login-api': ['step-2-password-hashing.md', 'step-3-endpoint.md'],
  });
  assert.equal(readFileSync(path.join(phasesDir, 'phase-2-login-api', 'step-2-password-hashing.md'), 'utf8'), '# Hashing spec');
  assert.deepEqual(result.moved, [{
    id: 2,
    from: path.join(phasesDir, 'phase-1-data-model', 'step-2-hashing.md'),
    to: path.join(phasesDir, 'phase-2-login-api', 'step-2-password-hashing.md'),
    specFile: `${domain}/phases/phase-2-login-api/step-2-password-hashing.md`,
  }]);
  assert.equal(current().phases[1].steps[1]['spec-file'], result.moved[0].specFile);
  assert.deepEqual(result.deleted, { phases: [], steps: [] });
});

test('a renamed phase slug replaces the phase and its kept steps move into the new folder', (t) => {
  const { roots, domain, current, tree } = setup(t);
  const plan = current();
  plan.phases[1].slug = 'login';

  const result = updatePlan(roots, { domain, plan });

  assert.deepEqual(tree(), {
    'phase-1-data-model': ['step-1-user-table.md', 'step-2-hashing.md'],
    'phase-3-login': ['step-3-endpoint.md'],
  });
  assert.deepEqual(result.deleted.phases.map((p) => p.folder), ['phase-2-login-api']);
  assert.equal(result.moved[0].specFile, `${domain}/phases/phase-3-login/step-3-endpoint.md`);
});

test('refuses to delete files with content unless forced', (t) => {
  const { roots, domain, phasesDir, current, tree } = setup(t);
  writeFile(roots.specs, `${domain}/phases/phase-2-login-api/step-3-endpoint.md`, '# Endpoint spec');
  const plan = current();
  plan.phases.splice(1, 1);
  const before = tree();
  const planBefore = current();

  assert.throws(() => updatePlan(roots, { domain, plan }), /delete files with content: .*step-3-endpoint\.md.*--force/);
  assert.deepEqual(tree(), before);
  assert.deepEqual(current(), planBefore);

  updatePlan(roots, { domain, plan, force: true });
  assert.equal(existsSync(path.join(phasesDir, 'phase-2-login-api')), false);
});

test('treats other files in a removed phase folder as content', (t) => {
  const { roots, domain, current } = setup(t);
  writeFile(roots.specs, `${domain}/phases/phase-2-login-api/notes.md`, 'notes');
  const plan = current();
  plan.phases.splice(1, 1);

  assert.throws(() => updatePlan(roots, { domain, plan }), /phase-2-login-api\/notes\.md/);
});

test('--dry-run reports the changes with the ids that would be used, without writing', (t) => {
  const { roots, domain, phasesDir, current, tree } = setup(t);
  const plan = current();
  plan.phases[1].steps = [step('logout')];
  const before = tree();
  const configBefore = readJson(roots.specs, 'config.json');

  const result = updatePlan(roots, { domain, plan, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.created.steps, [
    { id: 4, path: path.join(phasesDir, 'phase-2-login-api', 'step-4-logout.md'), specFile: `${domain}/phases/phase-2-login-api/step-4-logout.md` },
  ]);
  assert.deepEqual(result.deleted.steps.map((s) => s.id), [3]);
  assert.deepEqual(tree(), before);
  assert.deepEqual(readJson(roots.specs, 'config.json'), configBefore);
  assert.equal(current().phases[1].steps[0].slug, 'endpoint');
});

test('rejects invalid updates before changing anything', (t) => {
  const { roots, domain, current, tree } = setup(t);
  const before = tree();
  const configBefore = readJson(roots.specs, 'config.json');
  const reject = (edit, pattern) => {
    const plan = current();
    edit(plan);
    assert.throws(() => updatePlan(roots, { domain, plan }), pattern);
  };

  reject((p) => (p.phases[0].steps[0]['spec-file'] = 'other/step-9-x.md'), /not a step file of domain-1-auth/);
  reject((p) => p.phases[1].steps.push({ ...p.phases[0].steps[0] }), /used by more than one step/);
  reject((p) => p.phases.push(phase('data-model', [step('x')])), /phase slug "data-model" is used twice/i);
  reject((p) => (p.phases[0].steps = []), /has no steps/);
  reject((p) => (p.phases[0].slug = 'Bad Slug'), /invalid slug/i);

  assert.deepEqual(tree(), before);
  assert.deepEqual(readJson(roots.specs, 'config.json'), configBefore);
});

test('requires an existing plan.json and the inputs', (t) => {
  const { roots, domain } = setup(t);
  const { folder: unplanned } = createDomain(roots, { idea: '# Other', slug: 'other' });
  assert.throws(() => updatePlan(roots, { domain: unplanned, plan: { phases: [phase('p', [step('s')])] } }), /no plan\.json. Run create-plan first/);
  assert.throws(() => updatePlan(roots, { domain }), /missing input: plan. update-plan/i);
  assert.throws(() => updatePlan(roots, { plan: {} }), /missing input: domain. update-plan/i);
});

test('refuses a legacy spec-file with the specs/ prefix: run the migration', (t) => {
  const { roots, domain, current, tree } = setup(t);
  const before = tree();
  const plan = current();
  plan.phases[0].steps[0]['spec-file'] = `specs/${plan.phases[0].steps[0]['spec-file']}`;

  assert.throws(() => updatePlan(roots, { domain, plan }), (err) => err instanceof NosError && /legacy spec-file.*migration/.test(err.message));
  assert.deepEqual(tree(), before);
});

test('keeps branch always and statuses left out of the update; other fields follow the update', (t) => {
  const { roots, domain, current } = setup(t);
  const plan = current();
  plan.branch = 'plan-1';
  plan.status = 'in-progress';
  plan['review-needed'] = true;
  plan.phases[0].status = 'implemented';
  plan.phases[0].steps[0].status = 'done';
  plan.phases[0].steps[0].owner = 'x';
  writeFile(roots.specs, `${domain}/plan.json`, plan);

  // an extend that rebuilt the plan: no branch / status / review-needed, a kept step without status and owner, a new step
  const update = {
    name: 'Auth v2',
    branch: 'other',
    phases: [
      {
        slug: 'data-model',
        name: 'Data model',
        steps: [{ slug: 'user-table', 'spec-file': plan.phases[0].steps[0]['spec-file'] }, plan.phases[0].steps[1]],
      },
      { ...plan.phases[1], steps: [...plan.phases[1].steps, step('logout')] },
    ],
  };
  updatePlan(roots, { domain, plan: update });

  const saved = current();
  assert.equal(saved.branch, 'plan-1', 'branch is written by run start only');
  assert.equal(saved.name, 'Auth v2', 'a given field wins');
  assert.equal(saved.status, 'in-progress');
  assert.equal(Object.hasOwn(saved, 'review-needed'), false, 'not a status: follows the update');
  assert.equal(saved.phases[0].status, 'implemented');
  assert.equal(saved.phases[0].name, 'Data model');
  assert.equal(saved.phases[0].steps[0].status, 'done');
  assert.equal(Object.hasOwn(saved.phases[0].steps[0], 'owner'), false);
  assert.equal(Object.hasOwn(saved.phases[0].steps[0], 'intent'), false);
  assert.equal(saved.phases[1].steps[1].slug, 'logout');
  assert.equal(saved.phases[1].steps[1].status, 'open');
});

test('a plan without branch gets none', (t) => {
  const { roots, domain, current } = setup(t);
  updatePlan(roots, { domain, plan: current() });
  assert.equal(Object.hasOwn(current(), 'branch'), false);
});
