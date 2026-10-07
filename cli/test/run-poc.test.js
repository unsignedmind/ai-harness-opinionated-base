import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logDirOf } from '../src/gate.js';
import { createPlan } from '../src/plan.js';
import { listResults, markProcessed } from '../src/poc.js';
import { resolveRoots, slash } from '../src/roots.js';
import { listRuns, notesPath, parseRunId, readRun, runIdOf, runOfWorktree, writeRun } from '../src/runs.js';
import { gitOk, makeRoots, writeFile } from './helpers.js';
import {
  branchExists,
  commitIn,
  head,
  lastSpecsFiles,
  lastSpecsSubject,
  noGit,
  nos,
  read,
  setup,
  start,
} from './run-helpers.js';

// POC runs (nos run start --poc <slug>): a throwaway branch + worktree without domain, target or statuses,
// never merged, only abandoned. Results in <specs>/pocs (nos poc, nos specs commit --run poc-<slug>).

const startPoc = async (root, slug, extra = []) => {
  const res = await nos(['run', 'start', '--poc', slug, ...extra], root);
  assert.equal(res.code, 0, res.err);
  return res.json;
};

const RESULT = (slug, processed = 'no') =>
  `---\npoc: poc-${slug}\ncreated: 2026-10-07T10:00:00.000Z\nprocessed: ${processed}            # no | quick <step id> | idea <domain> | dropped\n---\n# POC result: Dark mode toggle\n\n## Requirements\n1. A toggle\n`;

test('parseRunId: poc-<slug> has the slug as id; bad slugs are usage errors', () => {
  assert.deepEqual(parseRunId('poc-dark-mode'), { runId: 'poc-dark-mode', kind: 'poc', id: 'dark-mode' });
  for (const bad of ['poc-', 'poc-Dark', 'poc--x', 'poc-x-', 'poc-a/../b', 'poc-a_b']) {
    assert.throws(
      () => parseRunId(bad),
      (err) => err.code === 2,
      bad,
    );
  }
});

test(
  'poc start: branch + worktree + run file (domain null), install log; finish 1, set-status 1, sync works',
  noGit,
  async (t) => {
    const installCmd = `node -e "console.log('INSTALL OUT')"`;
    const { root, roots } = setup(t, { slugs: ['a'], config: { 'project-commands': { install: installCmd } } });
    const specsHead = head(roots.specs);
    const out = await startPoc(root, 'dark-mode');

    const wt = slash(path.join(root, '.claude', 'worktrees', 'poc-dark-mode'));
    assert.deepEqual(Object.keys(out), ['action', 'run', 'token', 'roots', 'enter', 'install', 'leftovers']);
    assert.equal(out.run.kind, 'poc');
    assert.equal(out.run.id, 'dark-mode');
    assert.equal(out.run.domain, null);
    assert.equal(out.run.branch, 'poc-dark-mode');
    assert.equal(out.run.worktree, wt);
    assert.equal(out.run.base, head(root));
    assert.equal(out.run.phase, 'develop');
    assert.equal(out.enter, wt);
    assert.equal(out.leftovers, null);
    assert.equal(out.install.code, 0);
    assert.equal(out.install.log, slash(path.join(roots.specs, '.runs', 'logs', 'poc-dark-mode', 'install.log')));
    assert.match(read(out.install.log), /INSTALL OUT/);
    assert.equal(gitOk(['symbolic-ref', '--short', 'HEAD'], wt), 'poc-dark-mode');
    assert.equal(readRun(roots, 'poc-dark-mode').domain, null);
    assert.equal(head(roots.specs), specsHead, 'no specs commit');

    // listRuns / runOfWorktree find it
    assert.deepEqual(listRuns(roots).map(runIdOf), ['poc-dark-mode']);
    const inside = resolveRoots({ root: wt, env: {}, home: roots.home });
    assert.equal(runIdOf(runOfWorktree(inside)), 'poc-dark-mode');

    const finish = await nos(['run', 'finish', '--token', out.token], wt);
    assert.equal(finish.code, 1);
    assert.match(finish.err, /never merged/);
    const status = await nos(['set-status', '--run', 'poc-dark-mode', 'discarded', '--token', out.token], root);
    assert.equal(status.code, 1);
    assert.match(status.err, /no statuses/);

    // sync brings main's changes in
    commitIn(wt, 'poc.txt', 'poc\n', 'poc: try');
    commitIn(root, 'src/main.txt', 'main\n', 'main moves');
    const sync = await nos(['run', 'sync', '--token', out.token], wt);
    assert.equal(sync.code, 0, sync.err);
    assert.equal(sync.json.rebased, true);
    assert.equal(sync.json.ahead, 1);
    assert.equal(sync.json.behind, 0);
    assert.ok(existsSync(path.join(wt, 'src', 'main.txt')));

    // gate and exec logs of the worktree go to logs/poc-<slug>
    assert.equal(
      slash(logDirOf(roots, 'poc-dark-mode', { create: false }).logDir),
      slash(path.dirname(out.install.log)),
    );
    const gate = await nos(['gate'], wt);
    assert.equal(gate.code, 0, gate.err);
    assert.equal(gate.json.tools[0].log, slash(path.join(roots.specs, '.runs', 'logs', 'poc-dark-mode', 'test.log')));
  },
);

