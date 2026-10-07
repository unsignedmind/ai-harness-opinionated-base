import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { templatePath, writeJsonFile } from './config.js';
import { FAILED, NosError, USAGE } from './exit-codes.js';
import { asList, resolveDomain, PLAN_FILE } from './plan.js';
import { quickStepId, quickStepsPath, readQuickSteps, writeQuickSteps } from './quick-step.js';
import { slash, specFileOf } from './roots.js';
import { parseRunId, readRun } from './runs.js';

export const STATUS_FILE = 'status.xml';
// set only for a whole run (set-status --run), by nos run finish (merged) and nos run abandon (discarded)
export const RUN_STATUSES = Object.freeze(['merged', 'discarded']);
const CATEGORIES = { plan: 'plans', phase: 'phases', step: 'steps' };

// status.xml of the running nos (roots.home/templates)
export const statusFilePath = (roots) => templatePath(roots, STATUS_FILE);

export function readValidStatuses(roots) {
  const file = statusFilePath(roots);
  if (!existsSync(file)) {
    throw new Error(`Missing ${slash(file)}. set-status validates statuses against it`);
  }
  const xml = readFileSync(file, 'utf8');
  const section = (tag) => {
    const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!match) throw new Error(`${file} has no <${tag}> section`);
    return [...match[1].matchAll(/<name>\s*([^<]*?)\s*<\/name>/g)].map((m) => m[1]);
  };
  return { plans: section('plans'), phases: section('phases'), steps: section('steps') };
}

function parseId(value, label) {
  if (value == null) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value).trim()) {
    throw new Error(`Invalid ${label} id "${value}". Use a positive whole number`);
  }
  return id;
}

// Ids are not stored in plan.json; they are read back from each step's spec-file path
// (relative to the specs root: <domain>/phases/phase-<id>-<slug>/step-<id>-<slug>.md).
function idsOf(step) {
  const match = specFileOf(step).match(/\/phase-(\d+)-[^/]+\/step-(\d+)-[^/]+\.md$/);
  return match ? { phase: Number(match[1]), step: Number(match[2]) } : {};
}

const phaseId = (phase) =>
  asList(phase.steps)
    .map(idsOf)
    .find((ids) => ids.phase)?.phase;

function findPhase(phases, id) {
  const phase = phases.find((p) => phaseId(p) === id);
  if (!phase) throw new Error(`Phase ${id} is not in this plan`);
  return phase;
}

function readPlan(planPath) {
  try {
    return JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${planPath}: ${err.message}`);
  }
}

function hasStep(phases, id) {
  return phases.some((phase) => asList(phase.steps).some((s) => idsOf(s).step === id));
}

function findStep(phases, id, inPhase) {
  for (const phase of inPhase ? [inPhase] : phases) {
    const step = asList(phase.steps).find((s) => idsOf(s).step === id);
    if (step) return step;
  }
  throw new Error(
    inPhase ? `Step ${id} is not in phase ${phaseId(inPhase)}` : `Step ${id} is not in this plan or its quick steps`,
  );
}

export function setStatus(roots, { domain, phase, step, status } = {}) {
  if (typeof status !== 'string' || !status.trim()) {
    throw new Error('Missing input: status. set-status requires the new status');
  }
  if (RUN_STATUSES.includes(status)) {
    throw new NosError(
      FAILED,
      `Status "${status}" is set only for a whole run, by nos run finish (merged) or nos run abandon (discarded): ` +
        `nos set-status --run <kind>-<id> ${status}`,
    );
  }
  const domainDir = resolveDomain(roots, domain, 'set-status');
  const phaseNumber = parseId(phase, 'phase');
  const stepNumber = parseId(step, 'step');

  const target = stepNumber ? 'step' : phaseNumber ? 'phase' : 'plan';
  const allowed = readValidStatuses(roots)[CATEGORIES[target]];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid status "${status}" for a ${target}. Valid statuses: ${allowed.join(', ')}`);
  }

  const planPath = path.join(domainDir, PLAN_FILE);
  const plan = existsSync(planPath) ? readPlan(planPath) : null;

  // A step id without --phase may also be a quick step of the domain (quick-steps/quick-steps.json).
  if (target === 'step' && !phaseNumber && !(plan && hasStep(asList(plan.phases), stepNumber))) {
    const quickSteps = readQuickSteps(domainDir);
    const quick = quickSteps.find((s) => quickStepId(s) === stepNumber);
    if (quick) {
      const previous = quick.status;
      quick.status = status;
      writeQuickSteps(domainDir, quickSteps);
      return {
        domain,
        planPath: quickStepsPath(domainDir),
        target,
        id: stepNumber,
        slug: quick.slug,
        previous,
        status,
        quick: true,
      };
    }
    if (!plan) throw new Error(`Step ${stepNumber} is not a quick step of ${domain} and the domain has no plan.json`);
  }

  if (!plan) {
    throw new Error(`Domain ${domain} has no plan.json. Run create-plan first`);
  }

  const phases = asList(plan.phases);
  const parentPhase = phaseNumber ? findPhase(phases, phaseNumber) : undefined;
  const item = target === 'step' ? findStep(phases, stepNumber, parentPhase) : (parentPhase ?? plan);

  const previous = item.status;
  item.status = status;
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');

  return {
    domain,
    planPath,
    target,
    id: target === 'step' ? stepNumber : target === 'phase' ? phaseNumber : undefined,
    slug: item.slug,
    previous,
    status,
  };
}

