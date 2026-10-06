import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILED, NosError } from './exit-codes.js';
import { git, gitAvailable } from './git.js';

// The only resolver of nos paths (CLI, chat and spec-ui). Roots:
//   home        the nos folder this code runs from (NOS_HOME)
//   work        the checkout the caller sits in: main or a worktree, marked by nos.config.json
//   main        the main checkout of the project (git common dir), = work without git
//   specs       main + specs.dir of main's nos.config.json (default .specs), its own git repo
//   inWorktree  work is a linked git worktree of main
//   git         work is inside a git repo
export const SPECS_DIR = '.specs';
export const PROJECT_CONFIG_FILE = 'nos.config.json';
const LEGACY_SPEC_PREFIX = 'specs/';

// D:\x\y -> D:/x/y, the form every CLI result prints
export const slash = (p) => p.split(path.sep).join('/');

// Absolute and, when the path exists, real (long names and case as on disk, symlinks resolved).
function canonical(p) {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

export const NOS_HOME = canonical(fileURLToPath(new URL('../../', import.meta.url)));

// Walks up from start to the first folder with nos.config.json, null when there is none.
// Walking first makes nested repos (nos itself, .specs) harmless: git is asked from the project, not from them.
export function findWorkRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, PROJECT_CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// specs.dir of main's nos.config.json, else SPECS_DIR
function specsDirOf(main) {
  const file = path.join(main, PROJECT_CONFIG_FILE);
  if (!existsSync(file)) return SPECS_DIR;
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
  const dir = config?.specs?.dir;
  return typeof dir === 'string' && dir.trim() ? dir.trim() : SPECS_DIR;
}

// work: --root (as given), else NOS_SPECS_ROOT, else the walk to nos.config.json, else cwd.
// main: the top of git's common worktree (plus work's offset inside its own checkout, so a project in a
// subfolder of a repo stays itself). Not a git repo: main = work.
export function resolveRoots({ root, cwd = process.cwd(), env = process.env, home = NOS_HOME } = {}) {
  const given = root || env.NOS_SPECS_ROOT;
  const work = canonical(given ? path.resolve(cwd, given) : (findWorkRoot(cwd) ?? cwd));

  let main = work;
  let inWorktree = false;
  let isGit = false;
  if (existsSync(work) && gitAvailable()) {
    const res = git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], { cwd: work });
    const [commonDir, topLevel] = res.code === 0 ? res.stdout.trim().split(/\r?\n/) : [];
    if (commonDir && topLevel) {
      const mainTop = canonical(path.dirname(commonDir));
      const workTop = canonical(topLevel);
      main = canonical(path.join(mainTop, path.relative(workTop, work)));
      inWorktree = mainTop !== workTop;
      isGit = true;
    }
  }
  return {
    home: canonical(home),
    work,
    main,
    specs: path.resolve(main, specsDirOf(main)),
    inWorktree,
    git: isGit,
  };
}

// The CLI should run from the project's own nos (<main>/.claude/skills/nos), never from a copy in a worktree.
// Writes one warning line per finding to stderr and returns them.
export function homeGuard(roots, stderr = process.stderr) {
  const warnings = [];
  const projectHome = path.join(roots.main, '.claude', 'skills', 'nos');
  if (existsSync(projectHome) && canonical(projectHome) !== canonical(roots.home)) {
    warnings.push(
      `nos: warning: running ${slash(roots.home)}, but the project's nos is ${slash(projectHome)}. ` +
        `Call node ${slash(projectHome)}/cli/bin/nos.js`,
    );
  }
  if (slash(roots.home).includes('/.claude/worktrees/')) {
    warnings.push(`nos: warning: running a nos copy inside a worktree (${slash(roots.home)}). Call the nos of main`);
  }
  for (const warning of warnings) stderr.write(warning + '\n');
  return warnings;
}

// The spec-file of a plan step or quick step: relative to the specs root, forward slashes, '' when empty.
// The old form with the specs/ prefix is refused, the migration rewrites it.
export function specFileOf(entry) {
  const specFile = String(entry?.['spec-file'] ?? '')
    .trim()
    .replaceAll('\\', '/');
  if (specFile.startsWith(LEGACY_SPEC_PREFIX)) {
    throw new NosError(FAILED, `legacy spec-file "${specFile}" (with the old specs/ prefix): run the migration`, {
      specFile,
    });
  }
  return specFile;
}

// Absolute path of a spec-file
export const specPath = (roots, specFile) => path.join(roots.specs, ...specFile.split('/'));