test(
  'poc abandon crashed after phase abandoned: start gives only the token, cleanup completes it',
  noGit,
  async (t) => {
    const { root, roots } = setup(t, { slugs: ['a'] });
    const out = await startPoc(root, 'dark-mode');
    writeFileSync(notesPath(roots, 'poc-dark-mode'), '- note\n');
    writeRun(roots, { ...readRun(roots, 'poc-dark-mode'), phase: 'abandoned' });

    const held = await nos(['run', 'start', '--poc', 'dark-mode'], root);
    assert.equal(held.code, 4);
    const taken = await startPoc(root, 'dark-mode', ['--take-over']);
    assert.notEqual(taken.token, out.token);
    assert.equal(taken.run.phase, 'abandoned');
    assert.equal(taken.install, null);
    assert.ok(existsSync(out.enter), 'no git work: the worktree is still there');

    const cleanup = await nos(['run', 'cleanup', '--token', taken.token], root);
    assert.equal(cleanup.code, 0, cleanup.err);
    assert.deepEqual(cleanup.json.removed, { worktree: true, branch: true, runFile: true, notes: true });
    assert.equal(existsSync(out.enter), false);
    assert.equal(branchExists(root, 'poc-dark-mode'), false);
  },
);

test(
  'two POCs at once next to a quick run and a plan run; same token resumes, another 4, --take-over',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t, { slugs: ['a', 'b'] });
    createPlan(roots, {
      domain: quick.b.domain,
      plan: { name: 'B', status: 'open', phases: [{ slug: 'p', steps: [{ slug: 's' }] }] },
    });
    const a = await startPoc(root, 'one');
    const b = await startPoc(root, 'two');
    const q = await start(root, quick.a);
    const plan = await nos(['run', 'start', '--domain', quick.b.domain, '--plan'], root);
    assert.equal(plan.code, 0, plan.err);
    assert.deepEqual(
      listRuns(roots).map(runIdOf).sort(),
      ['poc-one', 'poc-two', quick.a.runId, plan.json.run.branch].sort(),
    );
    assert.notEqual(a.token, b.token);
    assert.equal(q.run.domain, quick.a.domain);

    const resumed = await startPoc(root, 'one', ['--token', a.token]);
    assert.equal(resumed.token, a.token);
    assert.equal(resumed.run.started, a.run.started);

    const other = await nos(['run', 'start', '--poc', 'one', '--token', b.token], root);
    assert.equal(other.code, 4);
    assert.equal(other.json.details.run, 'poc-one');
    assert.doesNotMatch(other.out, new RegExp(a.token));

    const taken = await startPoc(root, 'one', ['--take-over']);
    assert.notEqual(taken.token, a.token);
    assert.equal(readRun(roots, 'poc-one').token, taken.token);
  },
);

