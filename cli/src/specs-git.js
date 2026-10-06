import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './config.js';
import { FAILED, NosError, USAGE } from './exit-codes.js';
import { git, NO_PROMPT_ENV } from './git.js';
import { asList, PLAN_FILE } from './plan.js';
import { specsConfig } from './project-config.js';
import { sleepSync } from './proc.js';
import { quickStepId, QUICK_STEPS_DIR, QUICK_STEPS_FILE } from './quick-step.js';
import { slash, specFileOf, specPath } from './roots.js';
import { readRun } from './runs.js';

// The specs root is its own git repo. Only the orchestrator commits it, through commitSpecs: the add is
// scoped to config.json + one domain folder (exact, because a domain has at most one run). Never add -A.
const DOMAIN = /^domain-[1-9]\d*-[a-z0-9-]+$/;
const LOCK_RETRIES = 5;
const LOCK_DELAY_MS = 200;
export const PUSH_TIMEOUT_MS = 60_000;
// another git in the specs repo holds index.lock, HEAD.lock or a ref lock
const GIT_LOCKED = /\.lock'?:? File exists|index\.lock/;
// no hooks, no signing in the specs repo: a project's global hooks or gpg prompt never block a spec commit
const NO_HOOKS = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath='];

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// git in the specs repo, never prompting; a *.lock of another writer -> retried LOCK_RETRIES times, LOCK_DELAY_MS apart
function specsGit(roots, args, { timeout } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = git([...NO_HOOKS, ...args], { cwd: roots.specs, env: NO_PROMPT_ENV, timeout });
    if (res.code === 0 || attempt >= LOCK_RETRIES || !GIT_LOCKED.test(res.stderr)) return res;
    sleepSync(LOCK_DELAY_MS);
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

// The specs root must be the top of its own repo: git -C <specs> must never reach the project repo.
function assertSpecsRepo(roots) {
  const res = existsSync(roots.specs) ? specsGit(roots, ['rev-parse', '--show-toplevel']) : null;
  if (!res || res.code !== 0 || !samePath(real(res.stdout.trim()), real(roots.specs))) {
    throw new NosError(FAILED, `${slash(roots.specs)} is not its own git repo. Run nos init`);
  }
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

// Push to origin when there is something to push: after a commit, when HEAD is ahead of its upstream, or
// when the upstream is unknown (first push, -u sets it). { pushed, warning? }; never throws.
function push(roots, { committed, timeout }) {
  if (!committed) {
    const upstream = specsGit(roots, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream.code === 0) {
      const ahead = specsGit(roots, ['rev-list', '--count', '@{u}..HEAD']);
      if (ahead.code === 0 && Number(ahead.stdout.trim()) === 0) return { pushed: false };
    }
  }
  const res = specsGit(roots, ['push', '-q', '-u', 'origin', 'HEAD'], { timeout });
  if (res.code === 0) return { pushed: true };
  return { pushed: false, warning: `push to origin failed: ${(res.stderr || res.stdout).trim()}` };
}

// Commits config.json + <domain>/ of the specs repo (adds, changes, deletions), only when something is staged.
// domain null: config.json only. When specs.remote is set it pushes to origin (also an earlier commit a failed
// push left behind); a failed or timed out push (pushTimeoutMs, default 60s) is a warning, the commit stays.
// Returns { action: 'specs-commit', domain, committed, sha, pushed, files (absolute), warning? }.
export function commitSpecs(roots, { domain = null, message, pushTimeoutMs = PUSH_TIMEOUT_MS } = {}) {
  if (!message || !String(message).trim()) throw new NosError(USAGE, 'Missing input: -m <message>');
  if (domain !== null && !DOMAIN.test(domain ?? '')) {
    throw new NosError(USAGE, `Domain "${domain}" does not match "domain-<id>-<slug>"`);
  }
  assertSpecsRepo(roots);
  const known = (p) => existsSync(path.join(roots.specs, p)) || specsGit(roots, ['ls-files', '--', p]).stdout.trim();
  if (domain && !known(domain)) throw new NosError(FAILED, `Domain ${domain} does not exist in ${slash(roots.specs)}`);
  const paths = [CONFIG_FILE, ...(domain ? [domain] : [])].filter(known);
  const result = { action: 'specs-commit', domain, committed: false, sha: null, pushed: false, files: [] };

  if (paths.length) {
    // git add <pathspec> also stages deletions inside it (git 2), nothing outside it
    mustGit(roots, ['add', '--', ...paths]);
    const staged = mustGit(roots, ['diff', '--cached', '--name-only', '--', ...paths])
      .split(/\r?\n/)
      .filter(Boolean);
    if (staged.length) {
      // --only: files another writer staged meanwhile stay out of this commit
      mustGit(roots, ['commit', '-q', '-m', String(message), '--only', '--', ...paths]);
      result.committed = true;
      result.sha = mustGit(roots, ['rev-parse', 'HEAD']).trim();
      result.files = staged.map((file) => slash(path.join(roots.specs, file)));
    }
  }

  if (specsConfig(roots).remote) {
    const pushed = push(roots, { committed: result.committed, timeout: pushTimeoutMs });
    result.pushed = pushed.pushed;
    if (pushed.warning) result.warning = pushed.warning;
  }
  return result;
}

// Step ids are read from spec-file paths: .../phase-<id>-<slug>/step-<id>-<slug>.md
function planIds(step) {
  const match = specFileOf(step).match(/\/phase-(\d+)-[^/]+\/step-(\d+)-[^/]+\.md$/);
  return match ? { phase: Number(match[1]), step: Number(match[2]) } : {};
}

// The steps of a domain as [{ kind, phase, step }]; a file that cannot be read adds a warning and is skipped.
function stepsOf(roots, domain, warnings) {
  const dir = path.join(roots.specs, domain);
  const read = (file, use) => {
    if (!existsSync(file)) return [];
    try {
      return use(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      warnings.push(`skipped ${slash(file)}: ${err.message}`);
      return [];
    }
  };
  const plan = read(path.join(dir, PLAN_FILE), (json) =>
    asList(json.phases).flatMap((phase) =>
      asList(phase.steps).map((step) => ({ kind: 'plan', ...planIds(step), entry: step })),
    ),
  );
  const quick = read(path.join(dir, QUICK_STEPS_DIR, QUICK_STEPS_FILE), (json) => {
    if (!Array.isArray(json)) throw new Error('not an array of quick steps');
    return json.map((step) => ({ kind: 'quick', phase: null, step: quickStepId(step), entry: step }));
  });
  return [...plan, ...quick];
}

// The step with this id in any domain: plan steps (plan.json) and quick steps (quick-steps.json).
// Returns { action: 'find-step', id, domain, kind: 'plan'|'quick', phase (id, null for quick), step (id),
// slug, intent, status, specFile (absolute), warnings? }. Unreadable files are skipped with a warning.
// Not found -> NosError FAILED (details.warnings).
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
  const warnings = [];
  for (const domain of domains) {
    const hit = stepsOf(roots, domain, warnings).find((s) => s.step === stepId);
    if (!hit) continue;
    const { entry } = hit;
    return {
      action: 'find-step',
      id: stepId,
      domain,
      kind: hit.kind,
      phase: hit.phase,
      step: stepId,
      slug: entry.slug ?? null,
      intent: entry.intent ?? null,
      status: entry.status ?? null,
      specFile: slash(specPath(roots, specFileOf(entry))),
      ...(warnings.length && { warnings }),
    };
  }
  throw new NosError(FAILED, `Step ${stepId} is in no plan.json or quick-steps.json of ${slash(roots.specs)}`, {
    warnings,
  });
}
