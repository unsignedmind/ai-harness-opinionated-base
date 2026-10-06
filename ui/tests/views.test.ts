import { test, expect, beforeEach } from 'vitest';

import { DEFAULT_FILTERS, type Filters } from '../src/filter';
import { buildModel } from '../src/model';
import { parseRoute } from '../src/route';
import { renderBacklog } from '../src/views/backlog';
import { renderBoard } from '../src/views/board';
import { renderExplore, type ExploreUi } from '../src/views/explore';
import { SUGGEST_MAX, filterBar, suggestions } from '../src/views/filterbar';
import { branchBadge, pill, runBadge } from '../src/views/parts';
import { parseRuns, runsKey, type Run } from '../src/runs';
import { normStatus } from '../src/status';
import { fixtureFiles, quickFixtureFiles } from './fixtures';

const model = () => buildModel(fixtureFiles());
const f = (over: Partial<Filters> = {}): Filters => ({
  ...DEFAULT_FILTERS,
  ...over,
});
const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};
const ui = (): ExploreUi => ({ expanded: new Set(), tabs: {} });
const explore = (hash: string, u = ui()) => mount(renderExplore(model(), parseRoute(hash), u));

beforeEach(() => {
  document.body.innerHTML = '';
});

// ── filter bar ──

test('selected labels are removable badges, the others are not listed', () => {
  const root = mount(filterBar(model(), f({ labels: ['ui'] }), 'board'));
  const ui = root.querySelector<HTMLAnchorElement>('a.chip.badge[data-kind="labels"][data-value="ui"]')!;
  expect(ui.getAttribute('aria-pressed')).toBe('true');
  expect(ui.getAttribute('aria-label')).toBe('Remove label ui');
  expect(ui.getAttribute('href')).toBe('#board');
  expect(ui.querySelector('.x')?.textContent).toBe('×');
  expect(ui.querySelector('.n')?.textContent).toBe('3');
  expect(root.querySelector('a.chip[data-kind="labels"][data-value="css"]')).toBeNull();
  expect(root.querySelector('input#lq[role="combobox"]')).not.toBeNull();
});

test('label suggestions list all labels for an empty query and link to the hash with the label added', () => {
  const all = mount(`<ul>${suggestions(model(), f(), 'board', 'labels', '')}</ul>`);
  expect([...all.querySelectorAll<HTMLElement>('li[role="option"] a')].map((a) => a.dataset.value)).toStrictEqual([
    'css',
    'ui',
  ]);
  expect(suggestions(model(), f({ labels: ['css', 'ui'] }), 'board', 'labels', '')).toBe('');
  const root = mount(`<ul>${suggestions(model(), f({ labels: ['ui'] }), 'board', 'labels', 'CSS')}</ul>`);
  const a = root.querySelector<HTMLAnchorElement>('li[role="option"] a')!;
  expect(a.dataset.value).toBe('css');
  expect(a.getAttribute('href')).toBe('#board?labels=ui%2Ccss');
  expect(suggestions(model(), f({ labels: ['css'] }), 'board', 'labels', 'css')).toContain('No labels match');
});

test('suggestions are capped, the rest is hinted', () => {
  const m = model();
  m.labels = Array.from({ length: SUGGEST_MAX + 5 }, (_, i) => `label-${String(i).padStart(2, '0')}`);
  const root = mount(`<ul>${suggestions(m, f(), 'board', 'labels', '')}</ul>`);
  expect(root.querySelectorAll('li[role="option"]')).toHaveLength(SUGGEST_MAX);
  expect(root.querySelector('li.empty')?.textContent).toBe('5 more, type to narrow');
});

