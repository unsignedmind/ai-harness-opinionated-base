// Explore: tree of ideas -> phases -> steps (and quick steps) on the left, detail with boards on the right.
import { esc, inline, renderMd } from "../markdown";
import type { Idea, Model, Phase, Step } from "../model";
import { hrefOf, hrefOfQuick, QUICK_SEGMENT, type Route } from "../route";
import { kanban } from "./kanban";
import {
  crumbs,
  dots,
  hvnBadge,
  itemId,
  labelChips,
  pill,
  plural,
  progressText,
  quickBadge,
  rollup,
  treeNode,
} from "./parts";

// UI state that survives re-renders: expanded tree nodes (`idea` / `idea/phase`) and the chosen
// subtab per detail kind.
// `canPick`: standalone viewer, data comes from a folder the user picks (undefined on the dev server).
export type ExploreUi = {
  expanded: Set<string>;
  tabs: Record<string, string>;
  canPick?: boolean;
};

type Tab = string | { html: string };

function subtabs(
  ui: ExploreUi,
  key: string,
  tabs: Record<string, Tab | null>,
): string {
  const names = Object.keys(tabs).filter((n) => tabs[n]);
  if (!names.length) return "";
  const cur = names.includes(ui.tabs[key]) ? ui.tabs[key] : names[0];
  const v = tabs[cur]!;
  return `<div class="subtabs" data-key="${esc(key)}">${names
    .map(
      (n) =>
        `<button type="button" class="${n === cur ? "active" : ""}" data-tab="${esc(n)}">${esc(n)}</button>`,
    )
    .join("")}</div>
    <div class="subtab-body">${typeof v === "string" ? renderMd(v) : v.html}</div>`;
}

