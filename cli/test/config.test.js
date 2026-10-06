import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensureSpecs, reserveIds, DEFAULT_CONFIG } from '../src/config.js';
import { makeRoots, writeFile, readJson } from './helpers.js';

test('creates specs folder and config.json from built-in default', (t) => {
  const roots = makeRoots(t, { setUp: false });
  const result = ensureSpecs(roots);

  assert.equal(result.specsDir, roots.specs);
  assert.equal(result.createdConfig, true);
  assert.ok(existsSync(roots.specs));
  assert.deepEqual(readJson(roots.specs, 'config.json'), DEFAULT_CONFIG);
});

test('prefers the config template of the nos home when present', (t) => {
  const roots = makeRoots(t, { setUp: false });
  const template = { 'id-counters': { domain: 7, phase: 3, step: 11 } };
  writeFile(roots.home, 'templates/config.json', template);

  ensureSpecs(roots);

  assert.deepEqual(readJson(roots.specs, 'config.json'), template);
});

test('leaves an existing config.json untouched', (t) => {
  const roots = makeRoots(t);
  const existing = { 'id-counters': { domain: 42, phase: 1, step: 1 }, extra: true };
  writeFile(roots.specs, 'config.json', existing);

  const result = ensureSpecs(roots);

  assert.equal(result.createdConfig, false);
  assert.deepEqual(readJson(roots.specs, 'config.json'), existing);
});

test('reserveIds returns the current counter and increments it by one', (t) => {
  const roots = makeRoots(t);
  ensureSpecs(roots);

  assert.deepEqual(reserveIds(roots, 'domain'), [1]);
  assert.deepEqual(reserveIds(roots, 'domain'), [2]);
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].domain, 3);
});

test('reserveIds reserves a contiguous block of ids', (t) => {
  const roots = makeRoots(t);
  writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 1, phase: 1, step: 5 } });

  assert.deepEqual(reserveIds(roots, 'step', 3), [5, 6, 7]);
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].step, 8);
});

test('reserveIds preserves unrelated config keys', (t) => {
  const roots = makeRoots(t);
  writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 1, phase: 1, step: 1 }, extra: 'keep' });

  reserveIds(roots, 'phase');

  assert.equal(readJson(roots.specs, 'config.json').extra, 'keep');
});

test('reserveIds rejects unknown counters', (t) => {
  const roots = makeRoots(t);
  ensureSpecs(roots);
  assert.throws(() => reserveIds(roots, 'bogus'), /unknown id counter "bogus"/i);
});

test('reserveIds rejects a corrupt counter value', (t) => {
  const roots = makeRoots(t);
  writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 'x', phase: 1, step: 1 } });
  assert.throws(() => reserveIds(roots, 'domain'), /invalid/i);
});

test('reserveIds fails when config.json is missing', (t) => {
  const roots = makeRoots(t, { setUp: false });
  assert.throws(() => reserveIds(roots, 'domain'), /config\.json/);
});
