// Backlog: the same filters as Board, as a sortable table with status tiles.
import {
  applyFilters,
  itemsAt,
  sortItems,
  titleOf,
  type Filters,
  type SortKey,
} from "../filter";
import { esc } from "../markdown";
import type { Model } from "../model";
import { hrefOf, viewHref } from "../route";
import { STATUS_ORDER, statusLabel, type StatusKey } from "../status";
import { filterBar } from "./filterbar";
import {
  dots,
  hvnBadge,
  itemId,
  labelChips,
  pill,
  progressText,
  quickBadge,
} from "./parts";

export function renderBacklog(model: Model, f: Filters): string {
  const all = itemsAt(model, f.level);
  // tiles count everything the other filters let through, so they show where to narrow next
  const pool = applyFilters(all, { ...f, statuses: [] });
  const byStatus: Partial<Record<StatusKey, number>> = {};
  for (const it of pool)
    byStatus[it.status.key] = (byStatus[it.status.key] ?? 0) + 1;
  const single = f.statuses.length === 1 ? f.statuses[0] : null;
  const tiles =
    `<a class="stat all${f.statuses.length ? "" : " active"}" href="${esc(viewHref("backlog", { ...f, statuses: [] }))}"><b>${pool.length}</b> ${f.level}</a>` +
    STATUS_ORDER.filter((k) => byStatus[k])
      .map(
        (k) =>
          `<a class="stat${single === k ? " active" : ""}" data-status="${k}" href="${esc(viewHref("backlog", { ...f, statuses: single === k ? [] : [k] }))}"><b>${byStatus[k]}</b> <span class="pill ${k}">${esc(statusLabel(k))}</span></a>`,
      )
      .join("");

  const rows = sortItems(applyFilters(all, f), f.sort, f.dir);
  const th = (k: SortKey, label: string) => {
    const active = f.sort === k;
    const next = {
      ...f,
      sort: k,
      dir: active ? (-f.dir as 1 | -1) : 1,
    } as Filters;
    return `<th><a data-sort="${k}" href="${esc(viewHref("backlog", next))}">${label}${active ? (f.dir > 0 ? " ▲" : " ▼") : ""}</a></th>`;
  };
  const body =
    rows
      .map(
        (it) => `<tr data-href="${esc(hrefOf(it))}">
        <td class="id mono">${esc(itemId(it))}</td>
        <td>${esc(titleOf(it))}<div class="path">${esc(it.intent)}</div></td>
        <td><div>${esc(it.idea.title)}</div>${it.kind === "step" ? `<div class="path">${it.phase ? `P${it.phase.number} ${esc(it.phase.name)}` : quickBadge(true)}</div>` : ""}</td>
        <td>${pill(it.status)}</td>
        <td>${labelChips(it.labels)}</td>
        <td>${it.kind === "step" ? progressText("AC", it.ac, "ac") : dots(it.steps)}</td>
        <td>${hvnBadge(it.hvn)}</td>
      </tr>`,
      )
      .join("") ||
    '<tr><td colspan="7" class="muted">Nothing matches.</td></tr>';

  return `<div class="page">
    ${filterBar(model, f, "backlog")}
    <div class="summary">${tiles}</div>
    <div class="wrap"><table class="list">
      <thead><tr>${th("id", "ID")}${th("title", f.level === "steps" ? "Step" : "Phase")}${th("where", "Idea")}${th("status", "Status")}<th>Labels</th>${th("ac", "Progress")}<th></th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </div>`;
}
