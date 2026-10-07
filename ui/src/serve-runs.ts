// Dev server side of the runs (GET /__runs): one entry per run file in <specs>/.runs/ with what git
// says about it right now. ahead/behind compare the run's branch with main's branch in main
// (`git rev-list --left-right --count <mainBranch>...<branch>`), dirty asks the worktree
// (`git status --porcelain`, only after `rev-parse --show-toplevel` confirmed it is that worktree).
// A run git cannot answer for gets nulls and an `error`, never a 500. The run token stays on disk:
// it is the holder, nobody else's business.
// Never blocks the dev server: git runs async, all runs at once, each call with a short timeout, and
// pages asking at the same time share one scan (plus a short cache).
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { gitEnv, NO_PROMPT_ENV } from '../../cli/src/git.js';
import type { Roots } from '../../cli/src/roots.js';
import { listRuns, type RunFile } from '../../cli/src/runs.js';
import type { Run } from './runs.ts';

export const GIT_TIMEOUT_MS = 3000;
export const RUNS_CACHE_MS = 2000;

type GitResult = { code: number; stdout: string; stderr: string };

// git without a shell, with the env of cli/src/git.js (no inherited GIT_DIR & co., never a prompt); never rejects
export function gitAsync(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((done) =>
    execFile(
      'git',
      args,
      { cwd, env: { ...gitEnv(), ...NO_PROMPT_ENV }, timeout, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        const why = err?.killed ? `git ${args[0]} timed out after ${timeout / 1000}s` : '';
        done({ code, stdout: stdout ?? '', stderr: why || stderr || (err && code === -1 ? err.message : '') });
      },
    ),
  );
}

// A branch name as git allows it (the rules of git check-ref-format --branch that matter here): no
// option look-alike, no revision syntax, no "..", no component starting with "." or ending in ".lock".
export function isBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.endsWith('.') || name.includes('..')) return false;
  return name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

const ageSec = (iso: unknown, now: number) => {
  const t = Date.parse(typeof iso === 'string' ? iso : '');
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 1000));
};

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b);

async function aheadBehind(main: string, file: RunFile): Promise<{ ahead: number; behind: number } | string> {
  if (!isBranchName(file.mainBranch) || !isBranchName(file.branch))
    return `ahead/behind: not a branch name: "${file.mainBranch}" / "${file.branch}"`;
  const res = await gitAsync(
    ['rev-list', '--left-right', '--count', '--end-of-options', `${file.mainBranch}...${file.branch}`, '--'],
    main,
  );
  const m = /^(\d+)\s+(\d+)$/.exec(res.stdout.trim());
  if (res.code !== 0 || !m) return `ahead/behind: ${firstLine(res.stderr) || 'git rev-list failed'}`;
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

async function dirtyOf(worktree: string): Promise<boolean | string> {
  if (!worktree || !existsSync(worktree)) return `worktree missing: ${worktree || '(none)'}`;
  const top = await gitAsync(['rev-parse', '--show-toplevel'], worktree);
  if (top.code !== 0) return `dirty: ${firstLine(top.stderr) || 'not a git checkout'}`;
  if (!samePath(top.stdout.trim(), worktree)) return `dirty: ${worktree} is not the top of a worktree`;
  const res = await gitAsync(['status', '--porcelain'], worktree);
  if (res.code !== 0) return `dirty: ${firstLine(res.stderr) || 'git status failed'}`;
  return res.stdout.trim() !== '';
}

export async function runView(roots: Pick<Roots, 'main'>, file: RunFile, now = Date.now()): Promise<Run> {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const run: Run = {
    kind: file.kind,
    id: file.id,
    // a POC has no domain: null stays null
    domain: file.kind === 'poc' ? null : str(file.domain),
    branch: str(file.branch),
    phase: str(file.phase),
    seen: typeof file.seen === 'string' ? file.seen : null,
    ageSec: ageSec(file.seen, now),
    worktree: str(file.worktree),
    ahead: null,
    behind: null,
    dirty: null,
  };
  const [ab, dirty] = await Promise.all([aheadBehind(roots.main, file), dirtyOf(run.worktree)]);
  const errors: string[] = [];
  if (typeof ab === 'string') errors.push(ab);
  else Object.assign(run, ab);
  if (typeof dirty === 'string') errors.push(dirty);
  else run.dirty = dirty;
  if (errors.length) run.error = errors.join('; ');
  return run;
}

// every run of the project; one broken run never hides the others
export function listRunViews(roots: Pick<Roots, 'main' | 'specs'>, now = Date.now()): Promise<Run[]> {
  return Promise.all(
    listRuns(roots).map((file) =>
      runView(roots, file, now).catch((e: Error): Run => ({
        kind: file.kind,
        id: file.id,
        domain: file.kind === 'poc' ? null : String(file.domain ?? ''),
        branch: String(file.branch ?? ''),
        phase: String(file.phase ?? ''),
        seen: null,
        ageSec: null,
        worktree: String(file.worktree ?? ''),
        ahead: null,
        behind: null,
        dirty: null,
        error: e.message,
      })),
    ),
  );
}

// One scan at a time, its result reused for cacheMs: pages polling together cost one scan.
export function runsScanner(roots: Pick<Roots, 'main' | 'specs'>, cacheMs = RUNS_CACHE_MS) {
  let inFlight: Promise<Run[]> | null = null;
  let cached: { at: number; runs: Run[] } | null = null;
  return (): Promise<Run[]> => {
    if (cached && Date.now() - cached.at < cacheMs) return Promise.resolve(cached.runs);
    inFlight ??= listRunViews(roots)
      .catch(() => [] as Run[])
      .then((runs) => {
        cached = { at: Date.now(), runs };
        return runs;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

type Res = {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
};

export function runsHandler(roots: Pick<Roots, 'main' | 'specs'>, scan = runsScanner(roots)) {
  return (_req: unknown, res: Res) =>
    void scan().then((runs) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(runs));
    });
}
