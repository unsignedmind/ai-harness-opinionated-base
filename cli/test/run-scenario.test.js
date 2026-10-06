import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { git } from '../src/git.js';
import { takeLock } from '../src/lock.js';
import { readRun, writeRun } from '../src/runs.js';
import { gitOk, readJson, writeFile } from './helpers.js';
import {
  branchExists,
  commitIn,
  done,
  head,
  lastSpecsFiles,
  lastSpecsSubject,
  mergeHeld,
  noGit,
  nos,
  PASS,
  quickStatus,
  read,
  setup,
  start,
} from './run-helpers.js';

// Scenario tests of the merge protocol (nos run finish) with real git, two runs side by side.

// ---------------------------------------------------------------------------------------------------------
// run finish: the merge protocol

test(
  'two quick runs in parallel, different domains: both finish ff-only, cleanup removes everything',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    const b = await start(root, quick.b);
    commitIn(a.enter, 'src/from-a.txt', 'a\n', `step-${quick.a.id}: a`);
    commitIn(b.enter, 'src/from-b.txt', 'b\n', `step-${quick.b.id}: b`);
    done(roots, quick.a);
    done(roots, quick.b);

    const finishA = await nos(['run', 'finish', '--token', a.token], a.enter);
    assert.equal(finishA.code, 0, finishA.err);
    assert.equal(finishA.json.action, 'run-finish');
    assert.equal(finishA.json.merged, true);
    assert.equal(finishA.json.run.phase, 'merged');
    assert.equal(finishA.json.gate.pass, true);
    assert.equal(finishA.json.head, head(root));
    assert.equal(head(root), head(a.enter), 'main fast-forwarded to the branch tip');
    assert.ok(existsSync(path.join(root, 'src', 'from-a.txt')), 'main working tree updated');
    assert.equal(mergeHeld(roots), false);

    const finishB = await nos(['run', 'finish', '--token', b.token], b.enter);
    assert.equal(finishB.code, 0, finishB.err);
    assert.equal(head(root), head(b.enter));
    assert.ok(existsSync(path.join(root, 'src', 'from-b.txt')));
    assert.equal(gitOk(['rev-list', '--merges', 'main'], root), '', 'no merge commit on main');
    assert.equal(gitOk(['rev-list', '--count', 'main'], root), '4');

    for (const [q, run] of [
      [quick.a, a],
      [quick.b, b],
    ]) {
      assert.equal(quickStatus(roots, q), 'merged');
      assert.equal(readRun(roots, q.runId).phase, 'merged');
      const cleanup = await nos(['run', 'cleanup', '--token', run.token], root);
      assert.equal(cleanup.code, 0, cleanup.err);
      assert.deepEqual(Object.keys(cleanup.json), ['action', 'run', 'removed']);
      assert.equal(cleanup.json.action, 'run-cleanup');
      assert.equal(cleanup.json.run.id, q.id);
      assert.deepEqual(cleanup.json.removed, { worktree: true, branch: true, runFile: true });
      assert.equal(existsSync(run.enter), false);
      assert.equal(branchExists(root, q.runId), false);
      assert.equal(readRun(roots, q.runId), null);
      assert.equal(
        readJson(roots.specs, `${q.domain}/quick-steps/quick-steps.json`)[0].branch,
        q.runId,
        'branch stays',
      );
    }
    assert.equal(
      gitOk(['worktree', 'list', '--porcelain'], root)
        .split('\n')
        .filter((l) => l.startsWith('worktree ')).length,
      1,
    );
  },
);

test(
  'A finishes, B conflicts on the same line: finish 3, resolve + rebase --continue, finish merges ff-only',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    const b = await start(root, quick.b);
    commitIn(a.enter, 'src/a.txt', 'one\nTWO-a\nthree\n', `step-${quick.a.id}: a`);
    commitIn(b.enter, 'src/a.txt', 'one\nTWO-b\nthree\n', `step-${quick.b.id}: b`);
    done(roots, quick.a);
    done(roots, quick.b);
    assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);
    const mainAfterA = head(root);

    const conflict = await nos(['run', 'finish', '--token', b.token], b.enter);
    assert.equal(conflict.code, 3);
    assert.equal(conflict.json.action, 'run-finish');
    assert.deepEqual(conflict.json.details.files, ['src/a.txt']);
    assert.equal(mergeHeld(roots), false, 'lock released');
    assert.equal(readRun(roots, quick.b.runId).phase, 'develop', 'parked');
    assert.equal(head(root), mainAfterA, 'main untouched');

    writeFile(b.enter, 'src/a.txt', 'one\nTWO-a-and-b\nthree\n');
    gitOk(['add', 'src/a.txt'], b.enter);
    gitOk(['-c', 'core.editor=true', 'rebase', '--continue'], b.enter);

    const finish = await nos(['run', 'finish', '--token', b.token], b.enter);
    assert.equal(finish.code, 0, finish.err);
    assert.equal(head(root), head(b.enter), 'main HEAD == branch tip');
    assert.equal(gitOk(['rev-parse', 'main~1'], root), mainAfterA, 'linear on top of A');
    assert.equal(gitOk(['rev-list', '--merges', 'main'], root), '');
    assert.equal(read(path.join(root, 'src', 'a.txt')), 'one\nTWO-a-and-b\nthree\n');
    assert.equal(quickStatus(roots, quick.b), 'merged');
  },
);

