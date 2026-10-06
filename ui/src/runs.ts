// A run as `GET /__runs` reports it (src/serve-runs.ts): one per run file in <specs>/.runs/, a plan
// (id = domain id) or a quick step (id = step id) in its own branch and worktree. Never the token.
// The run file stays until `nos run cleanup`: phase merged or abandoned = the run is over and only
// waits for its cleanup. Browser-safe: types and small helpers only.
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
  // seconds since seen when the server answered, null when seen is missing or unreadable
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

// phases after which the run only waits for nos run cleanup
export const DONE_PHASES = ['merged', 'abandoned'];
export const isActive = (r: Pick<Run, 'phase'>) => !DONE_PHASES.includes(r.phase);

// not seen for this long: the holder may be gone
export const STALE_SEC = 2 * 3600;

// seconds since seen, now (the page's clock); falls back to the server's ageSec
export function ageOf(r: Pick<Run, 'seen' | 'ageSec'>, now = Date.now()): number | null {
  const t = Date.parse(r.seen ?? '');
  return Number.isNaN(t) ? r.ageSec : Math.max(0, Math.round((now - t) / 1000));
}

export const isStale = (r: Pick<Run, 'seen' | 'ageSec' | 'phase'>, now = Date.now()) =>
  isActive(r) && (ageOf(r, now) ?? 0) > STALE_SEC;

// 42 -> "42s", 300 -> "5m", 7200 -> "2h", 172800 -> "2d"
export function age(sec: number | null): string {
  if (sec == null) return '?';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : null);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

// the shape check for data from the network: anything else is dropped, numbers coerced
export function parseRuns(data: unknown): Run[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (r) =>
        !!r &&
        typeof r === 'object' &&
        (r.kind === 'plan' || r.kind === 'quick') &&
        Number.isInteger(r.id) &&
        typeof r.domain === 'string',
    )
    .map((r): Run => ({
      kind: r.kind,
      id: r.id,
      domain: r.domain,
      branch: text(r.branch),
      phase: text(r.phase),
      seen: typeof r.seen === 'string' ? r.seen : null,
      ageSec: int(r.ageSec),
      worktree: text(r.worktree),
      ahead: int(r.ahead),
      behind: int(r.behind),
      dirty: typeof r.dirty === 'boolean' ? r.dirty : null,
      ...(typeof r.error === 'string' && r.error && { error: r.error }),
    }));
}

// what changes the view: everything but ageSec (the page computes the age from seen itself)
export const runsKey = (runs: Run[]) => JSON.stringify(runs.map(({ ageSec: _age, ...r }) => r));
