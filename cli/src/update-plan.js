import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { peekIds, reserveIds, SPECS_DIR } from './config.js';
import { asList, parsePlan, resolveDomain, validatePlan, PHASES_DIR, PLAN_FILE } from './plan.js';

const PHASE_FOLDER = /^phase-(\d+)-([a-z0-9-]+)$/;
const STEP_FILE = /^step-(\d+)-([a-z0-9-]+)\.md$/;

// Phases and steps as they exist on disk, the source of truth for what already exists.
function scanPhases(root, domain, phasesDir) {
  if (!existsSync(phasesDir)) return [];
  return readdirSync(phasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PHASE_FOLDER.test(entry.name))
    .map((entry) => {
      const [, id, slug] = entry.name.match(PHASE_FOLDER);
      const dir = path.join(phasesDir, entry.name);
      const steps = [];
      const otherFiles = [];
      for (const child of readdirSync(dir, { withFileTypes: true })) {
        const match = child.isFile() && child.name.match(STEP_FILE);
        if (!match) {
          otherFiles.push(path.join(dir, child.name));
          continue;
        }
        const stepPath = path.join(dir, child.name);
        steps.push({
          id: Number(match[1]),
          file: child.name,
          path: stepPath,
          specFile: [SPECS_DIR, domain, PHASES_DIR, entry.name, child.name].join('/'),
          empty: statSync(stepPath).size === 0,
        });
      }
      return { id: Number(id), slug, folder: entry.name, dir, steps, otherFiles };
    });
}

function indexExisting(existing) {
  const phasesBySlug = new Map();
  const stepsBySpec = new Map();
  for (const phase of existing) {
    if (phasesBySlug.has(phase.slug)) {
      throw new Error(`Two phase folders use the slug "${phase.slug}": ${phasesBySlug.get(phase.slug).folder}, ${phase.folder}`);
    }
    phasesBySlug.set(phase.slug, phase);
    for (const step of phase.steps) stepsBySpec.set(step.specFile, step);
  }
  return { phasesBySlug, stepsBySpec };
}

// Matches the updated plan against disk: phases by slug, steps by spec-file. Throws before anything is written.
function matchPlan(phases, domain, { phasesBySlug, stepsBySpec }) {
  const slugs = new Set();
  const specs = new Set();
  return phases.map((phase) => {
    if (slugs.has(phase.slug)) throw new Error(`Phase slug "${phase.slug}" is used twice in the plan`);
    slugs.add(phase.slug);

    const steps = asList(phase.steps).map((step) => {
      const specFile = String(step['spec-file'] ?? '').trim().replaceAll('\\', '/');
      if (!specFile) return { step, source: null };
      const source = stepsBySpec.get(specFile);
      if (!source) {
        throw new Error(
          `Step "${step.slug}" in phase "${phase.slug}" has spec-file "${specFile}", which is not a step file of ${domain}. ` +
            'Leave spec-file empty to create a new step',
        );
      }
      if (specs.has(specFile)) throw new Error(`spec-file "${specFile}" is used by more than one step`);
      specs.add(specFile);
      return { step, source };
    });
    return { phase, existing: phasesBySlug.get(phase.slug) ?? null, steps };
  });
}

export function updatePlan(root, { domain, plan, force = false, dryRun = false } = {}) {
  const domainDir = resolveDomain(root, domain, 'update-plan');
  const parsed = parsePlan(plan, 'update-plan');
  const phases = validatePlan(parsed);
  const planPath = path.join(domainDir, PLAN_FILE);
  if (!existsSync(planPath)) {
    throw new Error(`Domain ${domain} has no plan.json. Run create-plan first`);
  }

  const phasesDir = path.join(domainDir, PHASES_DIR);
  const existing = scanPhases(root, domain, phasesDir);
  const matched = matchPlan(phases, domain, indexExisting(existing));

  const keptPhases = new Set(matched.map((m) => m.existing).filter(Boolean));
  const keptSteps = new Set(matched.flatMap((m) => m.steps.map((s) => s.source)).filter(Boolean));
  const removedPhases = existing.filter((phase) => !keptPhases.has(phase));
  const removedSteps = existing.flatMap((phase) => phase.steps).filter((step) => !keptSteps.has(step));

  const withContent = [
    ...removedSteps.filter((step) => !step.empty).map((step) => step.path),
    ...removedPhases.flatMap((phase) => phase.otherFiles),
  ];
  if (withContent.length > 0 && !force) {
    throw new Error(
      `The update would delete files with content: ${withContent.map((f) => rel(root, f)).join(', ')}. ` +
        'Keep their spec-file in the plan, or pass --force to delete them',
    );
  }

  const takeIds = dryRun ? peekIds : reserveIds;
  const newPhaseCount = matched.filter((m) => !m.existing).length;
  const newStepCount = matched.reduce((n, m) => n + m.steps.filter((s) => !s.source).length, 0);
  const phaseIds = newPhaseCount ? takeIds(root, 'phase', newPhaseCount) : [];
  const stepIds = newStepCount ? takeIds(root, 'step', newStepCount) : [];

  const changes = { created: { phases: [], steps: [] }, moved: [], deleted: { phases: [], steps: [] } };
  const specPath = (folder, file) => [SPECS_DIR, domain, PHASES_DIR, folder, file].join('/');
  const operations = [];

  for (const { phase, existing: kept, steps } of matched) {
    const phaseId = kept ? kept.id : phaseIds.shift();
    const folder = kept ? kept.folder : `phase-${phaseId}-${phase.slug}`;
    if (!kept) {
      changes.created.phases.push({ id: phaseId, folder, path: [SPECS_DIR, domain, PHASES_DIR, folder].join('/') });
      operations.push(() => mkdirSync(path.join(phasesDir, folder), { recursive: true }));
    }
    for (const { step, source } of steps) {
      const stepId = source ? source.id : stepIds.shift();
      const target = specPath(folder, `step-${stepId}-${step.slug}.md`);
      if (!source) {
        changes.created.steps.push({ id: stepId, path: target });
        operations.push(() => writeFileSync(abs(root, target), ''));
      } else if (source.specFile !== target) {
        changes.moved.push({ id: stepId, from: source.specFile, to: target });
        operations.push(() => renameSync(source.path, abs(root, target)));
      }
      step['spec-file'] = target;
    }
  }

  for (const step of removedSteps) {
    changes.deleted.steps.push({ id: step.id, path: step.specFile, empty: step.empty });
    operations.push(() => rmSync(step.path));
  }
  for (const phase of removedPhases) {
    changes.deleted.phases.push({ id: phase.id, folder: phase.folder, path: rel(root, phase.dir) });
    operations.push(() => rmSync(phase.dir, { recursive: true, force: true }));
  }

  if (!dryRun) {
    // Order matters: new folders exist before steps move into them; steps leave a phase before it is deleted.
    operations.forEach((operation) => operation());
    writeFileSync(planPath, JSON.stringify(parsed, null, 2) + '\n');
  }
  return { domain, planPath, dryRun, ...changes };
}

const rel = (root, target) => path.relative(root, target).split(path.sep).join('/');
const abs = (root, specFile) => path.join(root, ...specFile.split('/'));
