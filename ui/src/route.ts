// Hash routes: #explore[/idea[/phase[/step]]], #board?<filters>, #backlog?<filters>.
import { DEFAULT_FILTERS, parseQuery, toQuery, type Filters } from "./filter";
import type { Idea, Phase, Step } from "./model";

export type View = "explore" | "board" | "backlog";

export type Route = {
  view: View;
  idea?: string;
  phase?: string;
  step?: string;
  filters: Filters;
};

const VIEWS: readonly View[] = ["explore", "board", "backlog"];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const qi = raw.indexOf("?");
  const path = qi < 0 ? raw : raw.slice(0, qi);
  const query = qi < 0 ? "" : raw.slice(qi + 1);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const view = VIEWS.includes(parts[0] as View)
    ? (parts[0] as View)
    : "explore";
  if (view !== "explore") return { view, filters: parseQuery(query) };
  if (parts[0] !== "explore") return { view, filters: DEFAULT_FILTERS };
  const r: Route = { view, filters: DEFAULT_FILTERS };
  if (parts[1]) r.idea = parts[1];
  if (parts[2]) r.phase = parts[2];
  if (parts[3]) r.step = parts[3];
  return r;
}

const seg = encodeURIComponent;

export function hrefOf(x: Idea | Phase | Step): string {
  if (x.kind === "idea") return `#explore/${seg(x.slug)}`;
  if (x.kind === "phase") return `#explore/${seg(x.idea.slug)}/${seg(x.slug)}`;
  return `#explore/${seg(x.idea.slug)}/${seg(x.phase.slug)}/${seg(x.slug)}`;
}

export function viewHref(
  view: View,
  filters: Filters = DEFAULT_FILTERS,
): string {
  const q = toQuery(filters);
  return `#${view}${q ? "?" + q : ""}`;
}
