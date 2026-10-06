// Dev server side of the runs (GET /__runs): one entry per run file in <specs>/.runs/ with what git
// says about it right now. ahead/behind compare the run's branch with main's branch in main
// (`git rev-list --left-right --count <mainBranch>...<branch>`), dirty asks the worktree
// (`git status --porcelain`). A run git cannot answer for gets nulls and an `error`, never a 500.
// The run token stays on disk: it is the holder, nobody else's business.
import { existsSync } from 'node:fs';

import { git } from '../../cli/src/git.js';
import type { Roots } from '../../cli/src/roots.js';
import { listRuns, type RunFile } from '../../cli/src/runs.js';
import type { Run } from './runs.ts';

const GIT_TIMEOUT = 10000;

const ageSec = (iso: unknown, now: number) => {
  const t = Date.parse(typeof iso === 'string' ? iso : '');
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 1000));
};

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

export function runView(roots: Pick<Roots, 'main'>, file: RunFile, now = Date.now()): Run {
  const errors: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const run: Run = {
    kind: file.kind,
    id: file.id,
    domain: str(file.domain),
    branch: str(file.branch),
    phase: str(file.phase),
    seen: typeof file.seen === 'string' ? file.seen : null,
    ageSec: ageSec(file.seen, now),
    worktree: str(file.worktree),
    ahead: null,
    behind: null,
    dirty: null,
  };

  if (!file.mainBranch || !file.branch) errors.push('run file names no branch or main branch');
  else {
    const res = git(['rev-list', '--left-right', '--count', `${file.mainBranch}...${file.branch}`], {
      cwd: roots.main,
      timeout: GIT_TIMEOUT,
    });
    const m = /^(\d+)\s+(\d+)$/.exec(res.stdout.trim());
    if (res.code === 0 && m) {
      run.behind = Number(m[1]);
      run.ahead = Number(m[2]);
    } else errors.push(`ahead/behind: ${firstLine(res.stderr) || 'git rev-list failed'}`);
  }

  if (!run.worktree || !existsSync(run.worktree)) errors.push(`worktree missing: ${run.worktree || '(none)'}`);
  else {
    const res = git(['status', '--porcelain'], { cwd: run.worktree, timeout: GIT_TIMEOUT });
    if (res.code === 0) run.dirty = res.stdout.trim() !== '';
    else errors.push(`dirty: ${firstLine(res.stderr) || 'git status failed'}`);
  }

  if (errors.length) run.error = errors.join('; ');
  return run;
}

// every run of the project; one broken run never hides the others
export function listRunViews(roots: Pick<Roots, 'main' | 'specs'>, now = Date.now()): Run[] {
  return listRuns(roots).map((file) => {
    try {
      return runView(roots, file, now);
    } catch (e) {
      return {
        kind: file.kind,
        id: file.id,
        domain: String(file.domain ?? ''),
        branch: String(file.branch ?? ''),
        phase: String(file.phase ?? ''),
        seen: null,
        ageSec: null,
        worktree: String(file.worktree ?? ''),
        ahead: null,
        behind: null,
        dirty: null,
        error: (e as Error).message,
      };
    }
  });
}

type Res = {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
};

export function runsHandler(roots: Pick<Roots, 'main' | 'specs'>) {
  return (_req: unknown, res: Res) => {
    let runs: Run[];
    try {
      runs = listRunViews(roots);
    } catch {
      // listRuns itself never throws; a missing .runs folder is no runs
      runs = [];
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(runs));
  };
}
