// Filter bar shared by Board and Backlog. Chips are plain links to the toggled hash, so filtering
// needs no event handlers; only the search boxes (#q and the .acq autosuggest boxes) are wired in app.ts.
import {
  DEFAULT_FILTERS,
  counts,
  itemsAt,
  suggest,
  toggle,
  type Counts,
  type Filters,
  type Level,
  type Option,
} from '../filter';
import { esc } from '../markdown';
import type { Model } from '../model';
import { viewHref, type View } from '../route';
import { STATUS_ORDER, statusLabel, type StatusKey } from '../status';

function statusChip(view: View, f: Filters, value: StatusKey, n: number) {
  const on = f.statuses.includes(value);
  const next = { ...f, statuses: toggle(f.statuses, value) };
  return `<a class="chip st-${esc(value)}" data-kind="statuses" data-value="${esc(value)}" aria-pressed="${on}" href="${esc(viewHref(view, next))}">${esc(statusLabel(value))} <span class="n">${n}</span></a>`;
}

// Labels and Domain grow long, so they get a search box with suggestions (#lq/#lsug, #dq/#dsug)
// and show only the selected values, as removable badges
export type SearchKind = 'labels' | 'ideas';
const SEARCH: Record<SearchKind, { title: string; noun: string; id: string }> = {
  labels: { title: 'Labels', noun: 'label', id: 'l' },
  ideas: { title: 'Domain', noun: 'domain', id: 'd' },
};

const options = (model: Model, kind: SearchKind): Option[] =>
  kind === 'labels'
    ? model.labels.map((l) => ({ value: l, text: l }))
    : model.ideas.map((i) => ({ value: i.slug, text: i.name }));

// selected value: removable badge, the link toggles it off
function badge(view: View, f: Filters, kind: SearchKind, o: Option, n: number) {
  const next = { ...f, [kind]: toggle(f[kind], o.value) };
  return `<a class="chip badge" data-kind="${kind}" data-value="${esc(o.value)}" aria-pressed="true" aria-label="Remove ${SEARCH[kind].noun} ${esc(o.text)}" href="${esc(viewHref(view, next))}">${esc(o.text)} <span class="n">${n}</span><span class="x" aria-hidden="true">×</span></a>`;
}

function searchGroup(model: Model, f: Filters, view: View, kind: SearchKind, c: Counts): string {
  const opts = options(model, kind);
  if (!opts.length && !f[kind].length) return '';
  const { title, noun, id } = SEARCH[kind];
  const text = (v: string) => opts.find((o) => o.value === v)?.text ?? v;
  return `<div class="fgroup"><span class="flabel">${title}</span>
      <div class="lsearch">
        <input id="${id}q" class="acq" data-kind="${kind}" type="search" placeholder="Add ${noun}…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}sug" aria-label="Search ${noun}s">
        <ul id="${id}sug" role="listbox" aria-label="${title} suggestions" hidden></ul>
      </div>${f[kind].map((v) => badge(view, f, kind, { value: v, text: text(v) }, c[kind][v] ?? 0)).join('')}</div>`;
}

// at most this many options in the (scrollable) list; typing narrows the rest
export const SUGGEST_MAX = 30;

// options of the suggestion listbox of kind for query q (empty q: all); empty string when nothing is left
export function suggestions(model: Model, f: Filters, view: View, kind: SearchKind, q: string): string {
  const matches = suggest(options(model, kind), f[kind], q);
  if (!matches.length) return q.trim() ? `<li class="empty">No ${SEARCH[kind].noun}s match</li>` : '';
  const more = matches.length - SUGGEST_MAX;
  const c = counts(itemsAt(model, f.level));
  const id = SEARCH[kind].id;
  return (
    matches
      .slice(0, SUGGEST_MAX)
      .map((o, i) => {
        const next = { ...f, [kind]: toggle(f[kind], o.value) };
        return `<li role="option" id="${id}sug-${i}"><a tabindex="-1" data-value="${esc(o.value)}" href="${esc(viewHref(view, next))}">${esc(o.text)} <span class="n">${c[kind][o.value] ?? 0}</span></a></li>`;
      })
      .join('') + (more > 0 ? `<li class="empty">${more} more, type to narrow</li>` : '')
  );
}

export const hasActiveFilters = (f: Filters) => !!(f.labels.length || f.statuses.length || f.ideas.length || f.q);

export function filterBar(model: Model, f: Filters, view: View): string {
  const c = counts(itemsAt(model, f.level));
  const statuses = STATUS_ORDER.filter((k) => c.statuses[k] || f.statuses.includes(k));
  const level = (l: Level, text: string) =>
    `<a data-level="${l}" class="${f.level === l ? 'active' : ''}" href="${esc(viewHref(view, { ...f, level: l }))}">${text}</a>`;
  const clear = {
    ...DEFAULT_FILTERS,
    level: f.level,
    sort: f.sort,
    dir: f.dir,
  };
  const group = (title: string, chips: string) =>
    chips ? `<div class="fgroup"><span class="flabel">${title}</span>${chips}</div>` : '';
  return `<div class="filters">
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search…" value="${esc(f.q)}" aria-label="Search">
      <div class="seg">${level('steps', 'Steps')}${level('phases', 'Phases')}</div>
      ${hasActiveFilters(f) ? `<a class="clear" href="${esc(viewHref(view, clear))}">Clear filters</a>` : ''}
    </div>
    ${searchGroup(model, f, view, 'labels', c)}
    ${group('Status', statuses.map((k) => statusChip(view, f, k, c.statuses[k] ?? 0)).join(''))}
    ${searchGroup(model, f, view, 'ideas', c)}
  </div>`;
}
