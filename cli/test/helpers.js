import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, gitAvailable } from '../src/git.js';
import { resolveRoots, SPECS_DIR } from '../src/roots.js';

// realpath: tmpdir() may be an 8.3 short path on Windows, the resolver returns long names
export function makeTempRoot(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nos-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Roots of a plain temp project for module tests, set up like nos init leaves it (nos.config.json and
// <specs>/config.json); { setUp: false } leaves the folder empty. home is a fake nos folder inside it (no
// templates unless a test writes them), so templates of the real nos never leak into a test.
export function makeRoots(t, { setUp = true } = {}) {
  const root = makeTempRoot(t);
  const roots = {
    home: path.join(root, 'nos-home'),
    work: root,
    main: root,
    specs: path.join(root, SPECS_DIR),
    inWorktree: false,
    git: false,
    offset: '',
    configured: setUp,
    via: 'root',
  };
  if (setUp) {
    writeFile(root, 'nos.config.json', { specs: { dir: SPECS_DIR, remote: null } });
    writeFile(roots.specs, 'config.json', { 'id-counters': { domain: 1, phase: 1, step: 1 } });
  }
  return roots;
}

export function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return full;
}

export function readJson(root, relPath) {
  return JSON.parse(readFileSync(path.join(root, relPath), 'utf8'));
}

// Identity for commits made by tests and by the CLI they run (git reads it from the env).
export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'nos test',
  GIT_AUTHOR_EMAIL: 'nos@test.invalid',
  GIT_COMMITTER_NAME: 'nos test',
  GIT_COMMITTER_EMAIL: 'nos@test.invalid',
};
Object.assign(process.env, GIT_ENV);

export const hasGit = gitAvailable();

// git that must succeed, for test setup
export function gitOk(args, cwd) {
  const res = git(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
  return res.stdout.trim();
}

// git init -b main with a local identity
export function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  gitOk(['init', '-b', 'main'], dir);
  gitOk(['config', 'user.name', GIT_ENV.GIT_AUTHOR_NAME], dir);
  gitOk(['config', 'user.email', GIT_ENV.GIT_AUTHOR_EMAIL], dir);
  gitOk(['config', 'core.autocrlf', 'false'], dir);
  return dir;
}

// Temp project with nos.config.json and <specs>/config.json. { git: true } makes it a git repo with
// nos.config.json and .gitignore committed on main. roots come from the real resolver (home = this nos).
export function makeProject(t, { git: withGit = false, config = {} } = {}) {
  const root = makeTempRoot(t);
  writeFile(root, 'nos.config.json', { specs: { dir: SPECS_DIR, remote: null }, ...config });
  writeFile(root, `${SPECS_DIR}/config.json`, { 'id-counters': { domain: 1, phase: 1, step: 1 } });
  if (withGit) {
    initRepo(root);
    writeFile(root, '.gitignore', `${SPECS_DIR}/\n.claude/worktrees/\n`);
    gitOk(['add', 'nos.config.json', '.gitignore'], root);
    gitOk(['commit', '-m', 'init'], root);
  }
  return { root, roots: resolveRoots({ root, env: {} }) };
}

export const STATUS_XML = `<valid-statuses>
    <plans>
        <status><name>open</name><description>not started</description></status>
        <status>
            <name>in-progress</name>
            <description>being worked on</description>
        </status>
        <status><name>done</name><description>finished</description></status>
    </plans>
    <phases>
        <status><name>open</name><description>not started</description></status>
        <status><name>implemented</name><description>implemented</description></status>
        <status><name>in-review</name><description>under review</description></status>
    </phases>
    <steps>
        <status><name>open</name><description>not started</description></status>
        <status><name>in-specification</name><description>being specified</description></status>
        <status><name>specified</name><description>specified</description></status>
        <status><name>implemented</name><description>implemented</description></status>
        <status><name>in-review</name><description>under review</description></status>
    </steps>
</valid-statuses>`;
