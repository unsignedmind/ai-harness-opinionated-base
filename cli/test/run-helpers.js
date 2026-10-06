import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDomain } from '../src/domain.js';
import { git } from '../src/git.js';
import { lockStatus } from '../src/lock.js';
import { createQuickStep, quickStepId } from '../src/quick-step.js';
import { setStatus } from '../src/status.js';
import { gitOk, hasGit, initRepo, invokeCli, makeProject, readJson, writeFile } from './helpers.js';

// Shared by the run tests (run, run-scenario, run-cleanup) with real git: a temp project (main), its .specs repo,
// worktrees under <main>/.claude/worktrees. Quality tools are fake node one-liners; the test tool fails when the
// checkout has a file FAIL, so a branch can break the gate.
export const noGit = { skip: !hasGit && 'git is not available' };

export const FAIL_IF = `node -e "process.exit(require('fs').existsSync('FAIL') ? 1 : 0)"`;
export const PASS = `node -e "process.exit(0)"`;

// A git project with src/a.txt on main and a .specs repo with one domain + quick step per slug
export function setup(t, { config = {}, slugs = ['a', 'b'] } = {}) {
  const { root, roots } = makeProject(t, {
    git: true,
    config: { 'quality-tools': { test: FAIL_IF }, worktrees: { slots: 1, slotWait: 1 }, ...config },
  });
  writeFile(root, 'src/a.txt', 'one\ntwo\nthree\n');
  gitOk(['add', 'src/a.txt'], root);
  gitOk(['commit', '-m', 'src'], root);
  initRepo(roots.specs);
  writeFile(roots.specs, '.gitignore', '.chat/\n.locks/\n.runs/\n');
  const quick = {};
  for (const slug of slugs) {
    const { folder: domain } = createDomain(roots, { idea: `# ${slug}`, slug });
    const { id } = createQuickStep(roots, { domain, step: { slug: `fix-${slug}`, intent: slug } });
    quick[slug] = { domain, id, runId: `quick-${id}` };
  }
  gitOk(['add', '-A'], roots.specs);
  gitOk(['commit', '-m', 'nos: init'], roots.specs);
  return { root, roots, quick };
}

export const nos = (args, cwd, env) => invokeCli(args, { cwd, env });

export async function start(root, q, extra = []) {
  const res = await nos(['run', 'start', '--domain', q.domain, '--quick', String(q.id), ...extra], root);
  assert.equal(res.code, 0, res.err);
  return res.json;
}

export function commitIn(dir, file, text, message) {
  writeFile(dir, file, text);
  gitOk(['add', '--', file], dir);
  gitOk(['commit', '-m', message], dir);
  return gitOk(['rev-parse', 'HEAD'], dir);
}

export const done = (roots, q) => setStatus(roots, { domain: q.domain, step: String(q.id), status: 'done' });
export const quickStatus = (roots, q) =>
  readJson(roots.specs, `${q.domain}/quick-steps/quick-steps.json`).find((s) => quickStepId(s) === q.id).status;
export const head = (dir, ref = 'HEAD') => gitOk(['rev-parse', ref], dir);
export const read = (file) => readFileSync(file, 'utf8');
export const lastSpecsFiles = (roots) =>
  gitOk(['show', '--name-only', '--format=', 'HEAD'], roots.specs).split('\n').filter(Boolean).sort();
export const lastSpecsSubject = (roots) => gitOk(['log', '-1', '--format=%s'], roots.specs);
export const mergeHeld = (roots) => lockStatus(roots, 'merge').held;
export const branchExists = (dir, branch) =>
  git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { cwd: dir }).code === 0;
