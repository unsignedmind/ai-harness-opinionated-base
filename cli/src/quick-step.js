import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reserveIds, SPECS_DIR } from './config.js';
import { resolveDomain } from './plan.js';
import { assertSlug } from './slug.js';

export const QUICK_STEPS_DIR = 'quick-steps';
export const QUICK_STEPS_FILE = 'quick-steps.json';

export function quickStepsPath(domainDir) {
  return path.join(domainDir, QUICK_STEPS_DIR, QUICK_STEPS_FILE);
}

// The quick steps of a domain, [] when it has none.
export function readQuickSteps(domainDir) {
  const file = quickStepsPath(domainDir);
  if (!existsSync(file)) return [];
  let steps;
  try {
    steps = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  if (!Array.isArray(steps)) throw new Error(`${file} must contain an array of quick steps`);
  return steps;
}

export function writeQuickSteps(domainDir, steps) {
  writeFileSync(quickStepsPath(domainDir), JSON.stringify(steps, null, 2) + '\n');
}

export function quickStepId(step) {
  const match = (step?.['spec-file'] ?? '').match(/\/quick-steps\/step-(\d+)-[^/]+\.md$/);
  return match ? Number(match[1]) : undefined;
}

function parseStep(step) {
  if (step == null || step === '') {
    throw new Error('Missing input: step. create-quick-step requires the quick step JSON');
  }
  if (typeof step !== 'string') return structuredClone(step);
  try {
    return JSON.parse(step);
  } catch (err) {
    throw new Error(`Invalid quick step JSON: ${err.message}`);
  }
}

export function createQuickStep(root, { domain, step } = {}) {
  const domainDir = resolveDomain(root, domain, 'create-quick-step');
  const parsed = parseStep(step);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Quick step must be a single JSON object');
  }
  assertSlug(parsed.slug, 'quick step slug');
  if (typeof parsed.intent !== 'string' || !parsed.intent.trim()) {
    throw new Error('Missing input: intent. A quick step needs the intent of the user');
  }
  const steps = readQuickSteps(domainDir);

  const [id] = reserveIds(root, 'step');
  const file = `step-${id}-${parsed.slug}.md`;
  const dir = path.join(domainDir, QUICK_STEPS_DIR);
  mkdirSync(dir, { recursive: true });
  const stepPath = path.join(dir, file);
  writeFileSync(stepPath, '');

  const saved = {
    slug: parsed.slug,
    intent: parsed.intent,
    'human-validation-needed': false,
    'review-needed': true,
    description: '',
    ...parsed,
    status: 'open',
    'spec-file': [SPECS_DIR, domain, QUICK_STEPS_DIR, file].join('/'),
  };
  steps.push(saved);
  writeQuickSteps(domainDir, steps);

  return { domain, id, file, path: stepPath, quickStepsPath: quickStepsPath(domainDir), specFile: saved['spec-file'] };
}
