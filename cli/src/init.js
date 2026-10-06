import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureSpecs, templatePath, writeJsonFile } from './config.js';
import { FAILED, NosError } from './exit-codes.js';
import { git, gitAvailable, gitOut } from './git.js';
import { DEFAULT_PROJECT_CONFIG, hasProjectConfig, projectConfigPath, specsConfig } from './project-config.js';
import { PROJECT_CONFIG_FILE, slash } from './roots.js';

// .specs keeps history in git; the dot entries are local state
export const SPECS_GITIGNORE = Object.freeze(['.chat/', '.locks/', '.runs/']);
// <specs> (when inside the project) and the run worktrees
function projectIgnores(roots) {
  const specs = slash(path.relative(roots.main, roots.specs));
  const inside = specs && !specs.startsWith('../') && !path.isAbsolute(specs);
  return [...(inside ? [`${specs}/`] : []), '.claude/worktrees/'];
}

// An entry counts as present in any of the forms "x", "x/", "/x", "/x/".
const bare = (entry) => entry.trim().replace(/^\//, '').replace(/\/$/, '');

// Appends the entries missing from a .gitignore (created when missing). Returns the added ones.
function ensureIgnored(file, entries) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = new Set(text.split(/\r?\n/).map(bare));
  const missing = entries.filter((entry) => !present.has(bare(entry)));
  if (missing.length === 0) return [];
  const separator = text && !text.endsWith('\n') ? '\n' : '';
  if (text) appendFileSync(file, separator + missing.join('\n') + '\n');
  else writeFileSync(file, missing.join('\n') + '\n');
  return missing;
}

// Sets up the nos layout of a project; every part is created only when missing, so it can run again.
//   nos.config.json (from the template), <specs>/ as its own git repo (branch main) with .gitignore and
//   config.json (id-counters), the project .gitignore entries for <specs> and .claude/worktrees/, the first
//   <specs> commit "nos: init", and origin = specs.remote when set.
// Commits nothing in the project. Refused inside a worktree: the layout belongs to main.
export function initProject(roots) {
  if (roots.inWorktree) {
    throw new NosError(FAILED, `nos init runs in the main checkout ${slash(roots.main)}, not in a worktree`, {
      main: roots.main,
      work: roots.work,
    });
  }
  const created = [];
  const existing = [];
  const note = (made, file) => (made ? created : existing).push(file);

  const projectConfig = projectConfigPath(roots.main);
  const madeConfig = !hasProjectConfig(roots.main);
  if (madeConfig) {
    const template = templatePath(roots, PROJECT_CONFIG_FILE);
    if (existsSync(template)) copyFileSync(template, projectConfig);
    else writeJsonFile(projectConfig, DEFAULT_PROJECT_CONFIG);
  }
  note(madeConfig, projectConfig);

  const specsExisted = existsSync(roots.specs);
  const { configPath, createdConfig } = ensureSpecs(roots);
  note(!specsExisted, roots.specs);
  note(createdConfig, configPath);

  const specsIgnore = path.join(roots.specs, '.gitignore');
  const madeSpecsIgnore = !existsSync(specsIgnore);
  ensureIgnored(specsIgnore, SPECS_GITIGNORE);
  note(madeSpecsIgnore, specsIgnore);

  let gitignoreAdded = [];
  if (roots.git) gitignoreAdded = ensureIgnored(path.join(roots.main, '.gitignore'), projectIgnores(roots));

  let commit = null;
  let remote = null;
  if (gitAvailable()) {
    const specsGit = path.join(roots.specs, '.git');
    const madeRepo = !existsSync(specsGit);
    if (madeRepo) gitOut(['init', '-b', 'main'], { cwd: roots.specs });
    note(madeRepo, specsGit);

    if (git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: roots.specs }).code !== 0) {
      gitOut(['add', '--', '.gitignore', 'config.json'], { cwd: roots.specs });
      gitOut(['commit', '-m', 'nos: init'], { cwd: roots.specs });
      commit = gitOut(['rev-parse', 'HEAD'], { cwd: roots.specs });
    }

    const url = specsConfig(roots).remote;
    if (url) {
      const hasOrigin = git(['remote', 'get-url', 'origin'], { cwd: roots.specs }).code === 0;
      if (!hasOrigin) gitOut(['remote', 'add', 'origin', url], { cwd: roots.specs });
      remote = { url, added: !hasOrigin };
    }
  }

  return { created, existing, gitignoreAdded, commit, remote };
}