test('finish: precondition done; dirty worktree -> 5, lock released, main untouched', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  const mainSha = head(root);

  const notDone = await nos(['run', 'finish', '--token', a.token], a.enter);
  assert.equal(notDone.code, 1);
  assert.match(notDone.err, /is open: finish needs done/);
  assert.equal(mergeHeld(roots), false);

  done(roots, quick.a);
  writeFile(a.enter, 'src/x.txt', 'dirty\n');
  const dirty = await nos(['run', 'finish', '--token', a.token], a.enter);
  assert.equal(dirty.code, 5);
  assert.deepEqual(dirty.json.details.files, ['src/x.txt']);
  assert.equal(mergeHeld(roots), false);
  assert.equal(readRun(roots, quick.a.runId).phase, 'develop');
  assert.equal(head(root), mainSha);
  assert.equal(quickStatus(roots, quick.a), 'done');
});

test(
  'finish: main dirty on a path the branch touches -> 1 with the list, main untouched; other paths are fine',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    commitIn(a.enter, 'src/a.txt', 'one\nTWO\nthree\n', `step-${quick.a.id}: a`);
    commitIn(a.enter, 'src/new.txt', 'new\n', `step-${quick.a.id}: new`);
    done(roots, quick.a);
    const mainSha = head(root);
    writeFile(root, 'src/a.txt', 'local edit\n');
    writeFile(root, 'src/new.txt', 'untracked in main\n');
    writeFile(root, 'notes.txt', 'unrelated\n');

    const res = await nos(['run', 'finish', '--token', a.token], a.enter);

    assert.equal(res.code, 1);
    assert.equal(res.json.action, 'run-finish');
    assert.equal(res.json.exit, 1);
    assert.match(res.json.error, /uncommitted changes on paths/);
    assert.deepEqual(res.json.details.files.sort(), ['src/a.txt', 'src/new.txt']);
    assert.equal(head(root), mainSha);
    assert.equal(read(path.join(root, 'src', 'a.txt')), 'local edit\n');
    assert.equal(mergeHeld(roots), false);
    assert.equal(readRun(roots, quick.a.runId).phase, 'develop');

    rmSync(path.join(root, 'src', 'new.txt'));
    gitOk(['checkout', '--', 'src/a.txt'], root);
    const ok = await nos(['run', 'finish', '--token', a.token], a.enter);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(read(path.join(root, 'notes.txt')), 'unrelated\n', 'an unrelated dirty file stays');
  },
);

test(
  'finish: main busy (MERGE_HEAD, rebase folder; a stale REBASE_HEAD is not busy) -> 1; main on another branch -> 1',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
    done(roots, quick.a);
    gitOk(['branch', 'side'], root);
    gitOk(['checkout', '-q', 'side'], root);
    commitIn(root, 'side.txt', 's\n', 'side');
    gitOk(['checkout', '-q', 'main'], root);
    gitOk(['merge', '--no-ff', '--no-commit', 'side'], root);
    const mainSha = head(root);

    const busy = await nos(['run', 'finish', '--token', a.token], a.enter);
    assert.equal(busy.code, 1);
    assert.deepEqual(busy.json.details.busy, ['MERGE_HEAD']);
    assert.match(busy.err, /main is busy/);
    assert.equal(mergeHeld(roots), false);
    gitOk(['merge', '--abort'], root);

    const gitDir = gitOk(['rev-parse', '--absolute-git-dir'], root);
    mkdirSync(path.join(gitDir, 'rebase-merge'));
    const rebasing = await nos(['run', 'finish', '--token', a.token], a.enter);
    assert.equal(rebasing.code, 1);
    assert.deepEqual(rebasing.json.details.busy, ['rebase-merge']);
    rmSync(path.join(gitDir, 'rebase-merge'), { recursive: true });
    // git leaves REBASE_HEAD behind after a finished rebase: not busy
    writeFile(gitDir, 'REBASE_HEAD', `${mainSha}\n`);

    gitOk(['checkout', '-q', 'side'], root);
    const elsewhere = await nos(['run', 'finish', '--token', a.token], a.enter);
    assert.equal(elsewhere.code, 1);
    assert.match(elsewhere.err, /main checkout is on side, expected main/);
    gitOk(['checkout', '-q', 'main'], root);
    assert.equal(head(root), mainSha);

    assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);
  },
);

