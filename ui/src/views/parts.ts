// Small HTML fragments shared by every view.
import type { Item } from '../filter';
import { esc } from '../markdown';
import type { Progress } from '../model';
import { age, runId, type Run } from '../runs';
import { STATUS_ORDER, statusLabel, type Status, type StatusKey } from '../status';

export const pill = (st: Status) =>
  `<span class="pill ${st.key}${st.flagged ? ' flagged' : ''}"${
    st.flagged ? ' title="not an nos status — see .claude/skills/nos/templates/status.xml"' : ''
  }>${esc(st.label)}${st.flagged ? ' ⚠' : ''}</span>`;

export const keyPill = (key: StatusKey, text = statusLabel(key)) => `<span class="pill ${key}">${esc(text)}</span>`;

export const itemId = (it: Item) => (it.kind === 'step' ? 'S' : 'P') + it.number;

export const labelChips = (labels: string[]) => labels.map((l) => `<span class="label">${esc(l)}</span>`).join('');

export const dots = (items: Item[]) =>
  `<span class="dots">${items
    .map((it) => `<span class="dot ${it.status.key}" title="${esc(itemId(it))} ${esc(it.status.label)}"></span>`)
    .join('')}</span>`;

export function rollup(items: Item[], empty = 'no steps') {
  const c: Partial<Record<StatusKey, number>> = {};
  for (const it of items) c[it.status.key] = (c[it.status.key] ?? 0) + 1;
  return (
    STATUS_ORDER.filter((k) => c[k])
      .map((k) => keyPill(k, `${c[k]} ${statusLabel(k)}`))
      .join(' ') || `<span class="muted">${esc(empty)}</span>`
  );
}

export const progressText = (label: string, p: Progress, cls: string) =>
  p.total
    ? `<span class="${cls}${p.done === p.total ? ' complete' : ''}">${esc(label)} ${p.done}/${p.total}</span>`
    : '';

export const hvnBadge = (on: boolean) =>
  on ? '<span class="hvn" title="human validation needed">👁 human check</span>' : '';

export const quickBadge = (on: boolean) =>
  on ? '<span class="quick" title="quick step: a single step outside the plan">⚡ quick</span>' : '';

// the branch a plan or quick step runs (or ran) in
export const branchBadge = (branch: string | null | undefined) =>
  branch ? `<span class="branch mono" title="branch ${esc(branch)}">⎇ ${esc(branch)}</span>` : '';

// a run in progress: pulsing dot, run id and phase, ahead/behind main, dirty worktree, git trouble
export function runBadge(run: Run | null | undefined): string {
  if (!run) return '';
  const ab =
    run.ahead == null || run.behind == null
      ? ''
      : `<span class="ab" title="${run.ahead} ahead of, ${run.behind} behind main">↑${run.ahead} ↓${run.behind}</span>`;
  const dirty = run.dirty ? '<span class="dirty" title="uncommitted changes in the worktree">● dirty</span>' : '';
  const err = run.error ? `<span class="err" title="${esc(run.error)}">⚠</span>` : '';
  const title = `run ${runId(run)}, phase ${run.phase || '?'}, last seen ${age(run.ageSec)} ago${run.worktree ? `, worktree ${run.worktree}` : ''}`;
  return `<span class="run" title="${esc(title)}">${runDot(run)}<span class="mono">${esc(runId(run))}</span> ${esc(run.phase || '?')}${ab}${dirty}${err}</span>`;
}

// the running indicator alone (tree, cards)
export const runDot = (run: Run | null | undefined) =>
  run ? `<span class="dot running" title="running: ${esc(runId(run))} ${esc(run.phase || '')}"></span>` : '';

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const crumbs = (...parts: [string, string?][]) =>
  `<div class="crumbs">${parts
    .map(([label, href]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label)))
    .join(' › ')}</div>`;

// One row of a .tree: `twisty` ▸/▾ expands the `toggle` key (see app.ts), `style` e.g. an indent
export const treeNode = (
  href: string,
  cls: string,
  twisty: string,
  id: string,
  label: string,
  tail: string,
  toggle = '',
  style = '',
) =>
  `<div class="node ${cls}" data-href="${esc(href)}"${toggle ? ` data-toggle="${esc(toggle)}"` : ''}${style ? ` style="${esc(style)}"` : ''}>
      <span class="tw">${twisty}</span><span class="id mono">${esc(id)}</span><span class="lbl">${esc(label)}</span>${tail}</div>`;
