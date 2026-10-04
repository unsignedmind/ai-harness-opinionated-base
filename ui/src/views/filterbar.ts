// Filter bar shared by Board and Backlog. Chips are plain links to the toggled hash, so filtering
// needs no event handlers; only the search box is wired in main.ts.
import { DEFAULT_FILTERS, counts, itemsAt, toggle, type Filters, type Level } from '../filter';
import { esc } from '../markdown';
import type { Model } from '../model';
import { viewHref, type View } from '../route';
import { STATUS_ORDER, statusLabel } from '../status';

type Kind = 'labels' | 'statuses' | 'ideas';

function chip(view: View, f: Filters, kind: Kind, value: string, text: string, n: number) {
  const on = (f[kind] as string[]).includes(value);
  const next = { ...f, [kind]: toggle(f[kind] as string[], value) };
  const cls = kind === 'statuses' ? ` st-${esc(value)}` : '';
  return `<a class="chip${cls}" data-kind="${kind}" data-value="${esc(value)}" aria-pressed="${on}" href="${esc(viewHref(view, next))}">${esc(text)} <span class="n">${n}</span></a>`;
}

export const hasActiveFilters = (f: Filters) => !!(f.labels.length || f.statuses.length || f.ideas.length || f.q);

export function filterBar(model: Model, f: Filters, view: View): string {
  const c = counts(itemsAt(model, f.level));
  const statuses = STATUS_ORDER.filter((k) => c.statuses[k] || f.statuses.includes(k));
  const ideas = model.ideas.filter((i) => c.ideas[i.slug] || f.ideas.includes(i.slug));
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
    ${group('Labels', model.labels.map((l) => chip(view, f, 'labels', l, l, c.labels[l] ?? 0)).join(''))}
    ${group('Status', statuses.map((k) => chip(view, f, 'statuses', k, statusLabel(k), c.statuses[k] ?? 0)).join(''))}
    ${group('Idea', ideas.map((i) => chip(view, f, 'ideas', i.slug, i.title, c.ideas[i.slug] ?? 0)).join(''))}
  </div>`;
}
