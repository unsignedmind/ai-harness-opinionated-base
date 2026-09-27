import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SPECS_DIR = 'specs';
export const CONFIG_FILE = 'config.json';
export const TEMPLATE_CONFIG_PATH = '.claude/skills/nos/templates/config.json';
export const DEFAULT_CONFIG = Object.freeze({
  'id-counters': Object.freeze({ domain: 1, phase: 1, step: 1 }),
});

export function specsDir(root) {
  return path.join(root, SPECS_DIR);
}

export function configPath(root) {
  return path.join(specsDir(root), CONFIG_FILE);
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

function writeJsonFile(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function initialConfig(root) {
  const template = path.join(root, TEMPLATE_CONFIG_PATH);
  return existsSync(template) ? readJsonFile(template) : structuredClone(DEFAULT_CONFIG);
}

export function ensureSpecs(root) {
  const dir = specsDir(root);
  const file = configPath(root);
  mkdirSync(dir, { recursive: true });

  const createdConfig = !existsSync(file);
  if (createdConfig) {
    writeJsonFile(file, initialConfig(root));
  }
  return { specsDir: dir, configPath: file, createdConfig };
}

function readCounter(root, counter) {
  const file = configPath(root);
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. Run create-domain first to initialise specs/config.json`);
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
export function peekIds(root, counter, count = 1) {
  const { current } = readCounter(root, counter);
  return Array.from({ length: count }, (_, i) => current + i);
}

export function reserveIds(root, counter, count = 1) {
  const { file, config, counters, current } = readCounter(root, counter);
  const ids = Array.from({ length: count }, (_, i) => current + i);
  counters[counter] = current + count;
  writeJsonFile(file, { ...config, 'id-counters': counters });
  return ids;
}