test(
  'poc abandon: refused inside; from main deletes worktree, branch, run file and notes, keeps the result',
  noGit,
  async (t) => {
    const { root, roots } = setup(t, { slugs: ['a'] });
    const out = await startPoc(root, 'dark-mode');
    const wt = out.enter;
    commitIn(wt, 'poc.txt', 'unmerged\n', 'poc: unmerged work');
    writeFile(wt, 'wip.txt', 'dirty\n');
    writeFileSync(notesPath(roots, 'poc-dark-mode'), '- turn 1: a toggle\n');
    writeFile(roots.specs, 'pocs/poc-dark-mode-result.md', RESULT('dark-mode'));
    const specsHead = head(roots.specs);

    const inside = await nos(['run', 'abandon', '--token', out.token], wt);
    assert.equal(inside.code, 1);
    assert.match(inside.err, /inside the worktree/);

    const res = await nos(['run', 'abandon', '--token', out.token, '--run', 'poc-dark-mode'], root);
    assert.equal(res.code, 0, res.err);
    assert.deepEqual(Object.keys(res.json), ['action', 'run', 'removed', 'statuses', 'specs']);
    assert.equal(res.json.run.phase, 'abandoned');
    assert.deepEqual(res.json.removed, { worktree: true, branch: true, runFile: true, notes: true });
    assert.equal(res.json.statuses, null);
    assert.equal(res.json.specs, null);
    assert.equal(existsSync(wt), false);
    assert.equal(branchExists(root, 'poc-dark-mode'), false);
    assert.equal(readRun(roots, 'poc-dark-mode'), null);
    assert.equal(existsSync(notesPath(roots, 'poc-dark-mode')), false);
    assert.ok(existsSync(path.join(roots.specs, 'pocs', 'poc-dark-mode-result.md')), 'the result stays');
    assert.equal(head(roots.specs), specsHead, 'no specs commit');
  },
);

test('specs commit --run poc-<slug>: only the result file, also without a run file', noGit, async (t) => {
  const { root, roots, quick } = setup(t, { slugs: ['a'] });
  await startPoc(root, 'dark-mode');
  writeFile(roots.specs, 'pocs/poc-dark-mode-result.md', RESULT('dark-mode'));
  writeFile(roots.specs, 'pocs/poc-other-result.md', RESULT('other'));
  writeFile(roots.specs, `${quick.a.domain}/idea.md`, '# a changed\n');
  const config = JSON.parse(readFileSync(path.join(roots.specs, 'config.json'), 'utf8'));
  writeFile(roots.specs, 'config.json', { ...config, chat: { runner: true } });

  const res = await nos(['specs', 'commit', '--run', 'poc-dark-mode', '-m', 'poc-dark-mode: result'], root);
  assert.equal(res.code, 0, res.err);
  assert.equal(res.json.domain, null);
  assert.equal(res.json.poc, 'poc-dark-mode');
  assert.equal(res.json.committed, true);
  assert.deepEqual(res.json.files, [slash(path.join(roots.specs, 'pocs', 'poc-dark-mode-result.md'))]);
  assert.deepEqual(lastSpecsFiles(roots), ['pocs/poc-dark-mode-result.md']);
  assert.equal(lastSpecsSubject(roots), 'poc-dark-mode: result');
  const dirty = gitOk(['status', '--porcelain'], roots.specs);
  assert.match(dirty, /idea\.md/, "another domain's file stays uncommitted");
  assert.match(dirty, /config\.json/);
  assert.match(dirty, /poc-other-result\.md/);

  const again = await nos(['specs', 'commit', '--run', 'poc-dark-mode', '-m', 'x'], root);
  assert.equal(again.json.committed, false);

  // no run file: the result is still committed (a result outlives its run)
  const orphan = await nos(['specs', 'commit', '--run', 'poc-other', '-m', 'poc-other: processed'], root);
  assert.equal(orphan.code, 0, orphan.err);
  assert.deepEqual(lastSpecsFiles(roots), ['pocs/poc-other-result.md']);

  // no result on disk and none tracked: 1, nothing committed
  const before = head(roots.specs);
  const none = await nos(['specs', 'commit', '--run', 'poc-none', '-m', 'poc-none: result'], root);
  assert.equal(none.code, 1);
  assert.match(none.err, /No POC result .*pocs\/poc-none-result\.md/);
  assert.equal(head(roots.specs), before);
});

