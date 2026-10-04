import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asList, resolveDomain, PLAN_FILE } from './plan.js';
import { quickStepId, quickStepsPath, readQuickSteps, writeQuickSteps } from './quick-step.js';

export const STATUS_FILE_PATH = '.claude/skills/nos/templates/status.xml';
const CATEGORIES = { plan: 'plans', phase: 'phases', step: 'steps' };

export function readValidStatuses(root) {
  const file = path.join(root, STATUS_FILE_PATH);
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. set-status validates statuses against it`);
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

// Ids are not stored in plan.json; they are read back from each step's spec-file path.
function idsOf(step) {
  const specFile = step?.['spec-file'] ?? '';
  const match = specFile.match(/\/phase-(\d+)-[^/]+\/step-(\d+)-[^/]+\.md$/);
  return match ? { phase: Number(match[1]), step: Number(match[2]) } : {};
}

const phaseId = (phase) => asList(phase.steps).map(idsOf).find((ids) => ids.phase)?.phase;

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
  throw new Error(inPhase ? `Step ${id} is not in phase ${phaseId(inPhase)}` : `Step ${id} is not in this plan or its quick steps`);
}

export function setStatus(root, { domain, phase, step, status } = {}) {
  if (typeof status !== 'string' || !status.trim()) {
    throw new Error('Missing input: status. set-status requires the new status');
  }
  const domainDir = resolveDomain(root, domain, 'set-status');
  const phaseNumber = parseId(phase, 'phase');
  const stepNumber = parseId(step, 'step');

  const target = stepNumber ? 'step' : phaseNumber ? 'phase' : 'plan';
  const allowed = readValidStatuses(root)[CATEGORIES[target]];
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
      return { domain, planPath: quickStepsPath(domainDir), target, id: stepNumber, slug: quick.slug, previous, status, quick: true };
    }
    if (!plan) throw new Error(`Step ${stepNumber} is not a quick step of ${domain} and the domain has no plan.json`);
  }

  if (!plan) {
    throw new Error(`Domain ${domain} has no plan.json. Run create-plan first`);
  }

  const phases = asList(plan.phases);
  const parentPhase = phaseNumber ? findPhase(phases, phaseNumber) : undefined;
  const item = target === 'step' ? findStep(phases, stepNumber, parentPhase) : parentPhase ?? plan;

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

