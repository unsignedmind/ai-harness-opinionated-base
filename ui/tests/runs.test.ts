// @vitest-environment node
// GET /__runs against a real temp project: nos init, a domain with a quick step, a real branch and
// worktree per run, and the run files as nos run start writes them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { writeRun } from '../../cli/src/runs.js';
import { buildModel } from '../src/model';
import { parseRuns, type Run } from '../src/runs';
import { isBranchName, listRunViews, runsHandler, runsScanner, runView } from '../src/serve-runs';
import { nodeDir, openBrowser, serveSpecs, specsEvent, specsRelOf, specsSetup } from '../src/serve-specs';
import { readSpecsFolder } from '../src/folder';

const CLI = resolve('../cli/bin/nos.js');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'nos test',
  GIT_AUTHOR_EMAIL: 'nos@test.invalid',
  GIT_COMMITTER_NAME: 'nos test',
  GIT_COMMITTER_EMAIL: 'nos@test.invalid',
};
// tmp holds the project (p) and its default specs root, the sibling folder p.specs
let tmp = '';
let main = '';
let specs = '';
let id = 0; // the quick step's id
const roots = () => ({ main, specs });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const nos = (args: string[], input?: string) =>
  JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--root', main], { encoding: 'utf8', input, env: ENV }));
const wt = (name: string) => join(main, '.claude', 'worktrees', name);

const base = {
  token: 'deadbeef',
  started: '2026-10-06T10:00:00.000Z',
  mainBranch: 'main',
};

beforeAll(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'nos-runs-')));
  main = join(tmp, 'p');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'app.txt'), 'one\n');
  nos(['init']);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  specs = join(tmp, 'p.specs');
  nos(['create-domain', '--idea', '-', '--slug', 'sync'], '# Idea: Sync\n');
  const quick = nos(
    ['create-quick-step', '--domain', 'domain-1-sync', '--step', '-'],
    JSON.stringify({ slug: 'fix-typo', intent: 'Fix it' }),
  );
  id = quick.id;

  // quick run: a branch two commits ahead, main one commit ahead of it, a dirty worktree
  git(main, 'worktree', 'add', '-q', '-b', `quick-${id}`, wt(`quick-${id}`), 'main');
  for (const n of [1, 2]) {
    writeFileSync(join(wt(`quick-${id}`), `f${n}.txt`), `${n}\n`);
    git(wt(`quick-${id}`), 'add', '-A');
    git(wt(`quick-${id}`), 'commit', '-q', '-m', `step-${id}: ${n}`);
  }
  writeFileSync(join(main, 'app.txt'), 'two\n');
  git(main, 'commit', '-q', '-am', 'main moves');
  writeFileSync(join(wt(`quick-${id}`), 'wip.txt'), 'uncommitted\n');
  writeRun(roots(), {
    ...base,
    kind: 'quick',
    id,
    domain: 'domain-1-sync',
    branch: `quick-${id}`,
    worktree: wt(`quick-${id}`).split(sep).join('/'),
    base: git(main, 'rev-parse', 'HEAD~1'),
    seen: new Date(Date.now() - 90_000).toISOString(),
    phase: 'develop',
  });

  // plan run: clean worktree on a fresh branch
  git(main, 'worktree', 'add', '-q', '-b', 'plan-1', wt('plan-1'), 'main');
  writeRun(roots(), {
    ...base,
    kind: 'plan',
    id: 1,
    domain: 'domain-1-sync',
    branch: 'plan-1',
    worktree: wt('plan-1'),
    base: git(main, 'rev-parse', 'HEAD'),
    seen: new Date().toISOString(),
    phase: 'gate',
  });

  // a run whose worktree is gone and whose branch never existed
  writeRun(roots(), {
    ...base,
    kind: 'quick',
    id: 99,
    domain: 'domain-2-gone',
    branch: 'quick-99',
    worktree: wt('quick-99'),
    base: 'x',
    seen: 'not a date',
    phase: 'develop',
  });
  // logs and broken files are no runs
  mkdirSync(join(specs, '.runs', 'logs'), { recursive: true });
  writeFileSync(join(specs, '.runs', 'logs', 'quick-2.log'), 'x');
  writeFileSync(join(specs, '.runs', 'quick-50.json'), '{ half');
});