test('domain filter: suggestions by domain name, selected domain is a badge with its name', () => {
  const root = mount(suggestions(model(), f(), 'backlog', 'ideas', 'dark'));
  const a = root.querySelector<HTMLAnchorElement>('li[role="option"] a')!;
  expect(a.dataset.value).toBe('dark-mode');
  expect(a.textContent).toContain('Dark mode theme');
  expect(a.getAttribute('href')).toBe('#backlog?domain=dark-mode');
  const bar = mount(filterBar(model(), f({ ideas: ['dark-mode'] }), 'backlog'));
  expect(bar.querySelector('input#dq[role="combobox"]')?.getAttribute('placeholder')).toBe('Add domain…');
  const badge = bar.querySelector<HTMLAnchorElement>('a.chip.badge[data-kind="ideas"]')!;
  expect(badge.getAttribute('aria-label')).toBe('Remove domain Dark mode theme');
  expect(badge.getAttribute('href')).toBe('#backlog');
  expect([...bar.querySelectorAll('.flabel')].map((l) => l.textContent)).toContain('Domain');
});

test('filter bar offers every status present as chips, labels and domains only via search', () => {
  const root = mount(filterBar(model(), f(), 'backlog'));
  const values = (kind: string) =>
    [...root.querySelectorAll<HTMLElement>(`a.chip[data-kind="${kind}"]`)].map((c) => c.dataset.value);
  expect(values('labels')).toStrictEqual([]);
  expect(values('statuses')).toStrictEqual(['in-review', 'done', 'other']);
  expect(values('ideas')).toStrictEqual([]);
});

test('level switch and clear link keep the view', () => {
  const root = mount(filterBar(model(), f({ q: 'x' }), 'board'));
  expect(root.querySelector('a[data-level="phases"]')?.getAttribute('href')).toBe('#board?q=x&level=phases');
  expect(root.querySelector('a.clear')?.getAttribute('href')).toBe('#board');
  expect(root.querySelector<HTMLInputElement>('input#q')?.value).toBe('x');
});

test('no clear link without active filters', () => {
  expect(mount(filterBar(model(), f(), 'board')).querySelector('a.clear')).toBeNull();
});

// ── board ──

test('board shows filtered steps as kanban with paths', () => {
  const root = mount(renderBoard(model(), f({ statuses: ['done'] })));
  expect(root.querySelectorAll('.kcard')).toHaveLength(1);
  expect(root.querySelector('.kcard .path')?.textContent).toContain('Dark mode theme');
  expect(root.querySelector('.shown')?.textContent).toBe('1 of 3 steps');
});

test('board at phase level shows phases', () => {
  const root = mount(renderBoard(model(), f({ level: 'phases' })));
  expect(root.querySelectorAll('.kcard')).toHaveLength(2);
  expect(root.querySelector('.shown')?.textContent).toBe('2 of 2 phases');
});

// ── backlog ──

test('board columns follow the level: specification only for steps', () => {
  const cols = (level: Filters['level']) =>
    [...mount(renderBoard(model(), f({ level, q: 'nothing-matches' }))).querySelectorAll<HTMLElement>('.col')].map(
      (c) => c.dataset.status,
    );
  expect(cols('steps')).toContain('specified');
  expect(cols('phases')).not.toContain('specified');
});

test('backlog lists one row per filtered step linking to explore', () => {
  const root = mount(renderBacklog(model(), f({ labels: ['ui'] })));
  const rows = root.querySelectorAll<HTMLElement>('tbody tr[data-href]');
  expect(rows).toHaveLength(3);
  expect(rows[0].dataset.href).toBe('#domains/dark-mode/tokens/extract-tokens');
  expect(rows[0].textContent).toContain('AC 2/3');
});

test('backlog header links sort, clicking the active one flips direction', () => {
  const root = mount(renderBacklog(model(), f({ sort: 'status' })));
  expect(root.querySelector('th a[data-sort="title"]')?.getAttribute('href')).toBe('#backlog?sort=title');
  const active = root.querySelector('th a[data-sort="status"]')!;
  expect(active.getAttribute('href')).toBe('#backlog?sort=status&dir=-1');
  expect(active.textContent).toContain('▲');
});

test('backlog status tiles filter to one status', () => {
  const root = mount(renderBacklog(model(), f()));
  expect(root.querySelector('a.stat[data-status="done"]')?.getAttribute('href')).toBe('#backlog?status=done');
  expect(root.querySelector('a.stat.all b')?.textContent).toBe('3');
});

