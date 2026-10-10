import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDomain } from '../src/domain.js';
import { resolveDependencies, validateDependencies } from '../src/dependencies.js';
import { createPlan, validatePlan } from '../src/plan.js';
import { computeReady, planReady } from '../src/ready.js';
import { setStatus } from '../src/status.js';
import { updatePlan } from '../src/update-plan.js';
import { makeRoots, readJson, writeFile, STATUS_XML } from './helpers.js';

const step = (slug, deps, status = 'open', specFile = '') => ({
  slug,
  intent: slug,
  status,
  description: '',
  'spec-file': specFile,
  ...(deps !== undefined && { 'depends-on': deps }),
});
const phase = (slug, steps, status = 'open') => ({ slug, name: slug, status, intent: '', description: '', steps });
const plan = (phases, checked = true) => ({ name: 'P', status: 'open', 'dependencies-checked': checked, phases });

// ---- validation

test('a plan with dependencies-checked false ignores depends-on entirely', () => {
  const p = plan([phase('a', [step('x'), step('y', ['nope'])])], false);
  assert.doesNotThrow(() => validatePlan(p));
});

test('dependencies-checked true: every step needs a depends-on list', () => {
  const p = plan([phase('a', [step('x', []), step('y')])]);
  assert.throws(() => validatePlan(p), /step "y" in phase "a" has no "depends-on" list/);
});

test('refs resolve to a step of the same phase or an earlier phase', () => {
  const ok = plan([phase('a', [step('x', []), step('y', ['x'])]), phase('b', [step('z', ['a/x'])])]);
  assert.doesNotThrow(() => validatePlan(ok));
  assert.throws(() => validatePlan(plan([phase('a', [step('x', ['gone'])])])), /no step "gone" in phase "a"/);
  assert.throws(() => validatePlan(plan([phase('a', [step('x', ['b/z'])]), phase('b', [step('z', [])])])), /a later phase/);
  assert.throws(() => validatePlan(plan([phase('a', [step('x', ['c/z'])])])), /no phase "c"/);
  assert.throws(() => validatePlan(plan([phase('a', [step('x', ['a/x'])])])), /its own phase/);
  assert.throws(() => validatePlan(plan([phase('a', [step('x', ['x'])])])), /depends on itself/);
  assert.throws(() => validatePlan(plan([phase('a', [step('x', ['a/b/c'])])])), /Invalid dependency ref/);
});

test('step slugs must be unique inside a phase, phase slugs across the plan', () => {
  assert.throws(() => validatePlan(plan([phase('a', [step('x', []), step('x', [])])])), /used twice in phase "a"/);
  assert.throws(() => validatePlan(plan([phase('a', [step('x', [])]), phase('a', [step('y', [])])])), /Phase slug "a" is used twice/);
  // unique phase slugs also without the flag
  assert.throws(() => validateDependencies({}, [phase('a', [step('x')]), phase('a', [step('y')])]), /used twice/);
});

test('a cycle inside a phase is rejected, naming the steps', () => {
  const p = plan([phase('a', [step('x', ['z']), step('y', ['x']), step('z', ['y']), step('w', [])])]);
  assert.throws(() => validatePlan(p), /Dependency cycle in phase "a" between steps: x, y, z/);
});

test('resolveDependencies marks cross-phase refs', () => {
  const resolved = resolveDependencies([phase('a', [step('x', [])]), phase('b', [step('y', ['a/x']), step('z', ['y'])])]);
  assert.deepEqual(
    resolved.map((r) => [r.phase.slug, r.step.slug, r.deps]),
    [
      ['a', 'x', []],
      ['b', 'y', [{ phaseIndex: 0, stepIndex: 0, crossPhase: true }]],
      ['b', 'z', [{ phaseIndex: 1, stepIndex: 0, crossPhase: false }]],
    ],
  );
});

// ---- ready (pure)

const spec = (p, s, slug) => `domain-1-d/phases/phase-${p}-p/step-${s}-${slug}.md`;
const ids = (entries) => entries.map((e) => e.id);

function sample() {
  // phase 1: contracts (step 1); phase 2: a (2), b (3), c depends on a (4); phase 3: d (5) depends on 2/a only
  return plan([
    phase('contracts', [step('types', [], 'open', spec(1, 1, 'types'))]),
    phase('features', [
      step('a', [], 'open', spec(2, 2, 'a')),
      step('b', [], 'open', spec(2, 3, 'b')),
      step('c', ['a'], 'open', spec(2, 4, 'c')),
    ]),
    phase('polish', [step('d', ['features/a'], 'open', spec(3, 5, 'd'))]),
  ]);
}

test('ready: only the first phase is ready while the barrier holds', () => {
  const r = computeReady(sample());
  assert.equal(r.mode, 'dependencies');
  assert.deepEqual(ids(r.specify), [1]);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.waitsOn, b.waitsOnPhases]), [
    [2, [], [1]],
    [3, [], [1]],
    [4, [2], [1]],
    [5, [2], []],
  ]);
  assert.equal(r.done, false);
});

test('ready: after the contracts phase, independent steps are ready together; the cross-phase step waits on its step only', () => {
  const p = sample();
  p.phases[0].steps[0].status = 'done';
  p.phases[0].status = 'done';
  let r = computeReady(p);
  assert.deepEqual(ids(r.specify), [2, 3]);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.waitsOn]), [[4, [2]], [5, [2]]]);

  p.phases[1].steps[0].status = 'done'; // a done, phase 2 not done
  r = computeReady(p);
  assert.deepEqual(ids(r.specify), [3, 4, 5]);
});

