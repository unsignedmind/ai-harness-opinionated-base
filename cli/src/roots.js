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
//   offset      the project folder inside its git checkout, '' unless the project is a subfolder of the repo
//   configured  a nos.config.json exists in work or main (nos init ran)
//   via         how work was found: 'root' (--root), 'env' (NOS_SPECS_ROOT), 'walk', 'cwd' (nothing found)
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

// child lies strictly below parent
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
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

// The top of the main worktree. Normally the parent of the common dir (<top>/.git). A submodule's common
// dir lies under <super>/.git/modules/: then git's own list names the main worktree first.
function mainTopOf(commonDir, cwd) {
  if (path.basename(commonDir) === '.git') return canonical(path.dirname(commonDir));
  const list = git(['worktree', 'list', '--porcelain'], { cwd });
  const line = list.stdout.split(/\r?\n/).find((l) => l.startsWith('worktree '));
  return canonical(line ? line.slice('worktree '.length) : path.dirname(commonDir));
}

// { common, top, mainTop } of the checkout dir lies in, null outside git
function gitInfo(dir) {
  if (!existsSync(dir) || !gitAvailable()) return null;
  const res = git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], { cwd: dir });
  const [commonDir, top] = res.code === 0 ? res.stdout.trim().split(/\r?\n/) : [];
  if (!commonDir || !top) return null;
  const common = canonical(commonDir);
  return { common, top: canonical(top), mainTop: mainTopOf(common, dir) };
}

// work: --root (as given), else NOS_SPECS_ROOT, else the walk to nos.config.json, else cwd.
//   A walk that climbed out of a linked worktree (its branch has no nos.config.json yet) is brought back:
//   work = that worktree's top + the project offset.
// main: the top of the main worktree + the project offset (a project in a subfolder of a repo stays itself).
//   Not a git repo: main = work.
export function resolveRoots({ root, cwd = process.cwd(), env = process.env, home = NOS_HOME } = {}) {
  const given = root || env.NOS_SPECS_ROOT;
  const via = root ? 'root' : given ? 'env' : 'walk';
  let work;
  let info;
  let found = null;
  if (given) {
    work = canonical(path.resolve(cwd, given));
    info = gitInfo(work);
  } else {
    found = findWorkRoot(cwd);
    work = canonical(found ?? cwd);
    info = gitInfo(work);
    const here = found && info ? gitInfo(cwd) : null;
    if (here && here.common === info.common && here.top !== info.top && isInside(here.top, work)) {
      work = canonical(path.join(here.top, path.relative(info.top, work)));
      info = here;
    }
  }

  let main = work;
  let offset = '';
  let inWorktree = false;
  if (info) {
    const rel = path.relative(info.top, work);
    offset = slash(rel);
    main = canonical(path.join(info.mainTop, rel));
    inWorktree = info.mainTop !== info.top;
  }
  const configured =
    existsSync(path.join(work, PROJECT_CONFIG_FILE)) || existsSync(path.join(main, PROJECT_CONFIG_FILE));
  return {
    home: canonical(home),
    work,
    main,
    specs: path.resolve(main, specsDirOf(main)),
    inWorktree,
    git: Boolean(info),
    offset,
    configured,
    via: found || given ? via : 'cwd',
  };
}

// The project folder inside a worktree of the project: <worktreeTop>/<offset> (= worktreeTop unless the
// project is a subfolder of its repo). nos run start enters this folder.
export function worktreeProjectDir(roots, worktreeTop) {
  return path.join(worktreeTop, ...roots.offset.split('/').filter(Boolean));
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
  if (isInside(roots.home, path.join(roots.main, '.claude', 'worktrees'))) {
    warnings.push(`nos: warning: running a nos copy inside a worktree (${slash(roots.home)}). Call the nos of main`);
  }
  for (const warning of warnings) stderr.write(warning + '\n');
  return warnings;
}

// The spec-file of a plan step or quick step: relative to the specs root, forward slashes, '' when empty.
// Older forms (specs/ or .specs/ prefix, absolute paths) are refused; the migration rewrites them.
export function specFileOf(entry) {
  const specFile = String(entry?.['spec-file'] ?? '')
    .trim()
    .replaceAll('\\', '/');
  const legacy =
    specFile.startsWith(LEGACY_SPEC_PREFIX) ||
    specFile.startsWith(`${SPECS_DIR}/`) ||
    specFile.startsWith('/') ||
    /^[A-Za-z]:/.test(specFile) ||
    path.isAbsolute(specFile);
  if (legacy) {
    throw new NosError(
      FAILED,
      `legacy spec-file "${specFile}": a spec-file is relative to the specs root (no specs/ or .specs/ prefix, ` +
        'not absolute): run the migration',
      { specFile },
    );
  }
  return specFile;
}

// Absolute path of a spec-file
export const specPath = (roots, specFile) => path.join(roots.specs, ...specFile.split('/'));
