import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reserveIds, specsDir } from './config.js';
import { defaultName, DOMAIN_FILE, listIdeaFiles, normalizeIdeaFile, plannedIdeas } from './domain.js';
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

const firstPlanStatus = (roots) => (existsSync(statusFilePath(roots)) ? readValidStatuses(roots).plans[0] : 'open');

// name from domain.json, else the heading of the first idea; status: first plan status of status.xml (open)
function hollowPlan(roots, domainDir, domain) {
  const meta = readJsonOr(path.join(domainDir, DOMAIN_FILE), {});
  const [ideaFile] = listIdeaFiles(domainDir);
  const idea = ideaFile ? readFileSync(path.join(domainDir, ideaFile), 'utf8') : '';
  const slug = domain.replace(/^domain-\d+-/, '');
  const name = (typeof meta?.name === 'string' && meta.name.trim()) || defaultName(idea, slug);
  return { name, status: firstPlanStatus(roots), phases: [] };
}

// The idea files to plan: the given ones (each must exist and be unplanned), else every unplanned idea file
function ideasToPlan(domainDir, domain, ideas, planned) {
  const existing = listIdeaFiles(domainDir);
  const open = existing.filter((file) => !planned.includes(file));
  const given = asList(typeof ideas === 'string' ? ideas.split(',') : ideas)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map(normalizeIdeaFile);
  if (!given.length) {
    if (planned.length && !open.length) throw new Error(`Every idea of ${domain} is planned already`);
    return open;
  }
  for (const file of given) {
    if (!existing.includes(file)) throw new Error(`Idea ${domain}/${file} does not exist`);
    if (planned.includes(file)) throw new Error(`Idea ${domain}/${file} is planned already`);
  }
  return [...new Set(given)];
}

// Plans the given ideas of a domain. A domain with a plan already (phases) gets the new phases appended: the plan is
// reopened (first plan status) and runs again; its earlier phases and steps keep their statuses.
export function createPlan(roots, { domain, plan, ideas, hollow = false } = {}) {
  const domainDir = resolveDomain(roots, domain);
  const planPath = path.join(domainDir, PLAN_FILE);
  if (hollow) {
    if (plan != null) throw new Error('create-plan --hollow takes no plan');
    if (ideas != null) throw new Error('create-plan --hollow takes no ideas');
    if (existsSync(planPath)) throw new Error(`Domain ${domain} already has a plan.json`);
    writeFileSync(planPath, JSON.stringify(hollowPlan(roots, domainDir, domain), null, 2) + '\n');
    return { domain, planPath, phases: [], hollow: true };
  }
  const parsed = parsePlan(plan);
  const phases = validatePlan(parsed);

  // an existing plan with phases is appended to; a hollow one is replaced
  const current = existsSync(planPath) && !isHollowPlan(domainDir) ? readJsonOr(planPath, null) : null;
  if (existsSync(planPath) && !isHollowPlan(domainDir) && !asList(current?.phases).length) {
    throw new Error(`Domain ${domain} already has a plan.json that is not valid or has no phases but phase folders`);
  }
  const planned = plannedIdeas(current);
  const planIdeas = ideasToPlan(domainDir, domain, ideas, planned);
  if (current) {
    const taken = new Set(asList(current.phases).map((p) => p?.slug));
    const clash = phases.find((p) => taken.has(p.slug));
    if (clash) throw new Error(`Phase slug "${clash.slug}" is already in the plan of ${domain}`);
  }

  const phasesDir = path.join(domainDir, PHASES_DIR);
  mkdirSync(phasesDir, { recursive: true });

  const created = phases.map((phase) => {
    const [phaseId] = reserveIds(roots, 'phase');
    const phaseFolder = `phase-${phaseId}-${phase.slug}`;
    const phaseDir = path.join(phasesDir, phaseFolder);
    mkdirSync(phaseDir);
    if (planIdeas.length) phase.ideas = planIdeas;

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

  const result = current
    ? {
        ...current,
        status: firstPlanStatus(roots),
        ideas: [...planned, ...planIdeas],
        phases: [...asList(current.phases), ...phases],
      }
    : { ...parsed, ideas: planIdeas, phases: parsed.phases };
  writeFileSync(planPath, JSON.stringify(result, null, 2) + '\n');
  return { domain, planPath, ideas: planIdeas, appended: Boolean(current), phases: created };
}
