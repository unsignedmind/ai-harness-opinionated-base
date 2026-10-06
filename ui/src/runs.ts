// A run as `GET /__runs` reports it (src/serve-runs.ts): one per run file in <specs>/.runs/, a plan
// (id = domain id) or a quick step (id = step id) in its own branch and worktree. Never the token.
// Browser-safe: types and small helpers only.
export type RunKind = 'plan' | 'quick';

export type Run = {
  kind: RunKind;
  id: number;
  // the domain folder, e.g. domain-3-sync
  domain: string;
  branch: string;
  // develop | integrate | gate | merge | merged | abandoned
  phase: string;
  seen: string | null;
  // seconds since seen, null when seen is missing or unreadable
  ageSec: number | null;
  worktree: string;
  // commits on the branch that main lacks, and on main that the branch lacks; null when git could not tell
  ahead: number | null;
  behind: number | null;
  // uncommitted changes in the worktree; null when the worktree is missing
  dirty: boolean | null;
  // what went wrong asking git about this run
  error?: string;
};

export const runId = (r: Pick<Run, 'kind' | 'id'>) => `${r.kind}-${r.id}`;

// 42 -> "42s", 300 -> "5m", 7200 -> "2h", 172800 -> "2d"
export function age(sec: number | null): string {
  if (sec == null) return '?';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// the shape check for data from the network: anything else is dropped
export function parseRuns(data: unknown): Run[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (r): r is Run =>
      !!r &&
      typeof r === 'object' &&
      (r.kind === 'plan' || r.kind === 'quick') &&
      Number.isInteger(r.id) &&
      typeof r.domain === 'string',
  );
}