afterAll(() => {
  try {
    git(main, 'worktree', 'remove', '--force', wt('plan-1'));
  } catch {
    // gone already
  }
  rmSync(tmp, { recursive: true, force: true });
});

const byId = (runs: Run[]) => Object.fromEntries(runs.map((r) => [`${r.kind}-${r.id}`, r]));

test('every run file is listed with ahead/behind main, dirty and age; never the token', async () => {
  const runs = byId(await listRunViews(roots()));
  expect(Object.keys(runs).sort()).toStrictEqual(['plan-1', `quick-${id}`, 'quick-99']);
  expect(runs[`quick-${id}`]).toMatchObject({
    kind: 'quick',
    id,
    domain: 'domain-1-sync',
    branch: `quick-${id}`,
    phase: 'develop',
    ahead: 2,
    behind: 1,
    dirty: true,
  });
  expect(runs[`quick-${id}`].ageSec).toBeGreaterThanOrEqual(89);
  expect(runs[`quick-${id}`].error).toBeUndefined();
  expect(runs['plan-1']).toMatchObject({ phase: 'gate', ahead: 0, behind: 0, dirty: false });
  for (const r of Object.values(runs)) expect(r).not.toHaveProperty('token');
});

test('a run git cannot answer for gets nulls and an error, the others are unharmed', async () => {
  const gone = byId(await listRunViews(roots()))['quick-99'];
  expect(gone).toMatchObject({ ahead: null, behind: null, dirty: null, ageSec: null, seen: 'not a date' });
  expect(gone.error).toMatch(/ahead\/behind: .*; worktree missing: /);
});

test('branch names that look like options or revisions never reach git; a non-top worktree is not asked', async () => {
  mkdirSync(join(wt('plan-1'), 'sub'), { recursive: true });
  const evil = { ...base, kind: 'quick' as const, domain: 'domain-3-x', worktree: join(wt('plan-1'), 'sub') };
  const opt = await runView(
    { main },
    { ...evil, id: 70, branch: '--output=pwned', base: 'x', seen: '', phase: 'develop' },
  );
  expect(opt.ahead).toBeNull();
  expect(opt.error).toMatch(/not a branch name/);
  expect(opt.error).toMatch(/is not the top of a worktree/);
  expect(opt.dirty).toBeNull();
  const range = await runView(
    { main },
    { ...evil, id: 71, branch: 'main..plan-1', base: 'x', seen: '', phase: 'develop' },
  );
  expect(range.error).toMatch(/not a branch name/);
  for (const ok of ['quick-7', 'plan-29', 'feature/x.y', 'main']) expect(isBranchName(ok)).toBe(true);
  for (const bad of ['-x', 'a..b', 'a/.b', 'x.lock', 'a b', 'HEAD@{1}', 'a~1', '', 'x.'])
    expect(isBranchName(bad)).toBe(false);
});

test('GET /__runs answers 200 JSON without tokens, parseable by the page', async () => {
  const res = await new Promise<{ code: number; body: string; type: string }>((done) => {
    const headers: Record<string, string> = {};
    const r = {
      statusCode: 200,
      setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
      end: (body = '') => done({ code: r.statusCode, body, type: headers['content-type'] }),
    };
    runsHandler(roots())({}, r);
  });
  expect(res.code).toBe(200);
  expect(res.type).toBe('application/json');
  expect(res.body).not.toContain('deadbeef');
  expect(parseRuns(JSON.parse(res.body))).toHaveLength(3);
});

test('pages asking at once share one scan, and the result is reused for a moment', async () => {
  const scan = runsScanner(roots(), 60_000);
  const [a, b] = [scan(), scan()];
  expect(a).toBe(b);
  const first = await a;
  expect(await scan()).toBe(first);
  const fresh = runsScanner(roots(), 0);
  const x = await fresh();
  expect(await fresh()).not.toBe(x);
});

test('the scan never blocks the event loop: a timer fires while git runs', async () => {
  let ticked = false;
  setTimeout(() => (ticked = true), 0);
  const pending = listRunViews(roots());
  await new Promise((r) => setTimeout(r, 1));
  expect(ticked).toBe(true);
  await pending;
});