test('poc results / poc processed: round trip, line endings kept, bad input refused', noGit, async (t) => {
  const { root, roots } = setup(t, { slugs: ['a'] });
  const empty = await nos(['poc', 'results'], root);
  assert.equal(empty.code, 0, empty.err);
  assert.deepEqual(empty.json, { action: 'poc-results', results: [] });

  await startPoc(root, 'dark-mode');
  writeFile(roots.specs, 'pocs/poc-dark-mode-result.md', RESULT('dark-mode'));
  writeFile(roots.specs, 'pocs/poc-old-result.md', RESULT('old', 'dropped').replace(/\n/g, '\r\n'));
  writeFile(roots.specs, 'pocs/notes.md', 'not a result');

  const list = await nos(['poc', 'results'], root);
  assert.deepEqual(list.json.results, [
    {
      slug: 'dark-mode',
      run: 'poc-dark-mode',
      title: 'Dark mode toggle',
      processed: 'no',
      state: 'draft',
      runExists: true,
      file: slash(path.join(roots.specs, 'pocs', 'poc-dark-mode-result.md')),
    },
    {
      slug: 'old',
      run: 'poc-old',
      title: 'Dark mode toggle',
      processed: 'dropped',
      state: 'draft',
      runExists: false,
      file: slash(path.join(roots.specs, 'pocs', 'poc-old-result.md')),
    },
  ]);

  // committed: tracked and clean; changed again: draft
  assert.equal((await nos(['specs', 'commit', '--run', 'poc-dark-mode', '-m', 'r'], root)).code, 0);
  const states = async () => (await nos(['poc', 'results'], root)).json.results.map((r) => r.state);
  assert.deepEqual(await states(), ['committed', 'draft']);

  const marked = await nos(['poc', 'processed', 'dark-mode', '--as', 'quick 12'], root);
  assert.equal(marked.code, 0, marked.err);
  assert.deepEqual(marked.json, {
    action: 'poc-processed',
    slug: 'dark-mode',
    run: 'poc-dark-mode',
    file: slash(path.join(roots.specs, 'pocs', 'poc-dark-mode-result.md')),
    previous: 'no',
    processed: 'quick 12',
  });
  const text = read(path.join(roots.specs, 'pocs', 'poc-dark-mode-result.md'));
  assert.match(
    text,
    /^---\npoc: poc-dark-mode\ncreated: .*\nprocessed: quick 12\n---\n# POC result: Dark mode toggle\n/,
  );

  const idea = await nos(['poc', 'processed', 'old', '--as', 'idea domain-3-dark-mode'], root);
  assert.equal(idea.code, 0, idea.err);
  const crlf = read(path.join(roots.specs, 'pocs', 'poc-old-result.md'));
  assert.match(crlf, /\r\nprocessed: idea domain-3-dark-mode\r\n---\r\n/);
  assert.doesNotMatch(crlf.replace(/\r\n/g, ''), /\n/, 'CRLF kept');

  const after = await nos(['poc', 'results'], root);
  assert.deepEqual(
    after.json.results.map((r) => r.processed),
    ['quick 12', 'idea domain-3-dark-mode'],
  );
  assert.deepEqual(await states(), ['draft', 'draft'], 'marked, not yet committed');

  for (const as of ['quick', 'quick x', 'idea foo', 'later', '']) {
    const bad = await nos(['poc', 'processed', 'dark-mode', '--as', as], root);
    assert.equal(bad.code, 2, as);
  }
  assert.equal((await nos(['poc', 'processed', 'Bad', '--as', 'dropped'], root)).code, 2);
  assert.equal((await nos(['poc', 'processed', 'dark-mode'], root)).code, 2);
  assert.equal((await nos(['poc', 'processed', 'missing', '--as', 'dropped'], root)).code, 1);
  assert.equal((await nos(['poc', 'unknown'], root)).code, 2);
});