test('backlog shows an empty row when nothing matches', () => {
  const root = mount(renderBacklog(model(), f({ q: 'zzz' })));
  expect(root.querySelector('tbody')?.textContent).toContain('Nothing matches');
});

// ── explore ──

test('an idea offers Manual promote when the host can write, else the CLI command', () => {
  const live = explore('#ideas/i18n', { ...ui(), canPromote: true });
  const btn = live.querySelector<HTMLButtonElement>('.detail button[data-action="promote"]')!;
  expect(btn.textContent).toBe('Manual promote');
  expect(btn.dataset.domain).toBe('domain-1-i18n');
  const standalone = explore('#ideas/i18n');
  expect(standalone.querySelector('[data-action="promote"]')).toBeNull();
  expect(standalone.querySelector('.promote code')?.textContent).toBe(
    'nos create-plan --domain domain-1-i18n --hollow',
  );
  const planned = explore('#domains/dark-mode', { ...ui(), canPromote: true });
  expect(planned.querySelector('.promote')).toBeNull();
});

test('explore overview shows a card per planned domain with status and rollup', () => {
  const root = explore('#domains');
  expect(root.querySelector('.detail h1')?.textContent).toBe('Domains');
  const cards = root.querySelectorAll<HTMLElement>('.detail .card[data-href]');
  expect([...cards].map((c) => c.dataset.href)).toStrictEqual(['#domains/dark-mode']);
  expect(cards[0].querySelector('.pill.in-progress')).not.toBeNull();
  expect(cards[0].textContent).toContain('2 phases · 3 steps');
});

test('ideas overview shows only domains without a plan', () => {
  const root = explore('#ideas');
  expect(root.querySelector('.detail h1')?.textContent).toBe('Ideas');
  const cards = root.querySelectorAll<HTMLElement>('.detail .card[data-href]');
  expect([...cards].map((c) => c.dataset.href)).toStrictEqual(['#ideas/i18n']);
  expect(cards[0].textContent).toContain('no plan');
  expect(root.querySelector('.tree')?.getAttribute('aria-label')).toBe('Ideas');
});

test('a planned domain is not found on the ideas page and vice versa', () => {
  expect(explore('#ideas/dark-mode').textContent).toContain('Not found');
  expect(explore('#domains/i18n').textContent).toContain('Not found');
});

test('cross-cutting domains are grouped in tree and overview', () => {
  const files = fixtureFiles();
  files['domain-3-logging/domain.json'] = JSON.stringify({
    name: 'Logging',
    'cross-cutting': true,
  });
  files['domain-3-logging/plan.json'] = JSON.stringify({ name: 'Log' });
  const root = mount(renderExplore(buildModel(files), parseRoute('#domains'), ui()));
  const tree = [...root.querySelectorAll('.tree > *')].map((n) =>
    n.classList.contains('tree-group') ? 'group' : (n as HTMLElement).dataset.href,
  );
  expect(tree).toStrictEqual(['#domains/dark-mode', 'group', '#domains/logging']);
  const h2 = root.querySelector('.detail h2')!;
  expect(h2.textContent).toBe('Cross-cutting');
  expect(h2.nextElementSibling?.querySelector('.card')?.getAttribute('data-href')).toBe('#domains/logging');
});

test('no cross-cutting group without cross-cutting domains', () => {
  const root = explore('#domains');
  expect(root.querySelector('.tree-group')).toBeNull();
  expect(root.querySelector('.detail h2')).toBeNull();
});

test('tree lists ideas; the selected idea and phase expand', () => {
  const root = explore('#domains/dark-mode/switch');
  const nodes = [...root.querySelectorAll<HTMLElement>('.tree .node')].map((n) => n.dataset.href);
  expect(nodes).toStrictEqual([
    '#domains/dark-mode',
    '#domains/dark-mode/tokens',
    '#domains/dark-mode/switch',
    '#domains/dark-mode/switch/media-query',
    '#domains/dark-mode/switch/toggle-button',
  ]);
  expect(root.querySelector('.tree .node.sel')?.getAttribute('data-href')).toBe('#domains/dark-mode/switch');
});