test('ready: a started step is not re-gated when a phase is inserted in front of it', () => {
  const p = sample();
  p.phases[0].steps[0].status = 'done';
  p.phases[1].steps[0].status = 'specified';
  p.phases.splice(1, 0, phase('fix', [step('fix1', [], 'open', spec(9, 9, 'fix1'))]));
  const r = computeReady(p);
  assert.deepEqual(ids(r.develop), [2]);
  assert.deepEqual(ids(r.specify), [9]);
  assert.deepEqual(r.blocked.map((b) => b.id), [3, 4, 5]);
});

test('ready: running, continue, phasesReviewable and phasesContinuing', () => {
  const p = sample();
  p.phases[0].steps[0].status = 'done';
  p.phases[0].status = 'in-progress';
  p.phases[1].steps[0].status = 'in-progress';
  p.phases[1].steps[1].status = 'implemented';
  p.phases[1].status = 'in-progress';
  const r = computeReady(p);
  assert.deepEqual(ids(r.running), [2]);
  assert.deepEqual(ids(r.continue), [3]);
  assert.deepEqual(r.phasesReviewable.map((x) => x.id), [1]);
  p.phases[0].status = 'in-review';
  assert.deepEqual(computeReady(p).phasesContinuing.map((x) => x.id), [1]);
});

test('ready: dependencies-checked false is sequential, as before', () => {
  const p = sample();
  p['dependencies-checked'] = false;
  p.phases[0].steps[0].status = 'done';
  p.phases[1].steps[0].status = 'specified';
  const r = computeReady(p);
  assert.equal(r.mode, 'sequential');
  assert.deepEqual(ids(r.develop), [2]);
  assert.deepEqual(r.blocked.map((b) => [b.id, b.waitsOn]), [[3, [2]], [4, [3]], [5, [4]]]);
});

test('ready: done when everything is finished', () => {
  const p = sample();
  for (const ph of p.phases) {
    ph.status = 'done';
    for (const s of ph.steps) s.status = 'done';
  }
  assert.equal(computeReady(p).done, true);
});

// ---- on disk: create-plan, update-plan, set-status, nos ready

function setup(t) {
  const roots = makeRoots(t);
  writeFile(roots.home, 'templates/status.xml', STATUS_XML);
  const { folder: domain } = createDomain(roots, { idea: '# D', slug: 'd' });
  return { roots, domain, current: () => readJson(roots.specs, `${domain}/plan.json`) };
}

test('create-plan keeps the flag and depends-on; appending phases resets the flag', (t) => {
  const { roots, domain, current } = setup(t);
  createPlan(roots, { domain, plan: plan([phase('a', [step('x', []), step('y', ['x'])])]) });
  assert.equal(current()['dependencies-checked'], true);
  assert.deepEqual(current().phases[0].steps[1]['depends-on'], ['x']);

  writeFile(roots.specs, `${domain}/idea-more.md`, '# More');
  createPlan(roots, { domain, plan: { name: 'P', status: 'open', phases: [phase('b', [step('z')])] }, ideas: 'idea-more.md' });
  assert.equal(current()['dependencies-checked'], false);
  assert.equal(planReady(roots, { domain }).mode, 'sequential');
});

test('update-plan restores the flag before validating and keeps current statuses', (t) => {
  const { roots, domain, current } = setup(t);
  createPlan(roots, { domain, plan: plan([phase('a', [step('x', []), step('y', ['x'])])]) });
  setStatus(roots, { domain, step: '1', status: 'implemented' });

  // the plan ability drops the flag and submits stale statuses: the flag comes back, the statuses stay
  const submitted = current();
  delete submitted['dependencies-checked'];
  submitted.phases[0].steps[0].status = 'open';
  updatePlan(roots, { domain, plan: submitted });
  assert.equal(current()['dependencies-checked'], true);
  assert.equal(current().phases[0].steps[0].status, 'implemented');

  // with the flag restored, a new step without depends-on is rejected
  const broken = current();
  delete broken['dependencies-checked'];
  broken.phases[0].steps.push(step('z'));
  assert.throws(() => updatePlan(roots, { domain, plan: broken }), /step "z" in phase "a" has no "depends-on"/);

  // a dependency pass sets the flag on purpose
  const pass = current();
  pass['dependencies-checked'] = false;
  updatePlan(roots, { domain, plan: pass });
  assert.equal(current()['dependencies-checked'], false);
});

test('nos ready reads the plan of a domain', (t) => {
  const { roots, domain } = setup(t);
  createPlan(roots, { domain, plan: plan([phase('a', [step('x', []), step('y', ['x'])])]) });
  const r = planReady(roots, { domain });
  assert.equal(r.dependenciesChecked, true);
  assert.deepEqual(r.specify.map((e) => [e.id, e.slug, e.phase, e.phaseSlug]), [[1, 'x', 1, 'a']]);
  assert.deepEqual(r.blocked.map((e) => [e.id, e.waitsOn]), [[2, [1]]]);
  assert.throws(() => planReady(roots, { domain: 'domain-9-none' }), /does not exist/);
});
