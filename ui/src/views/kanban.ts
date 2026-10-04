// Kanban: one column per status, a card per phase or step, each linking to its Explore detail.
import { sortItems, titleOf, type Item } from "../filter";
import { esc } from "../markdown";
import { hrefOf } from "../route";
import {
  PHASE_BOARD_STATUSES,
  STATUS_ORDER,
  STEP_BOARD_STATUSES,
  type StatusKey,
} from "../status";
import {
  dots,
  hvnBadge,
  itemId,
  quickBadge,
  keyPill,
  labelChips,
  pill,
  progressText,
} from "./parts";

// `level` picks the always-shown columns; without it, phases get the phase lifecycle.
export type KanbanOptions = {
  where?: boolean;
  labels?: boolean;
  level?: "steps" | "phases";
};

const path = (it: Item) =>
  it.kind === "step"
    ? it.phase
      ? `${it.idea.title} › P${it.phase.number} ${it.phase.name}`
      : `${it.idea.title} › Quick`
    : it.idea.title;

function card(it: Item, o: KanbanOptions) {
  const meta = [
    it.kind === "step" ? quickBadge(it.quick) : "",
    it.status.flagged ? pill(it.status) : "",
    it.kind === "step" ? progressText("AC", it.ac, "ac") : dots(it.steps),
    hvnBadge(it.hvn),
    o.labels ? labelChips(it.labels) : "",
  ].join("");
  return `<div class="card kcard" data-href="${esc(hrefOf(it))}">
    <div class="kt"><span class="id mono">${esc(itemId(it))}</span>${esc(titleOf(it))}</div>
    ${o.where ? `<div class="path">${esc(path(it))}</div>` : ""}
    ${meta ? `<div class="row">${meta}</div>` : ""}
  </div>`;
}

export function kanban(items: Item[], o: KanbanOptions = {}): string {
  const cols = new Map<StatusKey, Item[]>(STATUS_ORDER.map((k) => [k, []]));
  for (const it of sortItems(items, "id", 1)) cols.get(it.status.key)!.push(it);
  const level = o.level ?? (items[0]?.kind === "phase" ? "phases" : "steps");
  const always =
    level === "phases" ? PHASE_BOARD_STATUSES : STEP_BOARD_STATUSES;
  const shown = STATUS_ORDER.filter(
    (k) => cols.get(k)!.length || always.includes(k),
  );
  return `<div class="board">${shown
    .map((k) => {
      const col = cols.get(k)!;
      return `<div class="col" data-status="${k}">
        <div class="col-head">${keyPill(k)}<span class="count muted">${col.length}</span></div>
        ${col.map((it) => card(it, o)).join("") || '<div class="col-empty muted">—</div>'}
      </div>`;
    })
    .join("")}</div>`;
}
