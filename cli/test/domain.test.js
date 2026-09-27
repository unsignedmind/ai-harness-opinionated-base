import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createDomain } from '../src/domain.js';
import { makeTempRoot, readJson } from './helpers.js';

const IDEA = '# User Authentication\n\nUsers log in with email and password.\n';

test('creates specs, config and the first domain folder with idea.md', (t) => {
  const root = makeTempRoot(t);

  const result = createDomain(root, { idea: IDEA, slug: 'user-auth' });

  assert.equal(result.id, 1);
  assert.equal(result.folder, 'domain-1-user-auth');
  assert.equal(result.path, path.join(root, 'specs', 'domain-1-user-auth'));
  assert.equal(readFileSync(path.join(result.path, 'idea.md'), 'utf8'), IDEA);
  assert.equal(readJson(root, 'specs/config.json')['id-counters'].domain, 2);
});

test('assigns increasing ids to subsequent domains', (t) => {
  const root = makeTempRoot(t);
  createDomain(root, { idea: IDEA, slug: 'first' });

  const second = createDomain(root, { idea: IDEA, slug: 'second' });

  assert.equal(second.folder, 'domain-2-second');
});

test('requires a slug and never derives one from the idea', (t) => {
  const root = makeTempRoot(t);
  assert.throws(() => createDomain(root, { idea: IDEA }), /missing input: domain slug/i);
  assert.equal(existsSync(path.join(root, 'specs')), false);
});

test('rejects an invalid slug without consuming an id', (t) => {
  const root = makeTempRoot(t);
  assert.throws(() => createDomain(root, { idea: IDEA, slug: 'User Auth!' }), /invalid slug/i);
  assert.equal(existsSync(path.join(root, 'specs')), false);
});

test('rejects a missing or blank idea without touching the filesystem', (t) => {
  const root = makeTempRoot(t);
  assert.throws(() => createDomain(root, { idea: '   ', slug: 'x' }), /missing input: idea/i);
  assert.throws(() => createDomain(root, { slug: 'x' }), /missing input: idea/i);
  assert.equal(existsSync(path.join(root, 'specs')), false);
});

test('refuses to overwrite an existing domain folder', (t) => {
  const root = makeTempRoot(t);
  mkdirSync(path.join(root, 'specs', 'domain-1-user-auth'), { recursive: true });
  assert.throws(() => createDomain(root, { idea: IDEA, slug: 'user-auth' }), /already exists/);
});
