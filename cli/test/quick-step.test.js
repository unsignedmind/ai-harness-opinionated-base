import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { createPlan } from '../src/plan.js';
import { createQuickStep } from '../src/quick-step.js';
import { makeTempRoot, readJson } from './helpers.js';

function setup(t) {
  const root = makeTempRoot(t);
  const { folder: domain } = createDomain(root, { idea: '# Auth', slug: 'auth' });
  return { root, domain };
}

test('creates the quick step file and quick-steps.json with a fresh step id', (t) => {
  const { root, domain } = setup(t);

  const result = createQuickStep(root, { domain, step: JSON.stringify({ slug: 'fix-typo', intent: 'Fix the typo' }) });

  assert.equal(result.id, 1);
  assert.equal(result.specFile, `specs/${domain}/quick-steps/step-1-fix-typo.md`);
  assert.equal(readFileSync(result.path, 'utf8'), '');
  assert.deepEqual(readJson(root, `specs/${domain}/quick-steps/quick-steps.json`), [
    {
      slug: 'fix-typo',
      intent: 'Fix the typo',
      'human-validation-needed': false,
      'review-needed': true,
      description: '',
      status: 'open',
      'spec-file': `specs/${domain}/quick-steps/step-1-fix-typo.md`,
    },
  ]);
  assert.equal(readJson(root, 'specs/config.json')['id-counters'].step, 2);
});

test('appends further quick steps, keeps given fields and always starts open', (t) => {
  const { root, domain } = setup(t);
  createQuickStep(root, { domain, step: { slug: 'one', intent: 'One' } });

  createQuickStep(root, { domain, step: { slug: 'two', intent: 'Two', status: 'done', 'review-needed': false, labels: ['ui'] } });

  const saved = readJson(root, `specs/${domain}/quick-steps/quick-steps.json`);
  assert.deepEqual(saved.map((s) => s.slug), ['one', 'two']);
  assert.equal(saved[1].status, 'open');
  assert.equal(saved[1]['review-needed'], false);
  assert.deepEqual(saved[1].labels, ['ui']);
  assert.equal(saved[1]['spec-file'], `specs/${domain}/quick-steps/step-2-two.md`);
});

test('shares the step counter with plan steps', (t) => {
  const { root, domain } = setup(t);
  createPlan(root, {
    domain,
    plan: { name: 'x', status: 'open', phases: [{ slug: 'p', steps: [{ slug: 'a' }, { slug: 'b' }] }] },
  });

  const { id } = createQuickStep(root, { domain, step: { slug: 'q', intent: 'Q' } });

  assert.equal(id, 3);
});

test('rejects missing or invalid input without writing anything', (t) => {
  const { root, domain } = setup(t);
  assert.throws(() => createQuickStep(root, { domain }), /missing input: step/i);
  assert.throws(() => createQuickStep(root, { domain, step: '{' }), /invalid quick step json/i);
  assert.throws(() => createQuickStep(root, { domain, step: '[]' }), /single json object/i);
  assert.throws(() => createQuickStep(root, { domain, step: { slug: 'Bad Slug', intent: 'x' } }), /invalid slug/i);
  assert.throws(() => createQuickStep(root, { domain, step: { slug: 'ok' } }), /missing input: intent/i);
  assert.throws(() => createQuickStep(root, { domain: 'domain-9-nope', step: { slug: 'ok', intent: 'x' } }), /does not exist/);

  assert.equal(existsSync(path.join(root, 'specs', domain, 'quick-steps')), false);
  assert.equal(readJson(root, 'specs/config.json')['id-counters'].step, 1);
});
