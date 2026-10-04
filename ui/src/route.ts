// Hash routes: #explore[/idea[/phase[/step]]] (quick steps: #explore/idea/quick-steps[/step]), #board?<filters>, #backlog?<filters>, #docs[/path/in/docs].
import { DEFAULT_FILTERS, parseQuery, toQuery, type Filters } from "./filter";
import type { Idea, Phase, Step } from "./model";

export type View = "explore" | "board" | "backlog" | "docs";

export type Route = {
  view: View;
  idea?: string;
  phase?: string;
  step?: string;
  // docs: path inside the docs folder
  doc?: string;
  filters: Filters;
};

const VIEWS: readonly View[] = ["explore", "board", "backlog", "docs"];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const qi = raw.indexOf("?");
  const path = qi < 0 ? raw : raw.slice(0, qi);
  const query = qi < 0 ? "" : raw.slice(qi + 1);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const view = VIEWS.includes(parts[0] as View)
    ? (parts[0] as View)
    : "explore";
  if (view === "docs") {
    const doc = parts.slice(1).join("/");
    return doc
      ? { view, doc, filters: DEFAULT_FILTERS }
      : { view, filters: DEFAULT_FILTERS };
  }
  if (view !== "explore") return { view, filters: parseQuery(query) };
  if (parts[0] !== "explore") return { view, filters: DEFAULT_FILTERS };
  const r: Route = { view, filters: DEFAULT_FILTERS };
  if (parts[1]) r.idea = parts[1];
  if (parts[2]) r.phase = parts[2];
  if (parts[3]) r.step = parts[3];
  return r;
}

const seg = encodeURIComponent;

// Route segment in place of the phase slug for the quick steps of an idea
export const QUICK_SEGMENT = "quick-steps";

export const hrefOfQuick = (idea: Idea) =>
  `#explore/${seg(idea.slug)}/${QUICK_SEGMENT}`;

export function hrefOf(x: Idea | Phase | Step): string {
  if (x.kind === "idea") return `#explore/${seg(x.slug)}`;
  if (x.kind === "phase") return `#explore/${seg(x.idea.slug)}/${seg(x.slug)}`;
  const group = x.phase ? seg(x.phase.slug) : QUICK_SEGMENT;
  return `#explore/${seg(x.idea.slug)}/${group}/${seg(x.slug)}`;
}

export const hrefOfDoc = (path: string) =>
  "#docs" + (path ? "/" + path.split("/").map(seg).join("/") : "");

export function viewHref(
  view: View,
  filters: Filters = DEFAULT_FILTERS,
): string {
  const q = toQuery(filters);
  return `#${view}${q ? "?" + q : ""}`;
}
