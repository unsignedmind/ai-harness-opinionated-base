// Types of runs.js for the spec-ui dev server (TypeScript), which lists the runs (/__runs), and its tests.
import type { Roots } from './roots.js';

export type RunKind = 'plan' | 'quick' | 'poc';
export type RunPhase = 'develop' | 'integrate' | 'gate' | 'merge' | 'merged' | 'abandoned';
/** a run file: <specs>/.runs/<kind>-<id>.json. poc: id = slug, domain null */
export type RunFile = {
  kind: RunKind;
  id: number | string;
  domain: string | null;
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
/** '<kind>-<id>' -> parts; anything else throws a NosError (USAGE) */
export function parseRunId(runId: string): { runId: string; kind: RunKind; id: number | string };
export function runIdOf(run: Pick<RunFile, 'kind' | 'id'>): string;
export function runPath(roots: Pick<Roots, 'specs'>, runId: string): string;
/** the notes of a run: <specs>/.runs/<run>.md (a POC's log) */
export function notesPath(roots: Pick<Roots, 'specs'>, runId: string): string;
/** the run file, null when there is none; an unreadable file throws a NosError (FAILED) */
export function readRun(roots: Pick<Roots, 'specs'>, runId: string): RunFile | null;
/** every readable run file, sorted by run id */
export function listRuns(roots: Pick<Roots, 'specs'>): RunFile[];
/** atomic write (tmp + rename); kind and phase are checked. Returns the path */
export function writeRun(roots: Pick<Roots, 'specs'>, run: Partial<RunFile> & Pick<RunFile, 'kind' | 'id'>): string;
export function deleteRun(roots: Pick<Roots, 'specs'>, runId: string): void;
/** 8 hex */
export function mintToken(): string;
/** token ?? env.NOS_RUN_TOKEN must be the run's: missing -> NosError FAILED, another -> NosError HELD. Returns it */
export function requireToken(run: RunFile, token?: string, env?: Record<string, string | undefined>): string;
/** seen = now, written. Returns the updated run */
export function touchSeen(roots: Pick<Roots, 'specs'>, run: RunFile): RunFile;
/** the run whose worktree roots.work is (or lies in); null in main */
export function runOfWorktree(roots: Pick<Roots, 'specs' | 'work' | 'inWorktree'>): RunFile | null;
