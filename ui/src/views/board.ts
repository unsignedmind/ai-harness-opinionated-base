// Board: every step (or phase) across all ideas as one kanban, filtered.
import { applyFilters, itemsAt, type Filters } from '../filter';
import type { Model } from '../model';
import { filterBar } from './filterbar';
import { kanban } from './kanban';

export function renderBoard(model: Model, f: Filters): string {
  const all = itemsAt(model, f.level);
  const shown = applyFilters(all, f);
  return `<div class="page">
    ${filterBar(model, f, 'board')}
    <p class="shown muted">${shown.length} of ${all.length} ${f.level}</p>
    ${kanban(shown, { where: true, labels: true, level: f.level })}
  </div>`;
}
