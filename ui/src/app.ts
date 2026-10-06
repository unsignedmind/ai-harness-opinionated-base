// DOM wiring: render the routed view into #main, delegate clicks, keep nav and search in sync.
import { buildDocs, type Docs } from './docs';
import { DEFAULT_FILTERS, type Filters } from './filter';
import type { Model } from './model';
import { parseRoute, viewHref, type View } from './route';
import { renderBacklog } from './views/backlog';
import { renderBoard } from './views/board';
import { renderDocs } from './views/docs';
import { renderExplore, type ExploreUi } from './views/explore';
import { suggestions, type SearchKind } from './views/filterbar';
import { plural } from './views/parts';

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
  // the host can write the specs (dev server): Ideas offer "Manual promote"
  canPromote?: boolean;
  // chat with the project's Claude Code session (dev server): detail pages offer "Ask Claude"
  canChat?: boolean;
  // clicks on any [data-action] element, e.g. "pick", "reload", "regrant", "promote" (data-domain),
  // "ask" (data-ask)
  onAction?: (action: string, el: HTMLElement) => void;
};

export function mountApp(root: HTMLElement, initial: Model, opts: AppOptions = {}): App {
  let model = initial;
  let docs = buildDocs(null);
  let notice: string | null = null;
  const main = root.querySelector<HTMLElement>('#main')!;
  const ui: ExploreUi = {
    expanded: new Set(),
    tabs: {},
    canPick: opts.canPick,
    canPromote: opts.canPromote,
    canChat: opts.canChat,
  };
  let lastFilters: Filters = DEFAULT_FILTERS;
  // only board and backlog carry filters
  const filtered = (v: View) => v === 'board' || v === 'backlog';
  // id of the autosuggest box a value was picked from: focus it (re-rendered, empty) again
  let refocus: string | null = null;

  function render() {
    const r = parseRoute(location.hash);
    if (filtered(r.view)) lastFilters = r.filters;

    const q = document.activeElement?.id === 'q' ? (document.activeElement as HTMLInputElement) : null;
    const caret = q ? [q.selectionStart, q.selectionEnd] : null;

    main.innerHTML =
      (notice ? `<div class="notice">${notice}</div>` : '') +
      (r.view === 'board'
        ? renderBoard(model, r.filters)
        : r.view === 'backlog'
          ? renderBacklog(model, r.filters)
          : r.view === 'docs'
            ? renderDocs(docs, r, ui)
            : renderExplore(model, r, ui));

    for (const a of root.querySelectorAll<HTMLAnchorElement>('#nav a[data-view]')) {
      const v = a.dataset.view as View;
      a.classList.toggle('active', v === r.view);
      if (filtered(v)) a.setAttribute('href', viewHref(v, lastFilters));
    }
    const status = root.querySelector('#status');
    if (status) status.textContent = `${plural(model.ideas.length, 'idea')} · ${plural(model.steps.length, 'step')}`;

    if (caret) {
      const q2 = main.querySelector<HTMLInputElement>('#q');
      q2?.focus();
      q2?.setSelectionRange(caret[0], caret[1]);
    }
    if (refocus) {
      main.querySelector<HTMLInputElement>(`#${refocus}`)?.focus();
      refocus = null;
    }
  }

  // autosuggest boxes (.acq: #lq labels, #dq domains): transient, filled in place without a re-render
  const listOf = (box: HTMLElement) => main.querySelector<HTMLElement>(`#${box.getAttribute('aria-controls')}`);
  const options = (box: HTMLElement) => [...(listOf(box)?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];

  function showSuggestions(box: HTMLInputElement) {
    const r = parseRoute(location.hash);
    const list = listOf(box);
    if (!list || !filtered(r.view)) return;
    list.innerHTML = suggestions(model, r.filters, r.view, box.dataset.kind as SearchKind, box.value);
    list.hidden = !list.innerHTML;
    box.setAttribute('aria-expanded', String(!list.hidden));
    box.removeAttribute('aria-activedescendant');
  }

  function setActive(box: HTMLElement, i: number) {
    const opts = options(box);
    opts.forEach((o, j) => {
      o.classList.toggle('active', j === i);
      o.setAttribute('aria-selected', String(j === i));
    });
    if (opts[i]) box.setAttribute('aria-activedescendant', opts[i].id);
  }

  function pick(box: HTMLElement, opt: HTMLElement | undefined) {
    const a = opt?.querySelector('a');
    if (!a) return;
    refocus = box.id;
    location.hash = a.getAttribute('href')!;
  }

  function onKeydown(e: KeyboardEvent) {
    const box = e.target as HTMLInputElement;
    if (!box.classList.contains('acq')) return;
    const opts = options(box);
    const cur = opts.findIndex((o) => o.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(box, cur < 0 ? (step > 0 ? 0 : opts.length - 1) : (cur + step + opts.length) % opts.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(box, cur >= 0 ? opts[cur] : opts.length === 1 ? opts[0] : undefined);
    } else if (e.key === 'Escape') {
      box.value = '';
      closeSuggestions(box);
    }
  }

  function closeSuggestions(box: HTMLElement) {
    const list = listOf(box);
    if (list) list.hidden = true;
    box.setAttribute('aria-expanded', 'false');
    box.removeAttribute('aria-activedescendant');
  }

  // entering a box lists its options right away
  function onFocusin(e: FocusEvent) {
    const box = e.target as HTMLInputElement;
    if (box.classList.contains('acq')) showSuggestions(box);
  }

  // close the list when focus leaves the box and its suggestions
  function onFocusout(e: FocusEvent) {
    const box = e.target as HTMLElement;
    if (!box.classList.contains('acq')) return;
    if ((e.relatedTarget as HTMLElement | null)?.closest('[role="listbox"]') === listOf(box)) return;
    closeSuggestions(box);
  }

  function onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const action = t.closest<HTMLElement>('[data-action]');
    if (action) return opts.onAction?.(action.dataset.action!, action);
    const tab = t.closest<HTMLElement>('.subtabs button[data-tab]');
    if (tab) {
      ui.tabs[tab.closest<HTMLElement>('.subtabs')!.dataset.key!] = tab.dataset.tab!;
      return render();
    }
    const node = t.closest<HTMLElement>('[data-toggle]');
    if (node && t.closest('.tw') && /[▸▾]/.test(t.textContent ?? '')) {
      const key = node.dataset.toggle!;
      if (ui.expanded.has(key)) ui.expanded.delete(key);
      else ui.expanded.add(key);
      return render();
    }
    // a click into an already focused box (list closed by Escape) opens it again
    if (t.classList.contains('acq')) return showSuggestions(t as HTMLInputElement);
    const picked = t.closest<HTMLElement>('.lsearch [role="listbox"] a');
    if (picked) refocus = picked.closest('.lsearch')!.querySelector('.acq')!.id;
    if (t.closest('a')) return;
    const target = t.closest<HTMLElement>('[data-href]');
    if (target) location.hash = target.dataset.href!;
  }

  // search: replace the hash (no history entry per keystroke) and render at once to keep focus
  function onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('acq')) return showSuggestions(t);
    if (t.id !== 'q') return;
    const r = parseRoute(location.hash);
    if (!filtered(r.view)) return;
    history.replaceState(null, '', viewHref(r.view, { ...r.filters, q: t.value }));
    render();
  }

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('focusin', onFocusin);
  root.addEventListener('focusout', onFocusout);
  window.addEventListener('hashchange', render);
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
      const source = root.querySelector('#source');
      if (source) source.textContent = label;
      const reload = root.querySelector<HTMLElement>('#reload');
      if (reload) reload.hidden = false;
    },
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('focusin', onFocusin);
      root.removeEventListener('focusout', onFocusout);
      window.removeEventListener('hashchange', render);
    },
  };
}