test('expanded set opens other nodes too', () => {
  const u = ui();
  u.expanded.add('dark-mode');
  u.expanded.add('dark-mode/tokens');
  const nodes = explore('#domains', u).querySelectorAll('.tree .node');
  expect(nodes).toHaveLength(4);
});

test('idea detail defaults to the phases board and offers the other tabs', () => {
  const root = explore('#domains/dark-mode');
  expect(root.querySelector('.detail h1')?.textContent).toContain('Dark mode');
  const tabs = [...root.querySelectorAll<HTMLElement>('.subtabs button')].map((b) => b.dataset.tab);
  expect(tabs).toStrictEqual(['Phases', 'Steps', 'idea.md', 'domain.json', 'plan.json']);
  expect(root.querySelectorAll('.subtab-body .kcard')).toHaveLength(2);
});

test('chosen subtab is remembered per key', () => {
  const u = ui();
  u.tabs.idea = 'Steps';
  expect(explore('#domains/dark-mode', u).querySelectorAll('.subtab-body .kcard')).toHaveLength(3);
  u.tabs.idea = 'idea.md';
  expect(explore('#domains/dark-mode', u).querySelector('.subtab-body .md')?.textContent).toContain('Decisions');
});

test('idea without plan shows its idea.md and no board', () => {
  const root = explore('#ideas/i18n');
  expect(root.querySelector('.subtab-body .md')?.textContent).toContain('Two languages');
  expect(root.querySelector('.board')).toBeNull();
});

test('phase detail shows intent, validation badge and a board of its steps', () => {
  const root = explore('#domains/dark-mode/switch');
  const d = root.querySelector('.detail')!;
  expect(d.querySelector('.crumbs')?.textContent).toBe('Domains › Dark mode › P2 Theme switch');
  expect(d.textContent).toContain('Toggle theme.');
  expect(d.querySelector('.hvn')).not.toBeNull();
  expect(d.querySelectorAll('.subtab-body .kcard')).toHaveLength(2);
});

test('step detail shows meta, progress and the rendered spec', () => {
  const d = explore('#domains/dark-mode/tokens/extract-tokens').querySelector('.detail')!;
  expect(d.querySelector('h1')?.textContent).toContain('Extract tokens');
  expect(d.textContent).toContain('AC 2/3');
  expect(d.textContent).toContain('Tasks 2/3');
  expect(d.textContent).toContain('domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md');
  expect(d.querySelectorAll('.md .check.done').length).toBeGreaterThan(0);
});

test('step without spec says so', () => {
  const d = explore('#domains/dark-mode/switch/toggle-button').querySelector('.detail')!;
  expect(d.textContent).toContain('No spec written yet');
});

test('unknown path shows a not-found note with a way back', () => {
  const d = explore('#domains/nope').querySelector('.detail')!;
  expect(d.textContent).toContain('Not found');
  expect(d.querySelector('a[href="#domains"]')).not.toBeNull();
});

test('invalid plan.json shows its error on the idea', () => {
  const files = fixtureFiles();
  files['domain-2-dark-mode/plan.json'] = '{';
  const root = mount(renderExplore(buildModel(files), parseRoute('#domains/dark-mode'), ui()));
  expect(root.querySelector('.error')?.textContent).toMatch(/plan\.json/);
});

// ── quick steps ──

const quickExplore = (hash: string, u = ui()) =>
  mount(renderExplore(buildModel(quickFixtureFiles()), parseRoute(hash), u));

test('tree shows a quick steps node under the idea', () => {
  const root = quickExplore('#domains/dark-mode/quick-steps/fix-contrast');
  const quick = root.querySelector<HTMLElement>('.node[data-toggle="dark-mode/quick-steps"]')!;
  expect(quick.textContent).toContain('Quick steps');
  expect(quick.dataset.href).toBe('#domains/dark-mode/quick-steps');
  expect(root.querySelector('.node.lvl2.sel')?.textContent).toContain('Fix contrast');
});

