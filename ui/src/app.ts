// DOM wiring: render the routed view into #main, delegate clicks, keep nav and search in sync.
import { buildDocs, type Docs } from "./docs";
import { DEFAULT_FILTERS, type Filters } from "./filter";
import type { Model } from "./model";
import { parseRoute, viewHref, type View } from "./route";
import { renderBacklog } from "./views/backlog";
import { renderBoard } from "./views/board";
import { renderDocs } from "./views/docs";
import { renderExplore, type ExploreUi } from "./views/explore";
import { plural } from "./views/parts";

export type App = {
  render: () => void;
  setModel: (m: Model) => void;
  setDocs: (d: Docs) => void;
  // html shown above the view (e.g. "reopen the folder"), null clears it
  setNotice: (html: string | null) => void;
  // name of the folder the data came from; reveals #reload
  setSource: (label: string) => void;
  destroy: () => void;
};

export type AppOptions = {
  // standalone viewer: true when the browser can pick folders, false when it cannot
  canPick?: boolean;
  // clicks on any [data-action] element, e.g. "pick", "reload", "regrant"
  onAction?: (action: string) => void;
};

export function mountApp(
  root: HTMLElement,
  initial: Model,
  opts: AppOptions = {},
): App {
  let model = initial;
  let docs = buildDocs(null);
  let notice: string | null = null;
  const main = root.querySelector<HTMLElement>("#main")!;
  const ui: ExploreUi = {
    expanded: new Set(),
    tabs: {},
    canPick: opts.canPick,
  };
  let lastFilters: Filters = DEFAULT_FILTERS;
  // only board and backlog carry filters
  const filtered = (v: View) => v === "board" || v === "backlog";

  function render() {
    const r = parseRoute(location.hash);
    if (filtered(r.view)) lastFilters = r.filters;

    const q =
      document.activeElement?.id === "q"
        ? (document.activeElement as HTMLInputElement)
        : null;
    const caret = q ? [q.selectionStart, q.selectionEnd] : null;

    main.innerHTML =
      (notice ? `<div class="notice">${notice}</div>` : "") +
      (r.view === "board"
        ? renderBoard(model, r.filters)
        : r.view === "backlog"
          ? renderBacklog(model, r.filters)
          : r.view === "docs"
            ? renderDocs(docs, r, ui)
            : renderExplore(model, r, ui));

    for (const a of root.querySelectorAll<HTMLAnchorElement>(
      "#nav a[data-view]",
    )) {
      const v = a.dataset.view as View;
      a.classList.toggle("active", v === r.view);
      if (filtered(v)) a.setAttribute("href", viewHref(v, lastFilters));
    }
    const status = root.querySelector("#status");
    if (status)
      status.textContent = `${plural(model.ideas.length, "idea")} · ${plural(model.steps.length, "step")}`;

    if (caret) {
      const q2 = main.querySelector<HTMLInputElement>("#q");
      q2?.focus();
      q2?.setSelectionRange(caret[0], caret[1]);
    }
  }

  function onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const action = t.closest<HTMLElement>("[data-action]");
    if (action) return opts.onAction?.(action.dataset.action!);
    const tab = t.closest<HTMLElement>(".subtabs button[data-tab]");
    if (tab) {
      ui.tabs[tab.closest<HTMLElement>(".subtabs")!.dataset.key!] =
        tab.dataset.tab!;
      return render();
    }
    const node = t.closest<HTMLElement>("[data-toggle]");
    if (node && t.closest(".tw") && /[▸▾]/.test(t.textContent ?? "")) {
      const key = node.dataset.toggle!;
      if (ui.expanded.has(key)) ui.expanded.delete(key);
      else ui.expanded.add(key);
      return render();
    }
    if (t.closest("a")) return;
    const target = t.closest<HTMLElement>("[data-href]");
    if (target) location.hash = target.dataset.href!;
  }

  // search: replace the hash (no history entry per keystroke) and render at once to keep focus
  function onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id !== "q") return;
    const r = parseRoute(location.hash);
    if (!filtered(r.view)) return;
    history.replaceState(
      null,
      "",
      viewHref(r.view, { ...r.filters, q: t.value }),
    );
    render();
  }

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  window.addEventListener("hashchange", render);
  render();

  return {
    render,
    setModel(m) {
      model = m;
      render();
    },
    setDocs(d) {
      docs = d;
      render();
    },
    setNotice(html) {
      notice = html;
      render();
    },
    setSource(label) {
      const source = root.querySelector("#source");
      if (source) source.textContent = label;
      const reload = root.querySelector<HTMLElement>("#reload");
      if (reload) reload.hidden = false;
    },
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      window.removeEventListener("hashchange", render);
    },
  };
}
