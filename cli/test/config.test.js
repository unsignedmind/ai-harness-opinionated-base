import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensureSpecs, reserveIds, DEFAULT_CONFIG, TEMPLATE_CONFIG_PATH } from '../src/config.js';
import { makeTempRoot, writeFile, readJson } from './helpers.js';

test('creates specs folder and config.json from built-in default', (t) => {
  const root = makeTempRoot(t);
  const result = ensureSpecs(root);

  assert.equal(result.specsDir, path.join(root, 'specs'));
  assert.equal(result.createdConfig, true);
  assert.ok(existsSync(path.join(root, 'specs')));
  assert.deepEqual(readJson(root, 'specs/config.json'), DEFAULT_CONFIG);
});

test('prefers the harness template when present in the project', (t) => {
  const root = makeTempRoot(t);
  const template = { 'id-counters': { domain: 7, phase: 3, step: 11 } };
  writeFile(root, TEMPLATE_CONFIG_PATH, template);

  ensureSpecs(root);

  assert.deepEqual(readJson(root, 'specs/config.json'), template);
});

test('leaves an existing config.json untouched', (t) => {
  const root = makeTempRoot(t);
  const existing = { 'id-counters': { domain: 42, phase: 1, step: 1 }, extra: true };
  writeFile(root, 'specs/config.json', existing);

  const result = ensureSpecs(root);

  assert.equal(result.createdConfig, false);
  assert.deepEqual(readJson(root, 'specs/config.json'), existing);
});

test('reserveIds returns the current counter and increments it by one', (t) => {
  const root = makeTempRoot(t);
  ensureSpecs(root);

  assert.deepEqual(reserveIds(root, 'domain'), [1]);
  assert.deepEqual(reserveIds(root, 'domain'), [2]);
  assert.equal(readJson(root, 'specs/config.json')['id-counters'].domain, 3);
});

test('reserveIds reserves a contiguous block of ids', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, 'specs/config.json', { 'id-counters': { domain: 1, phase: 1, step: 5 } });

  assert.deepEqual(reserveIds(root, 'step', 3), [5, 6, 7]);
  assert.equal(readJson(root, 'specs/config.json')['id-counters'].step, 8);
});

test('reserveIds preserves unrelated config keys', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, 'specs/config.json', { 'id-counters': { domain: 1, phase: 1, step: 1 }, extra: 'keep' });

  reserveIds(root, 'phase');

  assert.equal(readJson(root, 'specs/config.json').extra, 'keep');
});

test('reserveIds rejects unknown counters', (t) => {
  const root = makeTempRoot(t);
  ensureSpecs(root);
  assert.throws(() => reserveIds(root, 'bogus'), /unknown id counter "bogus"/i);
});

test('reserveIds rejects a corrupt counter value', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, 'specs/config.json', { 'id-counters': { domain: 'x', phase: 1, step: 1 } });
  assert.throws(() => reserveIds(root, 'domain'), /invalid/i);
});

test('reserveIds fails when config.json is missing', (t) => {
  const root = makeTempRoot(t);
  assert.throws(() => reserveIds(root, 'domain'), /config\.json/);
});
