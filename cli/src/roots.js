import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILED, NosError } from './exit-codes.js';
import { git, gitAvailable } from './git.js';

// The only resolver of nos paths (CLI, chat and spec-ui). Roots:
//   home        the nos folder this code runs from (NOS_HOME)
//   work        the checkout the caller sits in: main or a worktree, marked by nos.config.json
//   main        the main checkout of the project (git common dir), = work without git
//   specs       main + specs.dir of main's nos.config.json (default ../<main folder name>.specs, a sibling of
//               the checkout: Claude Code's worktree isolation refuses writes into the main checkout), own git repo
//   inWorktree  work is a linked git worktree of main
//   git         work is inside a git repo
//   offset      the project folder inside its git checkout, '' unless the project is a subfolder of the repo
//   configured  a nos.config.json exists in work or main (nos init ran)
//   via         how work was found: 'root' (--root), 'env' (NOS_SPECS_ROOT), 'walk', 'cwd' (nothing found)
export const PROJECT_CONFIG_FILE = 'nos.config.json';
// <specs>/config.json; its "project" key points back to main, relative to the specs root
const SPECS_CONFIG_FILE = 'config.json';
export const SPECS_SUFFIX = '.specs';
const LEGACY_SPEC_PREFIXES = ['specs/', '.specs/'];

// The default specs.dir of a project: the sibling folder ../<main folder name>.specs. Built only here.
export const defaultSpecsDir = (main) => `../${path.basename(path.resolve(main))}${SPECS_SUFFIX}`;

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

// from the file path, not new URL('../../', import.meta.url): under jsdom (spec-ui tests) the global URL is
// jsdom's, which fileURLToPath refuses
export const NOS_HOME = canonical(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// The back-pointer of dir's config.json ("project", relative to dir, next to "id-counters"), validated both
// ways: the folder it names has nos.config.json and that project's specs root is dir itself (a copied, moved or
// foreign specs root is never followed). { main } when valid, { main: null, warning } when not, null for no
// back-pointer at all (no file, no "project" key, not JSON). Paths are compared real (symlinks, junctions).
export function projectOfSpecs(start) {
  const dir = canonical(start);
  const file = path.join(dir, SPECS_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const project = config?.project;
  if (typeof project !== 'string' || !project.trim() || !config['id-counters']) return null;
  const main = canonical(path.resolve(dir, project.trim()));
  const invalid = (why) => ({
    main: null,
    warning: `nos: warning: back-pointer of ${slash(dir)} points to ${slash(main)}, ${why}: run nos init there`,
  });
  if (!existsSync(path.join(main, PROJECT_CONFIG_FILE))) return invalid('which has no nos.config.json');
  let specs;
  try {
    specs = canonical(path.resolve(main, specsDirOf(main)));
  } catch {
    return invalid('whose nos.config.json cannot be read');
  }
  return samePath(specs, dir) ? { main } : invalid(`whose specs root is ${slash(specs)}`);
}

// The back-pointer a specs root stores in its config.json: main relative to the specs root, forward slashes
export const backPointerOf = (roots) => slash(path.relative(roots.specs, roots.main)) || '.';

// Walks up from start (real path: a symlink or junction is followed first) to the first folder with
// nos.config.json: { dir }, { dir: null } when there is none.
// Walking first makes nested repos (nos itself, an inner specs root) harmless: git is asked from the project,
// not from them. A specs root on the way (config.json with a "project" back-pointer) answers with its project,
// so the walk works from the specs root outside the checkout too. An invalid back-pointer ends the walk
// (not set up) with { dir: null, warning }.
export function walkToWorkRoot(start) {
  let dir = canonical(start);
  for (;;) {
    if (existsSync(path.join(dir, PROJECT_CONFIG_FILE))) return { dir };
    const back = projectOfSpecs(dir);
    if (back) return back.main ? { dir: back.main } : { dir: null, warning: back.warning };
    const parent = path.dirname(dir);
    if (parent === dir) return { dir: null };
    dir = parent;
  }
}

// The work root the walk finds, null when there is none
export const findWorkRoot = (start) => walkToWorkRoot(start).dir;

// specs.dir of main's nos.config.json (relative to main, or absolute), else the default sibling folder
function specsDirOf(main) {
  const file = path.join(main, PROJECT_CONFIG_FILE);
  if (!existsSync(file)) return defaultSpecsDir(main);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
  const dir = config?.specs?.dir;
  return typeof dir === 'string' && dir.trim() ? dir.trim() : defaultSpecsDir(main);
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
  const warnings = [];
  if (given) {
    work = canonical(path.resolve(cwd, given));
    // --root / NOS_SPECS_ROOT naming a specs root: its validated back-pointer gives the project
    if (!existsSync(path.join(work, PROJECT_CONFIG_FILE))) {
      const back = projectOfSpecs(work);
      if (back?.main) work = back.main;
      else if (back) warnings.push(back.warning);
    }
    info = gitInfo(work);
  } else {
    const walk = walkToWorkRoot(cwd);
    if (walk.warning) warnings.push(walk.warning);
    found = walk.dir;
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
    // why the resolver stopped short (an invalid back-pointer); the CLI prints them on stderr
    warnings,
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

// A specs root inside the main checkout cannot be written from a worktree session: Claude Code's worktree
// isolation refuses edits to the main checkout (subagents and junctions included). Warns on stderr.
export function specsGuard(roots, stderr = process.stderr) {
  if (!isInside(roots.specs, roots.main)) return [];
  const warning =
    `nos: warning: specs root inside the checkout (${slash(roots.specs)}): worktree sessions cannot write it ` +
    `(Claude Code isolation). Move it outside, e.g. specs.dir "${defaultSpecsDir(roots.main)}"`;
  stderr.write(warning + '\n');
  return [warning];
}

// The spec-file of a plan step or quick step: relative to the specs root, forward slashes, '' when empty.
// Older forms (specs/ or .specs/ prefix, absolute paths) are refused; the migration rewrites them.
export function specFileOf(entry) {
  const specFile = String(entry?.['spec-file'] ?? '')
    .trim()
    .replaceAll('\\', '/');
  const legacy =
    LEGACY_SPEC_PREFIXES.some((prefix) => specFile.startsWith(prefix)) ||
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