test("quick steps detail shows a board of the idea's quick steps", () => {
  const root = quickExplore('#domains/dark-mode/quick-steps');
  expect(root.querySelector('.detail h1')?.textContent).toContain('Quick steps');
  const cards = [...root.querySelectorAll('.detail .kcard')];
  expect(cards).toHaveLength(1);
  expect(cards[0].querySelector('.quick')).not.toBeNull();
});

test('quick step detail links back to the quick steps of its idea', () => {
  const root = quickExplore('#domains/dark-mode/quick-steps/fix-contrast');
  const crumbs = [...root.querySelectorAll<HTMLAnchorElement>('.crumbs a')];
  expect(crumbs.map((a) => a.getAttribute('href'))).toStrictEqual([
    '#domains',
    '#domains/dark-mode',
    '#domains/dark-mode/quick-steps',
  ]);
  expect(root.querySelector('.detail h1 .quick')).not.toBeNull();
  expect(root.querySelector('.detail')?.textContent).toContain('Muted text is readable');
});

test('idea without plan but with quick steps offers the steps board', () => {
  const root = quickExplore('#ideas/i18n');
  const tabs = [...root.querySelectorAll('.subtabs button')].map((b) => b.textContent);
  expect(tabs).toStrictEqual(['Steps', 'idea.md']);
});

test('board and backlog include quick steps', () => {
  const m = buildModel(quickFixtureFiles());
  expect(mount(renderBoard(m, f())).querySelectorAll('.kcard .quick')).toHaveLength(2);
  expect(mount(renderBacklog(m, f())).querySelectorAll('td .quick')).toHaveLength(2);
});

// ── runs and branches ──

const run = (over: Partial<Run> = {}): Run => ({
  kind: 'quick',
  id: 4,
  domain: 'domain-2-dark-mode',
  branch: 'quick-4',
  phase: 'develop',
  seen: new Date(Date.now() - 125_000).toISOString(),
  ageSec: 125,
  worktree: 'D:/p/.claude/worktrees/quick-4',
  ahead: 3,
  behind: 1,
  dirty: true,
  ...over,
});

test('runBadge: running dot, run id, phase, ahead/behind, dirty, escaped error', () => {
  const root = mount(runBadge(run({ error: '<img src=x>' })));
  const b = root.querySelector('.run')!;
  expect(b.querySelector('.dot.running')).not.toBeNull();
  expect(b.textContent).toContain('quick-4 develop');
  expect(b.querySelector('.ab')?.textContent).toBe('↑3 ↓1');
  expect(b.querySelector('.dirty')).not.toBeNull();
  expect(b.querySelector('.err')?.getAttribute('title')).toBe('<img src=x>');
  expect(root.querySelector('img')).toBeNull();
  expect(b.getAttribute('title')).toContain('last seen 2m ago');
  expect(runBadge(null)).toBe('');
  const unknown = mount(runBadge(run({ ahead: null, behind: null, dirty: null })));
  expect(unknown.querySelector('.ab, .dirty')).toBeNull();
});

test('branchBadge escapes, nothing without a branch', () => {
  expect(mount(branchBadge('plan-<2>')).querySelector('.branch')?.textContent).toBe('⎇ plan-<2>');
  expect(branchBadge(null)).toBe('');
});

const runModel = () => {
  const files = quickFixtureFiles();
  files['domain-2-dark-mode/plan.json'] = JSON.stringify({
    ...JSON.parse(files['domain-2-dark-mode/plan.json']),
    branch: 'plan-2',
  });
  const quick = JSON.parse(files['domain-2-dark-mode/quick-steps/quick-steps.json']);
  quick[0].branch = 'quick-4';
  files['domain-2-dark-mode/quick-steps/quick-steps.json'] = JSON.stringify(quick);
  return buildModel(files, [run(), run({ kind: 'plan', id: 2, branch: 'plan-2', phase: 'gate', dirty: false })]);
};

