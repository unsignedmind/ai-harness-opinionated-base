import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { slash } from './roots.js';

// <specs>/config.json: planning state only (id-counters, chat). Project config lives in nos.config.json.
export const CONFIG_FILE = 'config.json';
export const TEMPLATES_DIR = 'templates';
export const DEFAULT_CONFIG = Object.freeze({
  'id-counters': Object.freeze({ domain: 1, phase: 1, step: 1 }),
});

// A template of the running nos (roots.home), never of a copy inside the project.
export function templatePath(roots, file) {
  return path.join(roots.home, TEMPLATES_DIR, file);
}

export function specsDir(roots) {
  return roots.specs;
}

export function configPath(roots) {
  return path.join(specsDir(roots), CONFIG_FILE);
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${slash(file)}: ${err.message}`);
  }
}

export function writeJsonFile(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function initialConfig(roots) {
  const template = templatePath(roots, CONFIG_FILE);
  return existsSync(template) ? readJsonFile(template) : structuredClone(DEFAULT_CONFIG);
}

export function ensureSpecs(roots) {
  const dir = specsDir(roots);
  const file = configPath(roots);
  mkdirSync(dir, { recursive: true });

  const createdConfig = !existsSync(file);
  if (createdConfig) {
    writeJsonFile(file, initialConfig(roots));
  }
  return { specsDir: dir, configPath: file, createdConfig };
}

function readCounter(roots, counter) {
  const file = configPath(roots);
  if (!existsSync(file)) {
    throw new Error(`Missing ${slash(file)}. Run nos init first`);
  }
  const config = readJsonFile(file);
  const counters = config['id-counters'] ?? {};
  if (!Object.hasOwn(counters, counter)) {
    throw new Error(`Unknown id counter "${counter}"`);
  }
  const current = counters[counter];
  if (!Number.isInteger(current) || current < 1) {
    throw new Error(`Invalid value for id counter "${counter}": ${JSON.stringify(current)}`);
  }
  return { file, config, counters, current };
}

// The ids reserveIds would hand out next, without changing the counter.
export function peekIds(roots, counter, count = 1) {
  const { current } = readCounter(roots, counter);
  return Array.from({ length: count }, (_, i) => current + i);
}

export function reserveIds(roots, counter, count = 1) {
  const { file, config, counters, current } = readCounter(roots, counter);
  const ids = Array.from({ length: count }, (_, i) => current + i);
  counters[counter] = current + count;
  writeJsonFile(file, { ...config, 'id-counters': counters });
  return ids;
}
