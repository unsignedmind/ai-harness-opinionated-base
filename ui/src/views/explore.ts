// Domains / Ideas: tree of domains -> phases -> steps (and quick steps) on the left, detail with
// boards on the right. Domains shows domains with a plan, Ideas the ones without; cross-cutting
// domains are grouped on both.
import { esc, inline, renderMd } from '../markdown';
import { isMatured, specsPathOf, type Idea, type Model, type Phase, type Step } from '../model';
import { age, ageOf } from '../runs';
import { hrefOf, hrefOfQuick, QUICK_SEGMENT, type Route } from '../route';
import { askButtons } from './chat';
import { kanban } from './kanban';
import {
  branchBadge,
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
  runBadge,
  runDot,
  treeNode,
} from './parts';

// UI state that survives re-renders: expanded tree nodes (`idea` / `idea/phase`) and the chosen
// subtab per detail kind.
// `canPick`: standalone viewer, data comes from a folder the user picks (undefined on the dev server).
// `canPromote`: the host can write the specs (dev server), so Ideas offer "Manual promote".
// `canChat`: the chat with the project's Claude Code session is there (dev server): "Ask Claude".
// `specsRel`: the specs root as the project sees it (model.specsRel, e.g. ../moodo-poc.specs), set per render.
export type ExploreUi = {
  expanded: Set<string>;
  tabs: Record<string, string>;
  canPick?: boolean;
  canPromote?: boolean;
  canChat?: boolean;
  specsRel?: string;
};

const ask = (ui: ExploreUi, kinds: Parameters<typeof askButtons>[0]) => (ui.canChat ? askButtons(kinds) : '');

type Tab = string | { html: string };

function subtabs(ui: ExploreUi, key: string, tabs: Record<string, Tab | null>): string {
  const names = Object.keys(tabs).filter((n) => tabs[n]);
  if (!names.length) return '';
  const cur = names.includes(ui.tabs[key]) ? ui.tabs[key] : names[0];
  const v = tabs[cur]!;
  return `<div class="subtabs" data-key="${esc(key)}">${names
    .map((n) => `<button type="button" class="${n === cur ? 'active' : ''}" data-tab="${esc(n)}">${esc(n)}</button>`)
    .join('')}</div>
    <div class="subtab-body">${typeof v === 'string' ? renderMd(v) : v.html}</div>`;
}

