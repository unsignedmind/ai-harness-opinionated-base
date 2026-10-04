import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reserveIds, specsDir, SPECS_DIR } from './config.js';
import { assertSlug } from './slug.js';

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

export function resolveDomain(root, domain, command = 'create-plan') {
  if (!domain) {
    throw new Error(`Missing input: domain. ${command} requires a "domain-<id>-<slug>" folder name`);
  }
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`Domain "${domain}" does not match "domain-<id>-<slug>"`);
  }
  const domainDir = path.join(specsDir(root), domain);
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

export function createPlan(root, { domain, plan } = {}) {
  const domainDir = resolveDomain(root, domain);
  const parsed = parsePlan(plan);
  const phases = validatePlan(parsed);
  const planPath = path.join(domainDir, PLAN_FILE);
  if (existsSync(planPath)) {
    throw new Error(`Domain ${domain} already has a plan.json`);
  }

  const phasesDir = path.join(domainDir, PHASES_DIR);
  mkdirSync(phasesDir, { recursive: true });

  const created = phases.map((phase) => {
    const [phaseId] = reserveIds(root, 'phase');
    const phaseFolder = `phase-${phaseId}-${phase.slug}`;
    const phaseDir = path.join(phasesDir, phaseFolder);
    mkdirSync(phaseDir);

    const steps = asList(phase.steps);
    const stepIds = reserveIds(root, 'step', steps.length);
    const createdSteps = steps.map((step, j) => {
      const file = `step-${stepIds[j]}-${step.slug}.md`;
      const stepPath = path.join(phaseDir, file);
      writeFileSync(stepPath, '');
      step['spec-file'] = [SPECS_DIR, domain, PHASES_DIR, phaseFolder, file].join('/');
      return { id: stepIds[j], file, path: stepPath, specFile: step['spec-file'] };
    });

    return { id: phaseId, folder: phaseFolder, path: phaseDir, steps: createdSteps };
  });

  writeFileSync(planPath, JSON.stringify(parsed, null, 2) + '\n');
  return { domain, planPath, phases: created };
}
