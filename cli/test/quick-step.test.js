import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { createPlan } from '../src/plan.js';
import { createQuickStep, quickStepId } from '../src/quick-step.js';
import { makeRoots, readJson } from './helpers.js';

function setup(t) {
  const roots = makeRoots(t);
  const { folder: domain } = createDomain(roots, { idea: '# Auth', slug: 'auth' });
  return { roots, domain };
}

test('creates the quick step file and quick-steps.json with a fresh step id', (t) => {
  const { roots, domain } = setup(t);

  const result = createQuickStep(roots, { domain, step: JSON.stringify({ slug: 'fix-typo', intent: 'Fix the typo' }) });

  assert.equal(result.id, 1);
  assert.equal(result.specFile, `${domain}/quick-steps/step-1-fix-typo.md`);
  assert.equal(readFileSync(result.path, 'utf8'), '');
  assert.deepEqual(readJson(roots.specs, `${domain}/quick-steps/quick-steps.json`), [
    {
      slug: 'fix-typo',
      intent: 'Fix the typo',
      'human-validation-needed': false,
      'review-needed': true,
      description: '',
      status: 'open',
      'spec-file': `${domain}/quick-steps/step-1-fix-typo.md`,
    },
  ]);
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].step, 2);
});

test('appends further quick steps, keeps given fields and always starts open', (t) => {
  const { roots, domain } = setup(t);
  createQuickStep(roots, { domain, step: { slug: 'one', intent: 'One' } });

  createQuickStep(roots, { domain, step: { slug: 'two', intent: 'Two', status: 'done', 'review-needed': false, labels: ['ui'] } });

  const saved = readJson(roots.specs, `${domain}/quick-steps/quick-steps.json`);
  assert.deepEqual(saved.map((s) => s.slug), ['one', 'two']);
  assert.equal(saved[1].status, 'open');
  assert.equal(saved[1]['review-needed'], false);
  assert.deepEqual(saved[1].labels, ['ui']);
  assert.equal(saved[1]['spec-file'], `${domain}/quick-steps/step-2-two.md`);
});

test('shares the step counter with plan steps', (t) => {
  const { roots, domain } = setup(t);
  createPlan(roots, {
    domain,
    plan: { name: 'x', status: 'open', phases: [{ slug: 'p', steps: [{ slug: 'a' }, { slug: 'b' }] }] },
  });

  const { id } = createQuickStep(roots, { domain, step: { slug: 'q', intent: 'Q' } });

  assert.equal(id, 3);
});

test('rejects missing or invalid input without writing anything', (t) => {
  const { roots, domain } = setup(t);
  assert.throws(() => createQuickStep(roots, { domain }), /missing input: step/i);
  assert.throws(() => createQuickStep(roots, { domain, step: '{' }), /invalid quick step json/i);
  assert.throws(() => createQuickStep(roots, { domain, step: '[]' }), /single json object/i);
  assert.throws(() => createQuickStep(roots, { domain, step: { slug: 'Bad Slug', intent: 'x' } }), /invalid slug/i);
  assert.throws(() => createQuickStep(roots, { domain, step: { slug: 'ok' } }), /missing input: intent/i);
  assert.throws(() => createQuickStep(roots, { domain: 'domain-9-nope', step: { slug: 'ok', intent: 'x' } }), /does not exist/);

  assert.equal(existsSync(path.join(roots.specs, domain, 'quick-steps')), false);
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].step, 1);
});

test('quickStepId reads the id from a spec-file relative to the specs root, refuses the legacy prefix', () => {
  assert.equal(quickStepId({ 'spec-file': 'domain-1-auth/quick-steps/step-12-fix-typo.md' }), 12);
  assert.equal(quickStepId({ 'spec-file': 'domain-1-auth/phases/phase-1-a/step-3-b.md' }), undefined);
  assert.equal(quickStepId({}), undefined);
  assert.throws(() => quickStepId({ 'spec-file': 'specs/domain-1-auth/quick-steps/step-12-fix-typo.md' }), /legacy spec-file.*migration/);
});