test('front matter: a BOM and quoted values are read; a file without front matter gets one', (t) => {
  const roots = makeRoots(t);
  writeFile(
    roots.specs,
    'pocs/poc-bom-result.md',
    '﻿' + RESULT('bom').replace('processed: no', 'processed: "quick 7"'),
  );
  writeFile(roots.specs, 'pocs/poc-bare-result.md', '# POC result: Bare\r\n\r\n## Requirements\r\n');
  const { results } = listResults(roots);
  assert.deepEqual(
    results.map((r) => [r.slug, r.title, r.processed, r.state]),
    [
      ['bare', 'Bare', 'no', null],
      ['bom', 'Dark mode toggle', 'quick 7', null],
    ],
  );

  const bom = markProcessed(roots, { slug: 'bom', as: 'dropped' });
  assert.equal(bom.previous, 'quick 7');
  const bomText = read(path.join(roots.specs, 'pocs', 'poc-bom-result.md'));
  assert.match(bomText, /^---\npoc: poc-bom\n.*\nprocessed: dropped\n---\n# POC result/);

  const bare = markProcessed(roots, { slug: 'bare', as: 'idea domain-2-x' });
  assert.equal(bare.previous, null);
  assert.equal(
    read(path.join(roots.specs, 'pocs', 'poc-bare-result.md')),
    '---\r\nprocessed: idea domain-2-x\r\n---\r\n# POC result: Bare\r\n\r\n## Requirements\r\n',
  );
  assert.equal(listResults(roots).results[0].processed, 'idea domain-2-x');

  // the template: the comment is a line of its own, ignored by the parser and kept by poc processed
  const template = readFileSync(new URL('../../templates/poc-result.md', import.meta.url), 'utf8');
  writeFile(roots.specs, 'pocs/poc-tpl-result.md', template.replace(/\r\n/g, '\n').replace(/<slug>/g, 'tpl'));
  assert.equal(listResults(roots).results.find((r) => r.slug === 'tpl').processed, 'no');
  markProcessed(roots, { slug: 'tpl', as: 'quick 9' });
  const tpl = read(path.join(roots.specs, 'pocs', 'poc-tpl-result.md'));
  assert.match(tpl, /\n# processed: no \| quick <step id> \| idea <domain> \| dropped[^\n]*\nprocessed: quick 9\n---/);
  assert.equal(listResults(roots).results.find((r) => r.slug === 'tpl').processed, 'quick 9');
});

test('run start --poc: a bad slug or a mix with --domain/--plan/--quick is a usage error', noGit, async (t) => {
  const { root, roots, quick } = setup(t, { slugs: ['a'] });
  // a slug whose result already exists is history: 1
  writeFile(roots.specs, 'pocs/poc-taken-result.md', RESULT('taken'));
  const taken = await nos(['run', 'start', '--poc', 'taken'], root);
  assert.equal(taken.code, 1);
  assert.match(taken.err, /result for poc-taken exists/);
  for (const args of [
    ['--poc', 'a'.repeat(41)],
    ['--poc', 'Dark_Mode'],
    ['--poc', ''],
    ['--poc', 'x', '--domain', quick.a.domain],
    ['--poc', 'x', '--quick', String(quick.a.id)],
    ['--poc', 'x', '--plan'],
  ]) {
    const res = await nos(['run', 'start', ...args], root);
    assert.equal(res.code, 2, args.join(' '));
  }
  assert.equal((await nos(['run', 'sync', '--poc', 'x', '--token', 'abc'], root)).code, 2);
  assert.deepEqual(listRuns(roots), []);
});