test('no .runs folder is no runs', async () => {
  expect(await listRunViews({ main, specs: join(main, 'nowhere') })).toStrictEqual([]);
});

test('the model joins the runs: the quick run to its step, the plan run to the domain', async () => {
  const m = buildModel(await readSpecsFolder(nodeDir(specs)), await listRunViews(roots()));
  const sync = m.ideas[0];
  expect(sync.run?.branch).toBe('plan-1');
  expect(sync.quickSteps[0].run).toMatchObject({ kind: 'quick', id, ahead: 2 });
});

test('specsRel: the specs root relative to main (the sibling folder too), absolute only on another drive', () => {
  expect(specsRelOf({ main, specs })).toBe('../p.specs');
  expect(specsRelOf({ main, specs: join(main, '.specs') })).toBe('.specs');
  expect(specsRelOf({ main, specs: join(main, 'plans', 'specs') })).toBe('plans/specs');
  if (process.platform === 'win32') {
    const drive = main[0].toUpperCase() === 'Z' ? 'Y' : 'Z';
    const outside = `${drive}:\\elsewhere`;
    expect(specsRelOf({ main, specs: outside })).toBe(resolve(outside).split(sep).join('/'));
  }
});

test('the browser opens only when nobody scripts the dev server', () => {
  expect(openBrowser({})).toBe(true);
  expect(openBrowser({ NOS_UI_OPEN: '0' })).toBe(false);
  expect(openBrowser({ NOS_SPECS_ROOT: 'x' })).toBe(false);
  expect(openBrowser({ VITEST: 'true' })).toBe(false);
  expect(openBrowser({ NOS_SPECS_ROOT: 'x', NOS_UI_OPEN: '1' })).toBe(true);
});

test('a change in .runs/*.json is runs:changed, logs and local state are nothing, the rest specs:changed', () => {
  const f = (...p: string[]) => join(specs, ...p);
  expect(specsEvent(specs, f('.runs', 'quick-2.json'))).toBe('runs:changed');
  expect(specsEvent(specs, f('.runs', 'logs', 'quick-2.log'))).toBeNull();
  expect(specsEvent(specs, f('.chat', 'sessions.json'))).toBeNull();
  expect(specsEvent(specs, f('.locks', 'merge', 'holder.json'))).toBeNull();
  expect(specsEvent(specs, f('.git', 'index'))).toBeNull();
  expect(specsEvent(specs, f('domain-1-sync', 'idea.md'))).toBe('specs:changed');
  expect(specsEvent(specs, f('config.json'))).toBe('specs:changed');
  expect(specsEvent(specs, join(main, 'app.txt'))).toBeNull();
});

test('the dev server finds the project from inside it, from its specs root, a worktree and via NOS_SPECS_ROOT', () => {
  const real = (p: string) => realpathSync.native(p);
  const fromMain = specsSetup({ cwd: main, env: {} });
  expect(fromMain.roots && real(fromMain.roots.specs)).toBe(real(specs));
  // the specs root lies outside the checkout: its config.json points back to the project
  const fromSpecs = specsSetup({ cwd: join(specs, 'domain-1-sync'), env: {} });
  expect(fromSpecs.roots && real(fromSpecs.roots.main)).toBe(real(main));
  const fromWorktree = specsSetup({ cwd: wt('plan-1'), env: {} });
  expect(fromWorktree.roots && real(fromWorktree.roots.main)).toBe(real(main));
  const viaEnv = specsSetup({ cwd: tmpdir(), env: { NOS_SPECS_ROOT: main } });
  expect(viaEnv.roots && real(viaEnv.roots.specs)).toBe(real(specs));
});

test('not set up: specsSetup says run nos init and the plugin still loads', () => {
  const bare = mkdtempSync(join(tmpdir(), 'nos-bare-'));
  try {
    const setup = specsSetup({ cwd: bare, env: { NOS_SPECS_ROOT: bare } });
    expect(setup.roots).toBeUndefined();
    expect(setup.error).toMatch(/^nos is not set up.*run nos init/i);
    expect(serveSpecs(setup).name).toBe('serve-specs');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
