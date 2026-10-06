import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reportError } from '../src/cli.js';
import { FAILED, HELD, NosError, USAGE } from '../src/exit-codes.js';
import { resolveRoots, slash } from '../src/roots.js';
import {
  deleteRun,
  listRuns,
  mintToken,
  parseRunId,
  readRun,
  requireToken,
  RUN_PHASES,
  runIdOf,
  runOfWorktree,
  runPath,
  touchSeen,
  writeRun,
} from '../src/runs.js';
import { gitOk, hasGit, makeProject, makeRoots } from './helpers.js';

const noGit = { skip: !hasGit && 'git is not available' };

const RUN = {
  kind: 'quick',
  id: 7,
  domain: 'domain-2-auth',
  branch: 'quick-7',
  worktree: 'D:/repo/.claude/worktrees/quick-7',
  base: 'abc123',
  mainBranch: 'main',
  token: '1a2b3c4d',
  started: '2026-10-06T10:00:00.000Z',
  seen: '2026-10-06T10:00:00.000Z',
  phase: 'develop',
};

const isCode = (code) => (err) => err instanceof NosError && err.code === code;

test('run ids are <kind>-<id>; RUN_PHASES lists the phases of the contract', () => {
  assert.deepEqual(parseRunId('quick-7'), { runId: 'quick-7', kind: 'quick', id: 7 });
  assert.deepEqual(parseRunId('plan-29'), { runId: 'plan-29', kind: 'plan', id: 29 });
  for (const bad of ['quick7', 'step-1', 'plan-0', 'quick-1/../x', '', undefined]) {
    assert.throws(() => parseRunId(bad), isCode(USAGE), String(bad));
  }
  assert.deepEqual(RUN_PHASES, ['develop', 'integrate', 'gate', 'merge', 'merged', 'abandoned']);
  assert.equal(runIdOf(RUN), 'quick-7');
});

test('writeRun / readRun / listRuns / deleteRun: one file per run in <specs>/.runs, no tmp file left', (t) => {
  const roots = makeRoots(t);
  assert.equal(readRun(roots, 'quick-7'), null);
  assert.deepEqual(listRuns(roots), []);

  const file = writeRun(roots, RUN);
  writeRun(roots, { ...RUN, kind: 'plan', id: 3, domain: 'domain-3-x' });

  assert.equal(file, runPath(roots, 'quick-7'));
  assert.equal(slash(file), slash(path.join(roots.specs, '.runs', 'quick-7.json')));
  assert.deepEqual(readRun(roots, 'quick-7'), RUN);
  assert.deepEqual(listRuns(roots).map(runIdOf), ['plan-3', 'quick-7']);
  assert.deepEqual(readdirSync(path.join(roots.specs, '.runs')).sort(), ['plan-3.json', 'quick-7.json']);

  deleteRun(roots, 'plan-3');
  assert.deepEqual(listRuns(roots).map(runIdOf), ['quick-7']);
});

test('writeRun refuses an unknown kind or phase; listRuns skips broken and foreign files', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => writeRun(roots, { ...RUN, kind: 'epic' }), isCode(FAILED));
  assert.throws(() => writeRun(roots, { ...RUN, phase: 'shipping' }), isCode(FAILED));

  writeRun(roots, RUN);
  writeFileSync(path.join(roots.specs, '.runs', 'quick-8.json'), '{ half');
  writeFileSync(path.join(roots.specs, '.runs', 'notes.json'), '{}');
  assert.deepEqual(listRuns(roots).map(runIdOf), ['quick-7']);
  assert.throws(() => readRun(roots, 'quick-8'), isCode(FAILED));
});

test('mintToken: 8 hex', () => {
  const a = mintToken();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, mintToken());
});

test('requireToken: own token ok, NOS_RUN_TOKEN fallback, missing -> FAILED, another token -> HELD (exit 4)', () => {
  assert.equal(requireToken(RUN, '1a2b3c4d', {}), '1a2b3c4d');
  assert.equal(requireToken(RUN, undefined, { NOS_RUN_TOKEN: '1a2b3c4d' }), '1a2b3c4d');
  assert.throws(
    () => requireToken(RUN, undefined, {}),
    (err) => isCode(FAILED)(err) && /--token required/.test(err.message),
  );

  let mismatch;
  assert.throws(
    () => requireToken(RUN, 'ffffffff', {}),
    (err) => {
      mismatch = err;
      return isCode(HELD)(err);
    },
  );
  assert.equal(mismatch.details.run, 'quick-7');
  assert.equal(mismatch.details.seen, RUN.seen);
  assert.equal(typeof mismatch.details.ageSec, 'number');
  assert.equal(JSON.stringify(mismatch.details).includes(RUN.token), false, 'the holder token is not printed');

  let out = '';
  const code = reportError('run-sync', mismatch, { stdout: { write: (s) => (out += s) }, stderr: { write() {} } });
  assert.equal(code, 4);
  assert.equal(JSON.parse(out).exit, 4);
});

test('touchSeen updates seen and writes the run file', (t) => {
  const roots = makeRoots(t);
  writeRun(roots, RUN);

  const updated = touchSeen(roots, readRun(roots, 'quick-7'));

  assert.ok(Date.parse(updated.seen) > Date.parse(RUN.seen));
  assert.equal(readRun(roots, 'quick-7').seen, updated.seen);
});

test('runOfWorktree finds the run whose worktree is the work root; null in main', noGit, (t) => {
  const { root, roots: mainRoots } = makeProject(t, { git: true });
  const wt = path.join(root, '.claude', 'worktrees', 'quick-7');
  gitOk(['worktree', 'add', '-b', 'quick-7', wt], root);
  writeRun(mainRoots, { ...RUN, worktree: slash(wt) });
  writeRun(mainRoots, { ...RUN, kind: 'quick', id: 8, worktree: slash(path.join(root, 'elsewhere')) });

  const wtRoots = resolveRoots({ cwd: wt, env: {} });

  assert.equal(wtRoots.inWorktree, true);
  assert.equal(runIdOf(runOfWorktree(wtRoots)), 'quick-7');
  assert.equal(runOfWorktree(mainRoots), null);
});
