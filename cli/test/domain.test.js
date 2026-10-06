import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { makeRoots, readJson } from './helpers.js';

const IDEA = '# User Authentication\n\nUsers log in with email and password.\n';

test('creates specs, config and the first domain folder with idea.md', (t) => {
  const roots = makeRoots(t);

  const result = createDomain(roots, { idea: IDEA, slug: 'user-auth' });

  assert.equal(result.id, 1);
  assert.equal(result.folder, 'domain-1-user-auth');
  assert.equal(result.path, path.join(roots.specs, 'domain-1-user-auth'));
  assert.equal(readFileSync(path.join(result.path, 'idea.md'), 'utf8'), IDEA);
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].domain, 2);
});

test('saves domain.json with the name from the idea heading, no labels and not cross-cutting', (t) => {
  const roots = makeRoots(t);

  const result = createDomain(roots, { idea: '# Idea: Dark mode\n', slug: 'dark-mode' });

  assert.equal(result.domainFilePath, path.join(result.path, 'domain.json'));
  assert.deepEqual(readJson(roots.specs, 'domain-1-dark-mode/domain.json'), {
    name: 'Dark mode',
    labels: [],
    'cross-cutting': false,
  });
});

test('domain.json takes a given name and labels, the slug when the idea has no heading', (t) => {
  const roots = makeRoots(t);
  createDomain(roots, { idea: 'no heading', slug: 'user-auth', labels: ['auth', 'ui'] });
  createDomain(roots, { idea: IDEA, slug: 'named', name: 'Login', labels: 'a, b' });

  assert.deepEqual(readJson(roots.specs, 'domain-1-user-auth/domain.json').name, 'user auth');
  assert.deepEqual(readJson(roots.specs, 'domain-1-user-auth/domain.json').labels, ['auth', 'ui']);
  assert.deepEqual(readJson(roots.specs, 'domain-2-named/domain.json'), {
    name: 'Login',
    labels: ['a', 'b'],
    'cross-cutting': false,
  });
});

test('rejects an invalid label without consuming an id', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'x', labels: 'Bad Label' }), /invalid slug for label/i);
  assert.equal(existsSync(roots.specs), false);
});

test('assigns increasing ids to subsequent domains', (t) => {
  const roots = makeRoots(t);
  createDomain(roots, { idea: IDEA, slug: 'first' });

  const second = createDomain(roots, { idea: IDEA, slug: 'second' });

  assert.equal(second.folder, 'domain-2-second');
});

test('requires a slug and never derives one from the idea', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: IDEA }), /missing input: domain slug/i);
  assert.equal(existsSync(roots.specs), false);
});

test('rejects an invalid slug without consuming an id', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'User Auth!' }), /invalid slug/i);
  assert.equal(existsSync(roots.specs), false);
});

test('rejects a missing or blank idea without touching the filesystem', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: '   ', slug: 'x' }), /missing input: idea/i);
  assert.throws(() => createDomain(roots, { slug: 'x' }), /missing input: idea/i);
  assert.equal(existsSync(roots.specs), false);
});

test('refuses to overwrite an existing domain folder', (t) => {
  const roots = makeRoots(t);
  mkdirSync(path.join(roots.specs, 'domain-1-user-auth'), { recursive: true });
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'user-auth' }), /already exists/);
});