test('tree: a running dot on the domain, the quick steps node and the running quick step', () => {
  const root = mount(renderExplore(runModel(), parseRoute('#domains/dark-mode/quick-steps'), ui()));
  const node = (href: string) => root.querySelector(`.tree .node[data-href="${href}"]`)!;
  expect(node('#domains/dark-mode').querySelector('.tail-run .dot.running')).not.toBeNull();
  expect(node('#domains/dark-mode/quick-steps').querySelector('.tail-run .dot.running')).not.toBeNull();
  expect(node('#domains/dark-mode/quick-steps/fix-contrast').querySelector('.tail-run .dot.running')).not.toBeNull();
});

test('idea and step detail show branch, run, main distance, seen age; no merge button', () => {
  const idea = mount(renderExplore(runModel(), parseRoute('#domains/dark-mode'), ui()));
  const meta = idea.querySelector('dl.meta')!.textContent!;
  expect(meta).toContain('⎇ plan-2');
  expect(meta).toContain('plan-2 gate');
  expect(meta).toContain('3 ahead, 1 behind main');
  expect(meta).toContain('2m ago');
  expect(meta).toContain('.specs/domain-2-dark-mode/');
  expect(idea.querySelector('[data-action="merge"]')).toBeNull();
  expect(idea.querySelector('button')?.textContent ?? '').not.toMatch(/merge/i);

  const step = mount(renderExplore(runModel(), parseRoute('#domains/dark-mode/quick-steps/fix-contrast'), ui()));
  const sm = step.querySelector('dl.meta')!.textContent!;
  expect(sm).toContain('⎇ quick-4');
  expect(sm).toContain('quick-4 develop');
  expect(sm).toContain('uncommitted changes');
  expect(sm).toContain('.specs/domain-2-dark-mode/quick-steps/step-4-fix-contrast.md');
});

test('kanban cards carry a running dot for the quick run and the unfinished plan steps', () => {
  const root = mount(renderBoard(runModel(), f()));
  const card = (href: string) => root.querySelector(`.kcard[data-href="${href}"]`)!;
  expect(card('#domains/dark-mode/quick-steps/fix-contrast').querySelector('.dot.running')).not.toBeNull();
  // extract-tokens is done: no dot; media-query is still worked on in the plan run
  expect(card('#domains/dark-mode/tokens/extract-tokens').querySelector('.dot.running')).toBeNull();
  expect(card('#domains/dark-mode/switch/media-query').querySelector('.dot.running')).not.toBeNull();
});

test('merged and discarded render as plain pills without the ⚠ flag', () => {
  for (const key of ['merged', 'discarded'] as const) {
    const root = mount(pill(normStatus(key)));
    const p = root.querySelector('.pill')!;
    expect(p.className).toBe(`pill ${key}`);
    expect(p.textContent).toBe(key);
    expect(p.getAttribute('title')).toBeNull();
  }
  const files = quickFixtureFiles();
  const plan = JSON.parse(files['domain-2-dark-mode/plan.json']);
  plan.status = 'merged';
  plan.phases[0].steps[0].status = 'merged';
  plan.phases[1].steps[0].status = 'discarded';
  files['domain-2-dark-mode/plan.json'] = JSON.stringify(plan);
  const m = buildModel(files);
  const detail = mount(renderExplore(m, parseRoute('#domains/dark-mode'), ui()));
  expect(detail.querySelector('h1 .pill.merged')?.textContent).toBe('merged');
  expect(detail.textContent).not.toContain('⚠');
  const step = mount(renderExplore(m, parseRoute('#domains/dark-mode/tokens/extract-tokens'), ui()));
  expect(step.querySelector('h1 .pill')?.textContent).toBe('merged');
  // the board: merged has its column, discarded is hidden unless asked for
  const board = mount(renderBoard(m, f()));
  expect(board.querySelector('.col[data-status="merged"] .kcard')).not.toBeNull();
  expect(board.querySelector('.col[data-status="discarded"]')).toBeNull();
  const asked = mount(renderBoard(m, f({ statuses: ['discarded'] })));
  expect(asked.querySelector('.col[data-status="discarded"] .kcard')).not.toBeNull();
  expect(asked.querySelector('.col[data-status="discarded"] .pill.flagged')).toBeNull();
});