// drop the H1 (already the page title)
const stripH1 = (md: string) => md.replace(/^\s*#\s.*(\r?\n|$)/, '');

const phaseKey = (p: Phase) => `${p.idea.slug}/${p.slug}`;
const quickKey = (i: Idea) => `${i.slug}/${QUICK_SEGMENT}`;

type Selection = { idea?: Idea; phase?: Phase; quick?: boolean; step?: Step };

// the page being rendered: its domains and how it names them
type Scope = {
  label: string;
  href: string;
  noun: string;
  domains: Idea[];
};
type Crumb = [string, string];

function scopeOf(model: Model, r: Route): Scope {
  const ideas = r.view === 'ideas';
  return {
    label: ideas ? 'Ideas' : 'Domains',
    href: ideas ? '#ideas' : '#domains',
    noun: ideas ? 'idea' : 'domain',
    domains: model.ideas.filter((i) => isMatured(i) !== ideas),
  };
}

// [regular, cross-cutting]
const byGroup = (domains: Idea[]) => [domains.filter((i) => !i.crossCutting), domains.filter((i) => i.crossCutting)];

// a path relative to the specs root as the project sees it (<specsRel>/<rel>)
const specsPath = (ui: ExploreUi, rel: string) => specsPathOf(ui.specsRel, rel);

// a running dot in the tree: plan steps share the plan's run, shown once on the domain
const runTail = (run: Step['run']) => (run ? `<span class="tail-run">${runDot(run)}</span>` : '');

const stepNode = (s: Step, sel: Selection) =>
  treeNode(
    hrefOf(s),
    `lvl2${sel.step === s ? ' sel' : ''}`,
    '',
    itemId(s),
    s.title,
    (s.quick ? runTail(s.run) : '') + `<span class="dot ${s.status.key}" title="${esc(s.status.label)}"></span>`,
  );

const quickRun = (idea: Idea) => idea.quickSteps.find((s) => s.run)?.run ?? null;

function domainNodes(idea: Idea, sel: Selection, ui: ExploreUi) {
  const open = sel.idea === idea || ui.expanded.has(idea.slug);
  const isSel = sel.idea === idea && !sel.phase && !sel.quick;
  let out = treeNode(
    hrefOf(idea),
    isSel ? 'sel' : '',
    idea.phases.length || idea.quickSteps.length ? (open ? '▾' : '▸') : '·',
    String(idea.number),
    idea.title,
    runTail(idea.run ?? quickRun(idea)) +
      `<span class="dot ${idea.status.key}" title="${esc(idea.status.label)}"></span>`,
    idea.slug,
  );
  if (!open) return out;
  for (const p of idea.phases) {
    const popen = sel.phase === p || ui.expanded.has(phaseKey(p));
    out += treeNode(
      hrefOf(p),
      `lvl1${sel.phase === p && !sel.step ? ' sel' : ''}`,
      p.steps.length ? (popen ? '▾' : '▸') : '·',
      itemId(p),
      p.name,
      dots(p.steps),
      phaseKey(p),
    );
    if (!popen) continue;
    for (const s of p.steps) out += stepNode(s, sel);
  }
  if (!idea.quickSteps.length) return out;
  const isQuick = sel.idea === idea && sel.quick;
  const qopen = isQuick || ui.expanded.has(quickKey(idea));
  out += treeNode(
    hrefOfQuick(idea),
    `lvl1${isQuick && !sel.step ? ' sel' : ''}`,
    qopen ? '▾' : '▸',
    '⚡',
    'Quick steps',
    runTail(quickRun(idea)) + dots(idea.quickSteps),
    quickKey(idea),
  );
  if (qopen) for (const s of idea.quickSteps) out += stepNode(s, sel);
  return out;
}

function tree(scope: Scope, sel: Selection, ui: ExploreUi) {
  const [regular, cross] = byGroup(scope.domains);
  const nodes = (list: Idea[]) => list.map((i) => domainNodes(i, sel, ui)).join('');
  return `<nav class="tree" aria-label="${scope.label}">${nodes(regular)}${
    cross.length ? `<div class="tree-group">Cross-cutting</div>${nodes(cross)}` : ''
  }</nav>`;
}

function empty(canPick: boolean | undefined) {
  if (canPick === undefined)
    return '<div class="empty"><p class="muted">No domains under <code>&lt;specs&gt;/domain-*</code> yet.</p></div>';
  return `<div class="empty">
    <p>Read-only view of a project's specs folder: domains, phases and steps as boards.</p>
    ${
      canPick
        ? '<button type="button" class="primary" data-action="pick">Open the specs folder</button><p class="muted">By default <code>&lt;project&gt;.specs/</code>, next to the project folder. The docs show only in the live viewer (<code>npm run dev</code>), or with a project folder whose specs root lies inside it.</p>'
        : '<p class="error">This browser cannot open folders. Use Chrome or Edge.</p>'
    }
    <p class="muted">Nothing is uploaded or written. The folder is remembered in this browser.</p>
  </div>`;
}

const domainCard = (i: Idea) => `<div class="card" data-href="${esc(hrefOf(i))}">
        <h3><span class="id mono">${i.number}</span>${esc(i.title)} ${pill(i.status)} ${runBadge(i.run ?? quickRun(i))}</h3>
        ${i.intent ? `<p>${esc(i.intent.length > 240 ? i.intent.slice(0, 240) + '…' : i.intent)}</p>` : ''}
        ${i.labels.length ? `<div class="row">${labelChips(i.labels)}</div>` : ''}
        ${i.steps.length ? `<div class="row"><span class="muted">${plural(i.phases.length, 'phase')} · ${plural(i.steps.length, 'step')}${i.quickSteps.length ? ` (${i.quickSteps.length} quick)` : ''}</span>${dots(i.steps)}</div><div class="row">${rollup(i.steps)}</div>` : ''}
      </div>`;

function overview(model: Model, scope: Scope, canPick: boolean | undefined) {
  const h1 = `<h1>${scope.label}</h1>`;
  if (!model.ideas.length) return h1 + empty(canPick);
  const ds = scope.domains;
  if (!ds.length)
    return (
      h1 +
      (scope.noun === 'idea'
        ? '<p class="muted">No unrefined ideas: every domain has a plan.</p>'
        : '<p class="muted">No domain has a plan yet. See <a href="#ideas">Ideas</a>.</p>')
    );
  const phases = ds.reduce((n, i) => n + i.phases.length, 0);
  const steps = ds.reduce((n, i) => n + i.steps.length, 0);
  const counts = [
    plural(ds.length, scope.noun),
    ...(phases ? [plural(phases, 'phase')] : []),
    ...(steps ? [plural(steps, 'step')] : []),
  ].join(' · ');
  const [regular, cross] = byGroup(ds);
  const cards = (list: Idea[]) => `<div class="cards">${list.map(domainCard).join('')}</div>`;
  return `${h1}
    <p class="muted">${counts}</p>
    ${regular.length ? cards(regular) : ''}
    ${cross.length ? `<h2>Cross-cutting</h2>${cards(cross)}` : ''}`;
}

// unplanned idea: promote it to Domains with an empty (hollow) plan.json
function promote(i: Idea, ui: ExploreUi) {
  if (isMatured(i)) return '';
  const cmd = `nos create-plan --domain ${i.folder} --hollow`;
  return ui.canPromote
    ? `<div class="promote"><button type="button" class="primary" data-action="promote" data-domain="${esc(i.folder)}">Manual promote</button><span class="muted">Creates an empty plan.json so the idea moves to Domains</span></div>`
    : `<p class="promote muted">To promote it without a plan, run <code>${esc(cmd)}</code></p>`;
}

// meta rows of a running plan or quick step; no merge button: finishing a run needs a session (nos run finish)
function runRows(run: Step['run'], now = Date.now()) {
  if (!run) return '';
  const ab =
    run.ahead == null || run.behind == null
      ? '<span class="muted">unknown</span>'
      : `${run.ahead} ahead, ${run.behind} behind main`;
  return `<dt>Run</dt><dd>${runBadge(run)}</dd>
      <dt>Main</dt><dd>${ab}${run.dirty ? ' · <span class="hvn">uncommitted changes</span>' : ''}</dd>
      <dt>Seen</dt><dd>${esc(age(ageOf(run, now)))} ago</dd>
      ${run.worktree ? `<dt>Worktree</dt><dd class="mono">${esc(run.worktree)}</dd>` : ''}
      ${run.error ? `<dt>Git</dt><dd class="error">${esc(run.error)}</dd>` : ''}`;
}

function ideaDetail(i: Idea, ui: ExploreUi, root: Crumb) {
  return (
    crumbs(root, [i.title]) +
    `<h1><span class="id mono">${i.number}</span>${esc(i.title)} ${pill(i.status)}</h1>
    ${i.error ? `<p class="error">${esc(i.error)}</p>` : ''}
    ${promote(i, ui)}
    ${ask(ui, i.plan ? ['discuss'] : ['plan', 'discuss'])}
    <dl class="meta">
      ${i.plan ? `<dt>Plan</dt><dd>${esc(i.plan.name)}</dd>` : ''}
      ${i.labels.length ? `<dt>Labels</dt><dd>${labelChips(i.labels)}</dd>` : ''}
      ${i.crossCutting ? `<dt>Scope</dt><dd>cross-cutting</dd>` : ''}
      ${i.steps.length ? `<dt>Steps</dt><dd>${rollup(i.steps)}</dd>` : ''}
      ${i.branch ? `<dt>Branch</dt><dd>${branchBadge(i.branch)}</dd>` : ''}
      ${runRows(i.run)}
      <dt>Folder</dt><dd class="mono">${esc(specsPath(ui, i.folder))}/</dd>
    </dl>
    ${i.intent ? `<p>${inline(i.intent)}</p>` : ''}
    ${subtabs(ui, 'idea', {
      Phases: i.plan ? { html: kanban(i.phases, { level: 'phases' }) } : null,
      Steps: i.steps.length ? { html: kanban(i.steps, { where: true }) } : null,
      'idea.md': i.md ? stripH1(i.md) : null,
      'domain.json': i.domainJson ? { html: `<pre><code>${esc(i.domainJson)}</code></pre>` } : null,
      'plan.json': i.planJson ? { html: `<pre><code>${esc(i.planJson)}</code></pre>` } : null,
    })}`
  );
}

function phaseDetail(p: Phase, ui: ExploreUi, root: Crumb) {
  return (
    crumbs(root, [p.idea.title, hrefOf(p.idea)], [`${itemId(p)} ${p.name}`]) +
    `<h1><span class="id mono">${itemId(p)}</span>${esc(p.name)} ${pill(p.status)}</h1>
    <div class="row">${rollup(p.steps)}${hvnBadge(p.hvn)}</div>
    ${ask(ui, ['review', 'discuss'])}
    ${p.intent ? `<p>${inline(p.intent)}</p>` : ''}
    ${subtabs(ui, 'phase', {
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
          <div class="row">${pill(s.status)}${progressText('AC', s.ac, 'ac')}${hvnBadge(s.hvn)}</div>
          <p>${esc(s.intent)}</p></div>`,
    )
    .join('')}</div>`;

function quickDetail(i: Idea, ui: ExploreUi, root: Crumb) {
  return (
    crumbs(root, [i.title, hrefOf(i)], ['Quick steps']) +
    `<h1>Quick steps ${quickBadge(true)}</h1>
    <p class="muted">Single steps outside the plan, in <code>${esc(specsPath(ui, i.folder))}/quick-steps/</code>.</p>
    <div class="row">${rollup(i.quickSteps)}</div>
    ${ask(ui, ['discuss'])}
    ${subtabs(ui, 'quick', {
      Board: { html: kanban(i.quickSteps) },
      Steps: { html: stepCards(i.quickSteps) },
    })}`
  );
}

function stepDetail(s: Step, ui: ExploreUi, root: Crumb) {
  return (
    crumbs(
      root,
      [s.idea.title, hrefOf(s.idea)],
      s.phase ? [`${itemId(s.phase)} ${s.phase.name}`, hrefOf(s.phase)] : ['Quick steps', hrefOfQuick(s.idea)],
      [itemId(s)],
    ) +
    `<h1><span class="id mono">${itemId(s)}</span>${esc(s.title)} ${pill(s.status)} ${quickBadge(s.quick)}</h1>
    ${ask(ui, ['specify', 'develop', 'review', 'discuss'])}
    <dl class="meta">
      <dt>Progress</dt><dd>${progressText('AC', s.ac, 'ac') || '<span class="muted">no AC</span>'} ${progressText('Tasks', s.tasks, 'tasks')}</dd>
      <dt>Human check</dt><dd>${s.hvn ? hvnBadge(true) : 'no'}</dd>
      <dt>Spec file</dt><dd class="mono">${s.specPath ? esc(specsPath(ui, s.specPath)) : '—'}</dd>
      ${s.branch ? `<dt>Branch</dt><dd>${branchBadge(s.branch)}</dd>` : ''}
      ${runRows(s.run)}
    </dl>
    ${s.intent ? `<p>${inline(s.intent)}</p>` : ''}
    ${s.description ? `<h2>${s.quick ? 'Notes' : 'Plan notes'}</h2>${renderMd(s.description)}` : ''}
    <h2>Spec</h2>
    ${s.specMd ? renderMd(stripH1(s.specMd)) : '<p class="muted">No spec written yet.</p>'}`
  );
}

const notFound = (what: string, scope: Scope) =>
  `<h1>Not found</h1><p class="muted">${esc(what)} does not exist (anymore).</p><p><a href="${scope.href}">Back to ${scope.label.toLowerCase()}</a></p>`;

export function renderExplore(model: Model, r: Route, explore: ExploreUi): string {
  const ui: ExploreUi = { ...explore, specsRel: model.specsRel };
  const scope = scopeOf(model, r);
  const root: Crumb = [scope.label, scope.href];
  const idea = r.idea ? scope.domains.find((i) => i.slug === r.idea) : undefined;
  const quick = !!idea && r.phase === QUICK_SEGMENT;
  const phase = idea && r.phase && !quick ? idea.phases.find((p) => p.slug === r.phase) : undefined;
  const steps = quick ? idea.quickSteps : phase?.steps;
  const step = r.step ? steps?.find((s) => s.slug === r.step) : undefined;

  let detail: string;
  if (r.idea && !idea) detail = notFound(`${scope.noun === 'idea' ? 'Idea' : 'Domain'} "${r.idea}"`, scope);
  else if (r.phase && !phase && !quick) detail = notFound(`Phase "${r.phase}"`, scope);
  else if (r.step && !step) detail = notFound(`Step "${r.step}"`, scope);
  else if (step) detail = stepDetail(step, ui, root);
  else if (quick) detail = quickDetail(idea, ui, root);
  else if (phase) detail = phaseDetail(phase, ui, root);
  else if (idea) detail = ideaDetail(idea, ui, root);
  else detail = overview(model, scope, ui.canPick);

  if (!scope.domains.length) return `<div class="explore solo"><div class="detail">${detail}</div></div>`;
  return `<div class="explore">${tree(scope, { idea, phase, quick, step }, ui)}<div class="detail">${detail}</div></div>`;
}
