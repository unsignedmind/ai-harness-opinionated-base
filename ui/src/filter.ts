// Board and Backlog filters. Within one kind values combine with OR, across kinds with AND.
// The state lives in the hash query (`#board?labels=ui&status=open`) so a view is bookmarkable.
import type { Model, Phase, Step } from "./model";
import { STATUS_ORDER, type StatusKey } from "./status";

export type Level = "steps" | "phases";
export type SortKey = "id" | "title" | "where" | "status" | "ac";
export type Item = Step | Phase;

export type Filters = {
  labels: string[];
  statuses: StatusKey[];
  ideas: string[];
  q: string;
  level: Level;
  sort: SortKey;
  dir: 1 | -1;
};

export const DEFAULT_FILTERS: Filters = {
  labels: [],
  statuses: [],
  ideas: [],
  q: "",
  level: "steps",
  sort: "id",
  dir: 1,
};

const SORTS: readonly SortKey[] = ["id", "title", "where", "status", "ac"];

export const itemsAt = (model: Model, level: Level): Item[] =>
  level === "phases" ? model.phases : model.steps;

export const titleOf = (it: Item) => (it.kind === "step" ? it.title : it.name);

const haystack = (it: Item) =>
  [
    titleOf(it),
    it.slug,
    it.intent,
    it.description,
    it.status.label,
    it.idea.title,
    it.idea.slug,
    it.kind === "step" ? (it.phase?.name ?? "quick") : "",
  ]
    .join(" ")
    .toLowerCase();

export function applyFilters(items: Item[], f: Filters): Item[] {
  const q = f.q.trim().toLowerCase();
  return items.filter(
    (it) =>
      (!f.labels.length || it.labels.some((l) => f.labels.includes(l))) &&
      (!f.statuses.length || f.statuses.includes(it.status.key)) &&
      (!f.ideas.length || f.ideas.includes(it.idea.slug)) &&
      (!q || haystack(it).includes(q)),
  );
}

export type Counts = {
  labels: Record<string, number>;
  statuses: Partial<Record<StatusKey, number>>;
  ideas: Record<string, number>;
};

export function counts(items: Item[]): Counts {
  const c: Counts = { labels: {}, statuses: {}, ideas: {} };
  for (const it of items) {
    for (const l of it.labels) c.labels[l] = (c.labels[l] ?? 0) + 1;
    c.statuses[it.status.key] = (c.statuses[it.status.key] ?? 0) + 1;
    c.ideas[it.idea.slug] = (c.ideas[it.idea.slug] ?? 0) + 1;
  }
  return c;
}

export const toggle = <T>(xs: T[], x: T): T[] =>
  xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x];

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

export function parseQuery(qs: string): Filters {
  const p = new URLSearchParams(qs);
  const sort = p.get("sort") as SortKey;
  return {
    labels: list(p.get("labels")),
    statuses: list(p.get("status")).filter((s): s is StatusKey =>
      (STATUS_ORDER as readonly string[]).includes(s),
    ),
    ideas: list(p.get("idea")),
    q: p.get("q") ?? "",
    level: p.get("level") === "phases" ? "phases" : "steps",
    sort: SORTS.includes(sort) ? sort : "id",
    dir: p.get("dir") === "-1" ? -1 : 1,
  };
}

export function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.labels.length) p.set("labels", f.labels.join(","));
  if (f.statuses.length) p.set("status", f.statuses.join(","));
  if (f.ideas.length) p.set("idea", f.ideas.join(","));
  if (f.q) p.set("q", f.q);
  if (f.level !== "steps") p.set("level", f.level);
  if (f.sort !== "id") p.set("sort", f.sort);
  if (f.dir !== 1) p.set("dir", String(f.dir));
  return p.toString();
}

// quick steps sort after the plan steps of their idea
const idKey = (it: Item) => [
  it.idea.number,
  it.kind === "step"
    ? (it.phase?.number ?? Number.MAX_SAFE_INTEGER)
    : it.number,
  it.kind === "step" ? it.number : 0,
];

const cmp = (a: unknown, b: unknown): number => {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < a.length; i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return 0;
  }
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return (a as number) - (b as number);
};

const SORT_KEY: Record<SortKey, (it: Item) => unknown> = {
  id: idKey,
  title: (it) => titleOf(it).toLowerCase(),
  where: (it) => [it.idea.title.toLowerCase(), ...idKey(it)],
  status: (it) => [STATUS_ORDER.indexOf(it.status.key), ...idKey(it)],
  ac: (it) =>
    it.kind === "step"
      ? [it.ac.total ? it.ac.done / it.ac.total : -1, ...idKey(it)]
      : [-1],
};

export function sortItems(items: Item[], key: SortKey, dir: 1 | -1): Item[] {
  const k = SORT_KEY[key];
  return [...items].sort((a, b) => cmp(k(a), k(b)) * dir);
}