test('a stale run is greyed and does not pulse; a merged or abandoned run awaits cleanup', () => {
  const stale = mount(runBadge(run({ seen: new Date(Date.now() - 3 * 3600_000).toISOString() })));
  expect(stale.querySelector('.run.stale .dot.stale')).not.toBeNull();
  expect(stale.querySelector('.dot.running')).toBeNull();
  expect(stale.querySelector('.run')!.getAttribute('title')).toMatch(
    /^stale: quick-4, phase develop, last seen 3h ago/,
  );
  for (const phase of ['merged', 'abandoned']) {
    const done = mount(runBadge(run({ phase, seen: new Date(Date.now() - 5 * 3600_000).toISOString() })));
    expect(done.querySelector('.run.cleanup .dot.cleanup')).not.toBeNull();
    expect(done.querySelector('.dot.running, .dot.stale')).toBeNull();
    expect(done.textContent).toContain(`${phase}, awaiting cleanup`);
  }
});

test('the age comes from seen at render time, not from the server ageSec', () => {
  const root = mount(runBadge(run({ ageSec: 99999, seen: new Date(Date.now() - 30_000).toISOString() })));
  expect(root.querySelector('.run')!.getAttribute('title')).toContain('last seen 30s ago');
});

test('a non-default specs dir shows in folder and spec file rows', () => {
  const m = buildModel(quickFixtureFiles(), [], 'plans/specs');
  const idea = mount(renderExplore(m, parseRoute('#domains/dark-mode'), ui()));
  expect(idea.querySelector('dl.meta')!.textContent).toContain('plans/specs/domain-2-dark-mode/');
  const step = mount(renderExplore(m, parseRoute('#domains/dark-mode/quick-steps/fix-contrast'), ui()));
  expect(step.querySelector('dl.meta')!.textContent).toContain(
    'plans/specs/domain-2-dark-mode/quick-steps/step-4-fix-contrast.md',
  );
});

test('backlog: the all tile counts the default view, a discarded tile shows only when there are any', () => {
  const files = quickFixtureFiles();
  const before = mount(renderBacklog(buildModel(files), f()));
  expect(before.querySelector('.stat[data-status="discarded"]')).toBeNull();
  expect(before.querySelector('.stat.all')!.getAttribute('title')).toBeNull();
  const plan = JSON.parse(files['domain-2-dark-mode/plan.json']);
  plan.phases[0].steps[0].status = 'discarded';
  files['domain-2-dark-mode/plan.json'] = JSON.stringify(plan);
  const m = buildModel(files);
  const after = mount(renderBacklog(m, f()));
  expect(after.querySelector('.stat[data-status="discarded"] b')?.textContent).toBe('1');
  expect(after.querySelector('.stat.all b')?.textContent).toBe(String(m.steps.length - 1));
  expect(after.querySelector('.stat.all')!.getAttribute('title')).toBe('without discarded (1)');
  expect(after.querySelectorAll('tbody tr')).toHaveLength(m.steps.length - 1);
});

test('parseRuns drops what is no run and coerces numbers; runsKey ignores the age', () => {
  const runs = parseRuns([
    { kind: 'quick', id: 4, domain: 'd', ahead: 2.7, behind: '3', ageSec: -5, dirty: 'yes', seen: 7, error: '' },
    { kind: 'other', id: 1, domain: 'd' },
    { kind: 'plan', id: 1.5, domain: 'd' },
    null,
  ]);
  expect(runs).toStrictEqual([
    {
      kind: 'quick',
      id: 4,
      domain: 'd',
      branch: '',
      phase: '',
      seen: null,
      ageSec: 0,
      worktree: '',
      ahead: 2,
      behind: null,
      dirty: null,
    },
  ]);
  expect(runsKey([run({ ageSec: 1 })])).toBe(runsKey([run({ ageSec: 500 })]));
  expect(runsKey([run({ ahead: 1 })])).not.toBe(runsKey([run({ ahead: 2 })]));
});
