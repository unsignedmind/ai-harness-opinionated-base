import { appendFileSync, copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureSpecs, templatePath, writeJsonFile } from './config.js';
import { FAILED, NosError } from './exit-codes.js';
import { git, gitAvailable, gitOut } from './git.js';
import { DEFAULT_PROJECT_CONFIG, hasProjectConfig, projectConfigPath, specsConfig } from './project-config.js';
import { isInside, PROJECT_CONFIG_FILE, slash } from './roots.js';

// .specs keeps history in git; the dot entries are local state
export const SPECS_GITIGNORE = Object.freeze(['.chat/', '.locks/', '.runs/']);
// LF working copies in .specs on every OS: a project's .gitattributes does not reach into the nested repo,
// and core.autocrlf=true would check the specs out as CRLF
export const SPECS_GITATTRIBUTES = '* text=auto eol=lf\n';
// <specs> (when inside the project) and the run worktrees
function projectIgnores(roots) {
  const specs = slash(path.relative(roots.main, roots.specs));
  const inside = specs && !specs.startsWith('../') && !path.isAbsolute(specs);
  return [...(inside ? [`${specs}/`] : []), '.claude/worktrees/'];
}

// An entry counts as present in any of the forms "x", "x/", "/x", "/x/", "x/*", "**/x", "**/x/".
const bare = (entry) =>
  entry
    .trim()
    .replace(/^\*\*\//, '')
    .replace(/^\//, '')
    .replace(/\/\*$/, '')
    .replace(/\/$/, '');

// The entry is ignored by a .gitignore of the repo (not by global excludes or .git/info/exclude, which other
// clones do not have). Asks git with a path inside the folder, so ".claude/*" also counts for .claude/worktrees/.
function ignoredByGit(repo, entry) {
  const probe = `${entry.replace(/\/$/, '')}/x`;
  const res = git(['check-ignore', '-v', '--', probe], { cwd: repo });
  if (res.code !== 0) return false;
  const source = /^(.+?):\d+:/.exec(res.stdout)?.[1] ?? '';
  return !path.isAbsolute(source) && path.basename(source) === '.gitignore';
}

// Appends the entries missing from a .gitignore (created when missing), in the file's line ending.
// With repo given, git decides what is already ignored. Returns the added entries.
function ensureIgnored(file, entries, repo) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = new Set(text.split(/\r?\n/).map(bare));
  const missing = entries.filter((entry) => !present.has(bare(entry)) && !(repo && ignoredByGit(repo, entry)));
  if (missing.length === 0) return [];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text && !text.endsWith('\n') ? eol : '';
  if (text) appendFileSync(file, separator + missing.join(eol) + eol);
  else writeFileSync(file, missing.join(eol) + eol);
  return missing;
}

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

// Without nos.config.json and without --root / NOS_SPECS_ROOT the work root is only the cwd: init must then
// run from the project root itself, never from a subfolder or from inside the nos folder.
function assertInitPlace(roots) {
  if (roots.configured || roots.via === 'root' || roots.via === 'env') return;
  const hint = 'Run nos init from the project root or pass --root <project>';
  if (roots.work === roots.home || isInside(roots.work, roots.home)) {
    throw new NosError(FAILED, `${slash(roots.work)} lies inside the nos folder ${slash(roots.home)}. ${hint}`);
  }
  if (roots.git) {
    const top = real(gitOut(['rev-parse', '--show-toplevel'], { cwd: roots.work }));
    if (top !== roots.work) {
      throw new NosError(FAILED, `${slash(roots.work)} is not the top of its git repo (${slash(top)}). ${hint}`);
    }
  }
}

// git commit in .specs; a missing identity gets the fix in the message
function commitSpecs(cwd, message) {
  const res = git(['commit', '-m', message], { cwd });
  if (res.code === 0) return;
  const out = (res.stderr || res.stdout).trim();
  const identity = /tell me who you are|user\.email|user\.name|empty ident|unable to auto-detect/i.test(out);
  throw new NosError(
    FAILED,
    `git commit in ${slash(cwd)} failed: ${out}` +
      (identity ? '. Set an identity: git config --global user.name "<name>" and user.email "<email>"' : ''),
  );
}

// Sets up the nos layout of a project; every part is created only when missing, so it can run again.
//   nos.config.json (from the template), <specs>/ as its own git repo (branch main) with .gitignore and
//   config.json (id-counters), the project .gitignore entries for <specs> and .claude/worktrees/, the first
//   <specs> commit "nos: init" (with .gitattributes "* text=auto eol=lf" when <specs> has no commit yet),
//   and origin = specs.remote when set.
// Commits nothing in the project. Refused inside a worktree: the layout belongs to main.
export function initProject(roots) {
  if (roots.inWorktree) {
    throw new NosError(FAILED, `nos init runs in the main checkout ${slash(roots.main)}, not in a worktree`, {
      main: roots.main,
      work: roots.work,
    });
  }
  assertInitPlace(roots);
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
  if (roots.git) {
    gitignoreAdded = ensureIgnored(path.join(roots.main, '.gitignore'), projectIgnores(roots), roots.main);
  }

  // .gitattributes only for a fresh .specs (no history yet); an existing file is never touched
  const specsAttributes = path.join(roots.specs, '.gitattributes');
  const writeAttributes = () => {
    const made = !existsSync(specsAttributes);
    if (made) writeFileSync(specsAttributes, SPECS_GITATTRIBUTES);
    note(made, specsAttributes);
  };

  let commit = null;
  let remote = null;
  if (gitAvailable()) {
    const specsGit = path.join(roots.specs, '.git');
    const madeRepo = !existsSync(specsGit);
    if (madeRepo) gitOut(['init', '-b', 'main'], { cwd: roots.specs });
    note(madeRepo, specsGit);

    if (git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: roots.specs }).code !== 0) {
      writeAttributes();
      gitOut(['add', '--', '.gitattributes', '.gitignore', 'config.json'], { cwd: roots.specs });
      commitSpecs(roots.specs, 'nos: init');
      commit = gitOut(['rev-parse', 'HEAD'], { cwd: roots.specs });
    }

    const url = specsConfig(roots).remote;
    if (url) {
      const origin = git(['remote', 'get-url', 'origin'], { cwd: roots.specs });
      if (origin.code !== 0) {
        gitOut(['remote', 'add', 'origin', url], { cwd: roots.specs });
        remote = { url, added: true };
      } else {
        const current = origin.stdout.trim();
        // a different origin is reported, never changed
        remote = current === url ? { url, added: false } : { url, existing: current, added: false, mismatch: true };
      }
    }
  } else if (!specsExisted) {
    writeAttributes();
  }

  return { created, existing, gitignoreAdded, commit, remote };
}
