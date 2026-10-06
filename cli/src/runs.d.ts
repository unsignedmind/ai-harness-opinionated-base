// Types of runs.js for the spec-ui dev server (TypeScript), which lists the runs (/__runs).
import type { Roots } from './roots.js';

export type RunKind = 'plan' | 'quick';
export type RunPhase = 'develop' | 'integrate' | 'gate' | 'merge' | 'merged' | 'abandoned';
/** a run file: <specs>/.runs/<kind>-<id>.json */
export type RunFile = {
  kind: RunKind;
  id: number;
  domain: string;
  branch: string;
  worktree: string;
  base: string;
  mainBranch: string;
  token: string;
  started: string;
  seen: string;
  phase: RunPhase;
};

export const RUNS_DIR: string;
export const RUN_KINDS: readonly RunKind[];
export const RUN_PHASES: readonly RunPhase[];
export function runsDir(roots: Pick<Roots, 'specs'>): string;
export function parseRunId(runId: string): { runId: string; kind: RunKind; id: number };
export function runIdOf(run: Pick<RunFile, 'kind' | 'id'>): string;
export function runPath(roots: Pick<Roots, 'specs'>, runId: string): string;
export function readRun(roots: Pick<Roots, 'specs'>, runId: string): RunFile | null;
/** every readable run file, sorted by run id */
export function listRuns(roots: Pick<Roots, 'specs'>): RunFile[];
export function writeRun(roots: Pick<Roots, 'specs'>, run: Partial<RunFile> & Pick<RunFile, 'kind' | 'id'>): string;
export function deleteRun(roots: Pick<Roots, 'specs'>, runId: string): void;
export function mintToken(): string;
export function requireToken(run: RunFile, token?: string, env?: Record<string, string | undefined>): string;
export function touchSeen(roots: Pick<Roots, 'specs'>, run: RunFile): RunFile;
export function runOfWorktree(roots: Roots): RunFile | null;
