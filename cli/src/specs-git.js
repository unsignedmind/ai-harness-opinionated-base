import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './config.js';
import { FAILED, NosError, USAGE } from './exit-codes.js';
import { git } from './git.js';
import { asList, PLAN_FILE } from './plan.js';
import { specsConfig } from './project-config.js';
import { sleepSync } from './proc.js';
import { quickStepId, readQuickSteps } from './quick-step.js';
import { slash, specFileOf, specPath } from './roots.js';
import { readRun } from './runs.js';

// The specs root is its own git repo. Only the orchestrator commits it, through commitSpecs: the add is
// scoped to config.json + one domain folder (exact, because a domain has at most one run). Never add -A.
const DOMAIN = /^domain-[1-9]\d*-[a-z0-9-]+$/;
const INDEX_LOCK_RETRIES = 5;
const INDEX_LOCK_DELAY_MS = 200;

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// The specs root must be the top of its own repo: git -C <specs> must never reach the project repo.
function assertSpecsRepo(roots) {
  const res = existsSync(roots.specs) ? git(['rev-parse', '--show-toplevel'], { cwd: roots.specs }) : null;
  if (!res || res.code !== 0 || !samePath(real(res.stdout.trim()), real(roots.specs))) {
    throw new NosError(FAILED, `${slash(roots.specs)} is not its own git repo. Run nos init`);
  }
}

// git in the specs repo; another writer's index.lock -> retried INDEX_LOCK_RETRIES times, INDEX_LOCK_DELAY_MS apart
function specsGit(roots, args) {
  for (let attempt = 0; ; attempt++) {
    const res = git(args, { cwd: roots.specs });
    if (res.code === 0 || attempt >= INDEX_LOCK_RETRIES || !/index\.lock/.test(res.stderr)) return res;
    sleepSync(INDEX_LOCK_DELAY_MS);
  }
}

function mustGit(roots, args) {
  const res = specsGit(roots, args);
  if (res.code !== 0) {
    throw new NosError(
      FAILED,
      `git -C ${slash(roots.specs)} ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`,
    );
  }
  return res.stdout;
}

// The domain to commit: of a run file (--run), the given one (--domain), or null for config.json only
// (--config). Exactly one of the three.
export function domainOfTarget(roots, { run, domain, config = false } = {}) {
  const given = [run, domain, config].filter(Boolean).length;
  if (given !== 1) {
    throw new NosError(
      USAGE,
      `${given ? 'Give only one' : 'Missing input: one'} of --run <kind>-<id>, --domain <domain>, --config`,
    );
  }
  if (config) return null;
  if (domain) return domain;
  const file = readRun(roots, run);
  if (!file) throw new NosError(FAILED, `No run ${run} in ${slash(path.join(roots.specs, '.runs'))}`);
  return file.domain;
}

// Commits config.json + <domain>/ of the specs repo (adds, changes, deletions), only when something is staged.
// domain null: config.json only. Pushes to origin when specs.remote is set; a failed push is a warning, the
// commit stays. Returns { action: 'specs-commit', domain, committed, sha, pushed, files (absolute), warning? }.
export function commitSpecs(roots, { domain = null, message } = {}) {
  if (!message || !String(message).trim()) throw new NosError(USAGE, 'Missing input: -m <message>');
  if (domain !== null && !DOMAIN.test(domain ?? '')) {
    throw new NosError(USAGE, `Domain "${domain}" does not match "domain-<id>-<slug>"`);
  }
  assertSpecsRepo(roots);
  const known = (p) => existsSync(path.join(roots.specs, p)) || specsGit(roots, ['ls-files', '--', p]).stdout.trim();
  if (domain && !known(domain)) throw new NosError(FAILED, `Domain ${domain} does not exist in ${slash(roots.specs)}`);
  const paths = [CONFIG_FILE, ...(domain ? [domain] : [])].filter(known);
  const result = { action: 'specs-commit', domain, committed: false, sha: null, pushed: false, files: [] };
  if (paths.length === 0) return result;

  // git add <pathspec> also stages deletions inside it (git 2), nothing outside it
  mustGit(roots, ['add', '--', ...paths]);
  const staged = mustGit(roots, ['diff', '--cached', '--name-only', '--', ...paths])
    .split(/\r?\n/)
    .filter(Boolean);
  if (staged.length === 0) return result;

  // --only: files another writer staged meanwhile stay out of this commit
  mustGit(roots, ['commit', '-q', '-m', String(message), '--only', '--', ...paths]);
  result.committed = true;
  result.sha = mustGit(roots, ['rev-parse', 'HEAD']).trim();
  result.files = staged.map((file) => slash(path.join(roots.specs, file)));

  if (specsConfig(roots).remote) {
    const push = specsGit(roots, ['push', '-q', 'origin', 'HEAD']);
    result.pushed = push.code === 0;
    if (!result.pushed) result.warning = `push to origin failed: ${(push.stderr || push.stdout).trim()}`;
  }
  return result;
}

// Step ids are read from spec-file paths: .../phase-<id>-<slug>/step-<id>-<slug>.md
function planIds(step) {
  const match = specFileOf(step).match(/\/phase-(\d+)-[^/]+\/step-(\d+)-[^/]+\.md$/);
  return match ? { phase: Number(match[1]), step: Number(match[2]) } : {};
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
}

// The step with this id in any domain: plan steps (plan.json) and quick steps (quick-steps.json).
// Returns { action: 'find-step', id, domain, kind: 'plan'|'quick', phase (id, null for quick), step (id),
// slug, intent, status, specFile (absolute) }. Not found -> NosError FAILED.
export function findStep(roots, id) {
  const stepId = Number(id);
  if (!Number.isInteger(stepId) || stepId < 1 || String(stepId) !== String(id).trim()) {
    throw new NosError(USAGE, `Invalid step id "${id}". Use a positive whole number`);
  }
  let domains = [];
  try {
    domains = readdirSync(roots.specs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DOMAIN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    // no specs root: nothing to find
  }
  const hit = (domain, kind, phase, step) => ({
    action: 'find-step',
    id: stepId,
    domain,
    kind,
    phase,
    step: stepId,
    slug: step.slug ?? null,
    intent: step.intent ?? null,
    status: step.status ?? null,
    specFile: slash(specPath(roots, specFileOf(step))),
  });
  for (const domain of domains) {
    const dir = path.join(roots.specs, domain);
    const planFile = path.join(dir, PLAN_FILE);
    if (existsSync(planFile)) {
      for (const phase of asList(readJson(planFile).phases)) {
        for (const step of asList(phase.steps)) {
          const ids = planIds(step);
          if (ids.step === stepId) return hit(domain, 'plan', ids.phase, step);
        }
      }
    }
    const quick = readQuickSteps(dir).find((step) => quickStepId(step) === stepId);
    if (quick) return hit(domain, 'quick', null, quick);
  }
  throw new NosError(FAILED, `Step ${stepId} is in no plan.json or quick-steps.json of ${slash(roots.specs)}`);
}