// drop the H1 (already the page title)
const stripH1 = (md: string) => md.replace(/^\s*#\s.*(\r?\n|$)/, "");

const phaseKey = (p: Phase) => `${p.idea.slug}/${p.slug}`;
const quickKey = (i: Idea) => `${i.slug}/${QUICK_SEGMENT}`;

type Selection = { idea?: Idea; phase?: Phase; quick?: boolean; step?: Step };

const stepNode = (s: Step, sel: Selection) =>
  treeNode(
    hrefOf(s),
    `lvl2${sel.step === s ? " sel" : ""}`,
    "",
    itemId(s),
    s.title,
    `<span class="dot ${s.status.key}" title="${esc(s.status.label)}"></span>`,
  );

function tree(model: Model, sel: Selection, ui: ExploreUi) {
  let out = "";
  for (const idea of model.ideas) {
    const open = sel.idea === idea || ui.expanded.has(idea.slug);
    const isSel = sel.idea === idea && !sel.phase && !sel.quick;
    out += treeNode(
      hrefOf(idea),
      isSel ? "sel" : "",
      idea.phases.length || idea.quickSteps.length ? (open ? "▾" : "▸") : "·",
      String(idea.number),
      idea.title,
      `<span class="dot ${idea.status.key}" title="${esc(idea.status.label)}"></span>`,
      idea.slug,
    );
    if (!open) continue;
    for (const p of idea.phases) {
      const popen = sel.phase === p || ui.expanded.has(phaseKey(p));
      out += treeNode(
        hrefOf(p),
        `lvl1${sel.phase === p && !sel.step ? " sel" : ""}`,
        p.steps.length ? (popen ? "▾" : "▸") : "·",
        itemId(p),
        p.name,
        dots(p.steps),
        phaseKey(p),
      );
      if (!popen) continue;
      for (const s of p.steps) out += stepNode(s, sel);
    }
    if (!idea.quickSteps.length) continue;
    const isQuick = sel.idea === idea && sel.quick;
    const qopen = isQuick || ui.expanded.has(quickKey(idea));
    out += treeNode(
      hrefOfQuick(idea),
      `lvl1${isQuick && !sel.step ? " sel" : ""}`,
      qopen ? "▾" : "▸",
      "⚡",
      "Quick steps",
      dots(idea.quickSteps),
      quickKey(idea),
    );
    if (qopen) for (const s of idea.quickSteps) out += stepNode(s, sel);
  }
  return `<nav class="tree" aria-label="Ideas">${out}</nav>`;
}

function empty(canPick: boolean | undefined) {
  if (canPick === undefined)
    return '<div class="empty"><p class="muted">No ideas under <code>specs/domain-*</code> yet.</p></div>';
  return `<div class="empty">
    <p>Read-only view of the <code>specs/</code> folder: ideas, phases and steps as boards.</p>
    ${
      canPick
        ? '<button type="button" class="primary" data-action="pick">Open the specs/ folder</button>'
        : '<p class="error">This browser cannot open folders. Use Chrome or Edge.</p>'
    }
    <p class="muted">Nothing is uploaded or written. The folder is remembered in this browser.</p>
  </div>`;
}

function overview(model: Model, canPick: boolean | undefined) {
  if (!model.ideas.length) return `<h1>Ideas</h1>${empty(canPick)}`;
  return `<h1>Ideas</h1>
    <p class="muted">${plural(model.ideas.length, "idea")} · ${plural(model.phases.length, "phase")} · ${plural(model.steps.length, "step")}</p>
    <div class="cards">${model.ideas
      .map(
        (i) => `<div class="card" data-href="${esc(hrefOf(i))}">
        <h3><span class="id mono">${i.number}</span>${esc(i.title)} ${pill(i.status)}</h3>
        ${i.intent ? `<p>${esc(i.intent.length > 240 ? i.intent.slice(0, 240) + "…" : i.intent)}</p>` : ""}
        ${i.labels.length ? `<div class="row">${labelChips(i.labels)}</div>` : ""}
        ${i.steps.length ? `<div class="row"><span class="muted">${plural(i.phases.length, "phase")} · ${plural(i.steps.length, "step")}${i.quickSteps.length ? ` (${i.quickSteps.length} quick)` : ""}</span>${dots(i.steps)}</div><div class="row">${rollup(i.steps)}</div>` : ""}
      </div>`,
      )
      .join("")}</div>`;
}

function ideaDetail(i: Idea, ui: ExploreUi) {
  return (
    crumbs(["Ideas", "#explore"], [i.title]) +
    `<h1><span class="id mono">${i.number}</span>${esc(i.title)} ${pill(i.status)}</h1>
    ${i.error ? `<p class="error">${esc(i.error)}</p>` : ""}
    <dl class="meta">
      ${i.plan ? `<dt>Plan</dt><dd>${esc(i.plan.name)}</dd>` : ""}
      ${i.labels.length ? `<dt>Labels</dt><dd>${labelChips(i.labels)}</dd>` : ""}
      ${i.steps.length ? `<dt>Steps</dt><dd>${rollup(i.steps)}</dd>` : ""}
      <dt>Folder</dt><dd class="mono">specs/${esc(i.folder)}/</dd>
    </dl>
    ${i.intent ? `<p>${inline(i.intent)}</p>` : ""}
    ${subtabs(ui, "idea", {
      Phases: i.plan ? { html: kanban(i.phases, { level: "phases" }) } : null,
      Steps: i.steps.length ? { html: kanban(i.steps, { where: true }) } : null,
      "idea.md": i.md ? stripH1(i.md) : null,
      "plan.json": i.planJson
        ? { html: `<pre><code>${esc(i.planJson)}</code></pre>` }
        : null,
    })}`
  );
}

function phaseDetail(p: Phase, ui: ExploreUi) {
  return (
    crumbs(
      ["Ideas", "#explore"],
      [p.idea.title, hrefOf(p.idea)],
      [`${itemId(p)} ${p.name}`],
    ) +
    `<h1><span class="id mono">${itemId(p)}</span>${esc(p.name)} ${pill(p.status)}</h1>
    <div class="row">${rollup(p.steps)}${hvnBadge(p.hvn)}</div>
    ${p.intent ? `<p>${inline(p.intent)}</p>` : ""}
    ${subtabs(ui, "phase", {
      Board: { html: kanban(p.steps) },
      Steps: { html: stepCards(p.steps) },
      Description: p.description || null,
    })}`
  );
}

const stepCards = (steps: Step[]) =>
  `<div class="cards">${steps
    .map(
      (s) => `<div class="card" data-href="${esc(hrefOf(s))}">
          <h3><span class="id mono">${itemId(s)}</span>${esc(s.title)}</h3>
          <div class="row">${pill(s.status)}${progressText("AC", s.ac, "ac")}${hvnBadge(s.hvn)}</div>
          <p>${esc(s.intent)}</p></div>`,
    )
    .join("")}</div>`;

function quickDetail(i: Idea, ui: ExploreUi) {
  return (
    crumbs(["Ideas", "#explore"], [i.title, hrefOf(i)], ["Quick steps"]) +
    `<h1>Quick steps ${quickBadge(true)}</h1>
    <p class="muted">Single steps outside the plan, in <code>specs/${esc(i.folder)}/quick-steps/</code>.</p>
    <div class="row">${rollup(i.quickSteps)}</div>
    ${subtabs(ui, "quick", {
      Board: { html: kanban(i.quickSteps) },
      Steps: { html: stepCards(i.quickSteps) },
    })}`
  );
}

function stepDetail(s: Step) {
  return (
    crumbs(
      ["Ideas", "#explore"],
      [s.idea.title, hrefOf(s.idea)],
      s.phase
        ? [`${itemId(s.phase)} ${s.phase.name}`, hrefOf(s.phase)]
        : ["Quick steps", hrefOfQuick(s.idea)],
      [itemId(s)],
    ) +
    `<h1><span class="id mono">${itemId(s)}</span>${esc(s.title)} ${pill(s.status)} ${quickBadge(s.quick)}</h1>
    <dl class="meta">
      <dt>Progress</dt><dd>${progressText("AC", s.ac, "ac") || '<span class="muted">no AC</span>'} ${progressText("Tasks", s.tasks, "tasks")}</dd>
      <dt>Human check</dt><dd>${s.hvn ? hvnBadge(true) : "no"}</dd>
      <dt>Spec file</dt><dd class="mono">${esc(s.specPath || "—")}</dd>
    </dl>
    ${s.intent ? `<p>${inline(s.intent)}</p>` : ""}
    ${s.description ? `<h2>${s.quick ? "Notes" : "Plan notes"}</h2>${renderMd(s.description)}` : ""}
    <h2>Spec</h2>
    ${s.specMd ? renderMd(stripH1(s.specMd)) : '<p class="muted">No spec written yet.</p>'}`
  );
}

const notFound = (what: string) =>
  `<h1>Not found</h1><p class="muted">${esc(what)} does not exist (anymore).</p><p><a href="#explore">Back to ideas</a></p>`;

export function renderExplore(model: Model, r: Route, ui: ExploreUi): string {
  const idea = r.idea ? model.ideas.find((i) => i.slug === r.idea) : undefined;
  const quick = !!idea && r.phase === QUICK_SEGMENT;
  const phase =
    idea && r.phase && !quick
      ? idea.phases.find((p) => p.slug === r.phase)
      : undefined;
  const steps = quick ? idea.quickSteps : phase?.steps;
  const step = r.step ? steps?.find((s) => s.slug === r.step) : undefined;

  let detail: string;
  if (r.idea && !idea) detail = notFound(`Idea "${r.idea}"`);
  else if (r.phase && !phase && !quick) detail = notFound(`Phase "${r.phase}"`);
  else if (r.step && !step) detail = notFound(`Step "${r.step}"`);
  else if (step) detail = stepDetail(step);
  else if (quick) detail = quickDetail(idea, ui);
  else if (phase) detail = phaseDetail(phase, ui);
  else if (idea) detail = ideaDetail(idea, ui);
  else detail = overview(model, ui.canPick);

  if (!model.ideas.length)
    return `<div class="explore solo"><div class="detail">${detail}</div></div>`;
  return `<div class="explore">${tree(model, { idea, phase, quick, step }, ui)}<div class="detail">${detail}</div></div>`;
}
