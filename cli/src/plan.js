import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reserveIds, specsDir } from './config.js';
import { defaultName, DOMAIN_FILE, IDEA_FILE } from './domain.js';
import { assertSlug } from './slug.js';
import { readValidStatuses, statusFilePath } from './status.js';

export const PLAN_FILE = 'plan.json';
export const PHASES_DIR = 'phases';
const DOMAIN_PATTERN = /^domain-\d+-[a-z0-9-]+$/;

export const asList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

// Labels belong to the domain (domain.json), so a plan never keeps them.
export function parsePlan(plan, command = 'create-plan') {
  if (plan == null || plan === '') {
    throw new Error(`Missing input: plan. ${command} requires the plan.json content`);
  }
  let parsed;
  if (typeof plan !== 'string') parsed = structuredClone(plan);
  else {
    try {
      parsed = JSON.parse(plan);
    } catch (err) {
      throw new Error(`Invalid plan JSON: ${err.message}`);
    }
  }
  if (parsed && typeof parsed === 'object') delete parsed.labels;
  return parsed;
}

export function resolveDomain(roots, domain, command = 'create-plan') {
  if (!domain) {
    throw new Error(`Missing input: domain. ${command} requires a "domain-<id>-<slug>" folder name`);
  }
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`Domain "${domain}" does not match "domain-<id>-<slug>"`);
  }
  const domainDir = path.join(specsDir(roots), domain);
  if (!existsSync(domainDir)) {
    throw new Error(`Domain folder ${domainDir} does not exist`);
  }
  return domainDir;
}

export function validatePlan(plan) {
  const phases = asList(plan?.phases);
  if (phases.length === 0) {
    throw new Error('Plan must contain at least one phase');
  }
  phases.forEach((phase, i) => {
    assertSlug(phase?.slug, `slug of phase ${i + 1}`);
    const steps = asList(phase.steps);
    if (steps.length === 0) throw new Error(`Phase "${phase.slug}" has no steps`);
    steps.forEach((step, j) => assertSlug(step?.slug, `slug of step ${j + 1} in phase "${phase.slug}"`));
  });
  return phases;
}

const readJsonOr = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// A hollow plan.json (from create-plan --hollow) has no phases and no phase folders exist yet.
// It promotes the domain without planning it; a later create-plan fills it.
export function isHollowPlan(domainDir) {
  const plan = readJsonOr(path.join(domainDir, PLAN_FILE), null);
  if (!plan || typeof plan !== 'object' || asList(plan.phases).length) return false;
  const phasesDir = path.join(domainDir, PHASES_DIR);
  return !existsSync(phasesDir) || !readdirSync(phasesDir).some((f) => f.startsWith('phase-'));
}

// name from domain.json, else the idea heading; status: first plan status of status.xml (open)
function hollowPlan(roots, domainDir, domain) {
  const meta = readJsonOr(path.join(domainDir, DOMAIN_FILE), {});
  const ideaPath = path.join(domainDir, IDEA_FILE);
  const idea = existsSync(ideaPath) ? readFileSync(ideaPath, 'utf8') : '';
  const slug = domain.replace(/^domain-\d+-/, '');
  const name = (typeof meta?.name === 'string' && meta.name.trim()) || defaultName(idea, slug);
  const status = existsSync(statusFilePath(roots)) ? readValidStatuses(roots).plans[0] : 'open';
  return { name, status, phases: [] };
}

export function createPlan(roots, { domain, plan, hollow = false } = {}) {
  const domainDir = resolveDomain(roots, domain);
  const planPath = path.join(domainDir, PLAN_FILE);
  if (hollow) {
    if (plan != null) throw new Error('create-plan --hollow takes no plan');
    if (existsSync(planPath)) throw new Error(`Domain ${domain} already has a plan.json`);
    writeFileSync(planPath, JSON.stringify(hollowPlan(roots, domainDir, domain), null, 2) + '\n');
    return { domain, planPath, phases: [], hollow: true };
  }
  const parsed = parsePlan(plan);
  const phases = validatePlan(parsed);
  if (existsSync(planPath) && !isHollowPlan(domainDir)) {
    throw new Error(`Domain ${domain} already has a plan.json`);
  }

  const phasesDir = path.join(domainDir, PHASES_DIR);
  mkdirSync(phasesDir, { recursive: true });

  const created = phases.map((phase) => {
    const [phaseId] = reserveIds(roots, 'phase');
    const phaseFolder = `phase-${phaseId}-${phase.slug}`;
    const phaseDir = path.join(phasesDir, phaseFolder);
    mkdirSync(phaseDir);

    const steps = asList(phase.steps);
    const stepIds = reserveIds(roots, 'step', steps.length);
    const createdSteps = steps.map((step, j) => {
      const file = `step-${stepIds[j]}-${step.slug}.md`;
      const stepPath = path.join(phaseDir, file);
      writeFileSync(stepPath, '');
      step['spec-file'] = [domain, PHASES_DIR, phaseFolder, file].join('/');
      return { id: stepIds[j], file, path: stepPath, specFile: step['spec-file'] };
    });

    return { id: phaseId, folder: phaseFolder, path: phaseDir, steps: createdSteps };
  });

  writeFileSync(planPath, JSON.stringify(parsed, null, 2) + '\n');
  return { domain, planPath, phases: created };
}