// The domain of a run: its run file, else (plan) the domain-<id>-* folder or (quick) the domain whose
// quick-steps.json has the step.
function domainOfRun(roots, kind, id) {
  const file = readRun(roots, `${kind}-${id}`);
  if (file?.domain) return file.domain;
  let domains = [];
  try {
    domains = readdirSync(roots.specs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^domain-\d+-[a-z0-9-]+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    // no specs root: nothing found
  }
  const found =
    kind === 'plan'
      ? domains.find((d) => d.startsWith(`domain-${id}-`))
      : domains.find((d) => readQuickSteps(path.join(roots.specs, d)).some((s) => quickStepId(s) === id));
  if (!found) throw new NosError(FAILED, `No ${kind === 'plan' ? 'domain' : 'quick step'} for run ${kind}-${id}`);
  return found;
}

// One transition of set-status --run. merged: done -> merged (merged stays). discarded: anything except
// merged -> discarded (discarded stays); a merged step of a discarded plan keeps merged (keepMerged).
function transition(status, previous, { keepMerged = false } = {}) {
  if (previous === status) return 'same';
  if (status === 'merged') return previous === 'done' ? 'flip' : 'violation';
  if (previous === 'merged') return keepMerged ? 'same' : 'violation';
  return 'flip';
}

// set-status --run <kind>-<id> merged|discarded: flips the plan and its steps (phases unchanged) or the quick
// step of a run, one write per file. Plan merged: plan and steps done -> merged. Plan discarded: plan and every
// step not merged -> discarded. Quick: done -> merged, or anything except merged -> discarded. Targets already
// at the status stay (a crashed finish or abandon reruns it). A violation -> NosError FAILED
// { violations }, nothing written. dryRun: checks only. A POC run (poc-<slug>) has no statuses -> FAILED.
// Returns { action: 'set-status', run, domain, status, file, changes: [{ target, id, slug, previous, status }] }.
export function setRunStatus(roots, { run, status, dryRun = false } = {}) {
  const { runId, kind, id } = parseRunId(run);
  if (kind === 'poc') throw new NosError(FAILED, `${runId}: a POC has no statuses (nos run abandon ends it)`);
  if (!RUN_STATUSES.includes(status)) {
    throw new NosError(USAGE, `set-status --run takes ${RUN_STATUSES.join(' or ')}, not "${status ?? ''}"`);
  }
  const valid = readValidStatuses(roots);
  for (const category of ['plans', 'steps']) {
    if (!valid[category].includes(status)) {
      throw new NosError(FAILED, `${slash(statusFilePath(roots))} has no status "${status}" in <${category}>`);
    }
  }
  const domain = domainOfRun(roots, kind, id);
  const domainDir = path.join(roots.specs, domain);
  const changes = [];
  const violations = [];
  const apply = (target, targetId, item, options) => {
    const previous = item.status ?? null;
    const result = transition(status, previous, options);
    if (result === 'violation') violations.push({ target, id: targetId, slug: item.slug ?? null, status: previous });
    if (result !== 'flip') return;
    changes.push({ target, id: targetId, slug: item.slug ?? null, previous, status });
    item.status = status;
  };

  let file;
  let data;
  if (kind === 'plan') {
    file = path.join(domainDir, PLAN_FILE);
    if (!existsSync(file)) throw new NosError(FAILED, `Domain ${domain} has no plan.json`);
    data = readPlan(file);
    apply('plan', id, data);
    for (const phase of asList(data.phases)) {
      for (const step of asList(phase.steps)) apply('step', idsOf(step).step ?? null, step, { keepMerged: true });
    }
  } else {
    file = quickStepsPath(domainDir);
    data = readQuickSteps(domainDir);
    const step = data.find((s) => quickStepId(s) === id);
    if (!step) throw new NosError(FAILED, `Quick step ${id} is not in ${slash(file)}`);
    apply('step', id, step);
  }

  if (violations.length) {
    const list = violations.map((v) => `${v.target} ${v.id ?? v.slug} is ${v.status ?? 'without status'}`).join(', ');
    const need = status === 'merged' ? 'every target must be done' : 'nothing may be merged';
    throw new NosError(FAILED, `Cannot set ${runId} to ${status}: ${list} (${need})`, { run: runId, violations });
  }
  if (changes.length && !dryRun) writeJsonFile(file, data);
  return {
    action: 'set-status',
    run: runId,
    domain,
    status,
    file: slash(file),
    changes,
    ...(dryRun && { dryRun: true }),
  };
}
