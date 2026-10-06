import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { peekIds, reserveIds } from '../src/config.js';
import { HELD, NosError } from '../src/exit-codes.js';
import { lockPath, takeLock } from '../src/lock.js';
import { makeRoots, readJson, runNode, srcUrl } from './helpers.js';

test('reserveIds releases lock ids afterwards, also when the counter is unknown', (t) => {
  const roots = makeRoots(t);

  assert.deepEqual(reserveIds(roots, 'step', 2), [1, 2]);
  assert.equal(existsSync(lockPath(roots, 'ids')), false);
  assert.throws(() => reserveIds(roots, 'bogus'), /Unknown id counter/);
  assert.equal(existsSync(lockPath(roots, 'ids')), false);
});

test('reserveIds without <specs>/config.json asks for nos init and creates no lock folder', (t) => {
  const roots = makeRoots(t, { setUp: false });
  assert.throws(() => reserveIds(roots, 'step'), /Run nos init/);
  assert.equal(existsSync(path.join(roots.specs, '.locks')), false);
});

test('a held ids lock: reserveIds waits, then HELD with the holder and the --break hint; peekIds needs no lock', (t) => {
  const roots = makeRoots(t);
  takeLock(roots, 'ids', { run: null, token: 'stuck123', command: 'crashed' });

  assert.throws(
    () => reserveIds(roots, 'step', 1, { waitMs: 100 }),
    (err) =>
      err instanceof NosError &&
      err.code === HELD &&
      err.details.holder.command === 'crashed' &&
      err.details.hint === 'nos lock release ids --break',
  );
  assert.deepEqual(peekIds(roots, 'step', 2), [1, 2]);
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].step, 1, 'counter unchanged');
});

test('4 child processes reserving ids at once get unique, contiguous ids', async (t) => {
  const roots = makeRoots(t);
  const script = `
    import { reserveIds } from '${srcUrl('config.js')}';
    const roots = ${JSON.stringify(roots)};
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(...reserveIds(roots, 'step', 2));
    console.log(JSON.stringify(ids));`;

  const results = await Promise.all([1, 2, 3, 4].map(() => runNode(script)));

  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const ids = results.flatMap((r) => JSON.parse(r.stdout)).sort((a, b) => a - b);
  assert.deepEqual(
    ids,
    Array.from({ length: 40 }, (_, i) => i + 1),
  );
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].step, 41);
});
