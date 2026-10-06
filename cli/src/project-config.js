import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError } from './exit-codes.js';
import { PROJECT_CONFIG_FILE, SPECS_DIR, slash } from './roots.js';

// nos.config.json: project config, tracked in the project (templates/nos.config.json).
// specs.* and worktrees.* are read from main's file; quality-tools, project-commands and spec-ui from
// work's file, because a branch may change its test command.
export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  specs: Object.freeze({ dir: SPECS_DIR, remote: null }),
  worktrees: Object.freeze({ slots: 1, slotWait: 600 }),
  'quality-tools': Object.freeze({
    test: null,
    lint: null,
    'format-check': null,
    typecheck: null,
    e2e: null,
    additional: Object.freeze([]),
  }),
  'project-commands': Object.freeze({ install: null, dev: null, 'deploy-test': null }),
  'spec-ui': Object.freeze({ 'docs-folder': 'docs' }),
});

export const projectConfigPath = (dir) => path.join(dir, PROJECT_CONFIG_FILE);

export const hasProjectConfig = (dir) => existsSync(projectConfigPath(dir));

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

// nos.config.json of dir with the defaults merged in per section; only the defaults when the file is missing.
export function readProjectConfig(dir) {
  const file = projectConfigPath(dir);
  let config = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
    }
    if (!isObject(config)) throw new NosError(FAILED, `${slash(file)} must contain a JSON object`);
  }
  const merged = structuredClone(config);
  for (const [key, defaults] of Object.entries(DEFAULT_PROJECT_CONFIG)) {
    merged[key] = { ...structuredClone(defaults), ...(isObject(config[key]) ? config[key] : {}) };
  }
  return merged;
}

export const qualityTools = (roots) => readProjectConfig(roots.work)['quality-tools'];
export const projectCommands = (roots) => readProjectConfig(roots.work)['project-commands'];
export const docsFolder = (roots) => readProjectConfig(roots.work)['spec-ui']['docs-folder'];
export const worktreesConfig = (roots) => readProjectConfig(roots.main).worktrees;
export const specsConfig = (roots) => readProjectConfig(roots.main).specs;
