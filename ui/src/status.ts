// Statuses from `.claude/skills/nos/templates/status.xml`. Plans use open/in-progress/on-hold/done,
// phases their lifecycle, steps the same plus in-specification/specified. Anything else is sorted
// into `other` and flagged.
export const STATUS_ORDER = [
  'open',
  'in-specification',
  'specified',
  'in-progress',
  'implemented',
  'in-review',
  'reviewed',
  'done',
  'on-hold',
  'other',
] as const;

export type StatusKey = (typeof STATUS_ORDER)[number];

// Columns a board shows even when empty; anything else appears only when populated.
export const PHASE_BOARD_STATUSES: readonly StatusKey[] = [
  'open',
  'in-progress',
  'implemented',
  'in-review',
  'reviewed',
  'done',
];

export const STEP_BOARD_STATUSES: readonly StatusKey[] = [
  'open',
  'in-specification',
  'specified',
  ...PHASE_BOARD_STATUSES.slice(1),
];

const LABELS: Record<StatusKey, string> = {
  open: 'open',
  'in-specification': 'in specification',
  specified: 'specified',
  'in-progress': 'in progress',
  implemented: 'implemented',
  'in-review': 'in review',
  reviewed: 'reviewed',
  done: 'done',
  'on-hold': 'on hold',
  other: 'other',
};

export type Status = { key: StatusKey; label: string; flagged: boolean };

const KNOWN = new Set<string>(STATUS_ORDER.filter((k) => k !== 'other'));

export function normStatus(raw: string | undefined | null): Status {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return { key: 'other', label: '—', flagged: true };
  if (KNOWN.has(s)) return { key: s as StatusKey, label: s, flagged: false };
  return { key: 'other', label: s, flagged: true };
}

export const statusLabel = (key: StatusKey): string => LABELS[key];