test(
  'finish: gate fail -> 1 with the gate in details, lock released, phase develop, main untouched',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    commitIn(a.enter, 'FAIL', 'x\n', `step-${quick.a.id}: breaks the test`);
    done(roots, quick.a);
    const mainSha = head(root);

    const res = await nos(['run', 'finish', '--token', a.token], a.enter);

    assert.equal(res.code, 1);
    assert.equal(res.json.action, 'run-finish');
    assert.match(res.json.error, /gate failed: test/);
    assert.equal(res.json.details.gate.action, 'gate');
    assert.equal(res.json.details.gate.pass, false);
    assert.equal(res.json.details.gate.tools[0].status, 'fail');
    assert.match(res.json.details.gate.tools[0].log, new RegExp(`logs/${quick.a.runId}/test\\.log$`));
    assert.equal(mergeHeld(roots), false);
    assert.equal(readRun(roots, quick.a.runId).phase, 'develop');
    assert.equal(head(root), mainSha);
    assert.equal(quickStatus(roots, quick.a), 'done');
  },
);

test('finish: the gate includes e2e when it is configured (D-5)', noGit, async (t) => {
  const { root, roots, quick } = setup(t, {
    config: { 'quality-tools': { test: PASS, e2e: `node -e "console.log('slot=' + process.env.NOS_SLOT)"` } },
  });
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  const res = await nos(['run', 'finish', '--token', a.token], a.enter);
  assert.equal(res.code, 0, res.err);
  const e2e = res.json.gate.tools.find((tool) => tool.name === 'e2e');
  assert.equal(e2e.status, 'pass');
  assert.equal(e2e.tail, 'slot=1');
});

test(
  'finish: a crashed finish (own lock, phase gate) resumes with the same token; another token -> 4',
  noGit,
  async (t) => {
    const { root, roots, quick } = setup(t);
    const a = await start(root, quick.a);
    const b = await start(root, quick.b);
    commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
    commitIn(b.enter, 'src/y.txt', 'y\n', `step-${quick.b.id}: y`);
    done(roots, quick.a);
    done(roots, quick.b);
    takeLock(roots, 'merge', { run: quick.a.runId, token: a.token, command: 'run finish' });
    writeRun(roots, { ...readRun(roots, quick.a.runId), phase: 'gate' });

    const blocked = await nos(['run', 'finish', '--token', b.token], b.enter);
    assert.equal(blocked.code, 4);
    assert.equal(blocked.json.action, 'run-finish');
    assert.equal(blocked.json.details.lock, 'merge');
    assert.equal(blocked.json.details.holder.run, quick.a.runId);
    assert.equal(blocked.json.details.holder.token, a.token);
    assert.equal(readRun(roots, quick.b.runId).phase, 'develop', 'B stays as it was');

    const resumed = await nos(['run', 'finish', '--token', a.token], a.enter);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(resumed.json.resumedFrom, 'gate');
    assert.equal(resumed.json.run.phase, 'merged');
    assert.equal(head(root), head(a.enter));
    assert.equal(mergeHeld(roots), false);

    assert.equal((await nos(['run', 'finish', '--token', b.token], b.enter)).code, 0);
  },
);

test('finish: phase merge with the branch already in main completes the status flip', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  const tip = commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  // crashed right after the ff merge: lock held, phase merge, statuses still done
  takeLock(roots, 'merge', { run: quick.a.runId, token: a.token, command: 'run finish' });
  writeRun(roots, { ...readRun(roots, quick.a.runId), phase: 'merge' });
  gitOk(['merge', '--ff-only', quick.a.runId], root);
  writeFile(root, 'FAIL', 'a gate would fail now\n');

  const res = await nos(['run', 'finish', '--token', a.token], a.enter);

  assert.equal(res.code, 0, res.err);
  assert.equal(res.json.resumedFrom, 'merge');
  assert.equal(res.json.gate, null, 'no second gate');
  assert.equal(res.json.head, tip);
  assert.equal(res.json.statuses.changes[0].status, 'merged');
  assert.equal(quickStatus(roots, quick.a), 'merged');
  assert.equal(lastSpecsSubject(roots), `${quick.a.runId}: merged`);
  assert.equal(readRun(roots, quick.a.runId).phase, 'merged');
  assert.equal(mergeHeld(roots), false);
  const again = await nos(['run', 'finish', '--token', a.token], a.enter);
  assert.equal(again.code, 0);
  assert.equal(again.json.already, true);
});

test('finish: the specs commits contain only the domain folder and config.json', noGit, async (t) => {
  const { root, roots, quick } = setup(t);
  const a = await start(root, quick.a);
  commitIn(a.enter, 'src/x.txt', 'x\n', `step-${quick.a.id}: x`);
  done(roots, quick.a);
  writeFile(roots.specs, `${quick.b.domain}/idea.md`, '# b edited by another session\n');

  assert.equal((await nos(['run', 'finish', '--token', a.token], a.enter)).code, 0);

  assert.equal(lastSpecsSubject(roots), `${quick.a.runId}: merged`);
  const files = lastSpecsFiles(roots);
  assert.ok(files.length > 0);
  assert.ok(
    files.every((file) => file === 'config.json' || file.startsWith(`${quick.a.domain}/`)),
    files.join(),
  );
  assert.match(gitOk(['status', '--porcelain'], roots.specs), new RegExp(`${quick.b.domain}/idea.md`));
});
