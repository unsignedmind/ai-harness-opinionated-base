import { test, expect } from 'vitest';

import { buildModel } from '../src/model';
import type { Run } from '../src/runs';
import { DOMAIN, PLAN, fixtureFiles, quickFixtureFiles } from './fixtures';

const model = () => buildModel(fixtureFiles());
const dark = () => model().ideas.find((i) => i.slug === 'dark-mode')!;

test('one idea per domain folder, sorted by number', () => {
  expect(model().ideas.map((i) => [i.folder, i.number, i.slug])).toStrictEqual([
    ['domain-1-i18n', 1, 'i18n'],
    ['domain-2-dark-mode', 2, 'dark-mode'],
  ]);
});

test("idea title drops the 'Idea:' prefix, intent is the first paragraph joined", () => {
  const i = dark();
  expect(i.title).toBe('Dark mode');
  expect(i.intent).toBe('App follows the system theme. Second line of intent.');
});

test("an idea without plan.json has no plan, a 'no plan' status and no phases", () => {
  const i = model().ideas[0];
  expect(i.plan).toBeNull();
  expect(i.status).toStrictEqual({
    key: 'other',
    label: 'no plan',
    flagged: false,
  });
  expect(i.phases).toStrictEqual([]);
  expect(i.labels).toStrictEqual([]);
});

test('plan status comes from plan.json, labels and cross-cutting from domain.json', () => {
  const i = dark();
  expect(i.plan?.name).toBe('Dark mode');
  expect(i.status.key).toBe('in-progress');
  expect(i.labels).toStrictEqual(['ui', 'css']);
  expect(i.crossCutting).toBe(false);
});

test('labels in plan.json are ignored', () => {
  const files = fixtureFiles();
  delete files['domain-2-dark-mode/domain.json'];
  files['domain-2-dark-mode/plan.json'] = JSON.stringify({
    ...PLAN,
    labels: ['old'],
  });
  expect(buildModel(files).ideas[1].labels).toStrictEqual([]);
});

test('domain name comes from domain.json, else the idea title', () => {
  const files = fixtureFiles();
  expect(buildModel(files).ideas[1]).toMatchObject({ title: 'Dark mode', name: 'Dark mode theme' });
  files['domain-2-dark-mode/domain.json'] = JSON.stringify({ ...DOMAIN, name: ' ' });
  expect(buildModel(files).ideas[1].name).toBe('Dark mode');
});

test('cross-cutting is read from domain.json', () => {
  const files = fixtureFiles();
  files['domain-2-dark-mode/domain.json'] = JSON.stringify({
    ...DOMAIN,
    'cross-cutting': true,
  });
  expect(buildModel(files).ideas[1].crossCutting).toBe(true);
});

test('broken domain.json keeps the idea and its plan visible with an error', () => {
  const files = fixtureFiles();
  files['domain-2-dark-mode/domain.json'] = '{ nope';
  const i = buildModel(files).ideas[1];
  expect(i.error).toMatch(/domain\.json/);
  expect(i.status.key).toBe('in-progress');
  expect(i.labels).toStrictEqual([]);
});

test('phases are numbered from their folder, keep intent, description and validation flag', () => {
  const [p1, p2] = dark().phases;
  expect([p1.number, p1.slug, p1.name, p1.status.key]).toStrictEqual([1, 'tokens', 'Colour tokens', 'done']);
  expect(p1.intent).toBe('Move colours into tokens.');
  expect(p2.hvn).toBe(true);
  expect(p2.number).toBe(2);
});

test('steps are numbered from their spec file, else by position in the plan', () => {
  expect(dark().steps.map((s) => [s.number, s.slug])).toStrictEqual([
    [1, 'extract-tokens'],
    [2, 'media-query'],
    [3, 'toggle-button'],
  ]);
});

test('steps link back to their phase and idea and inherit plan labels', () => {
  const s = dark().steps[1];
  expect(s.phase?.slug).toBe('switch');
  expect(s.quick).toBe(false);
  expect(s.idea.slug).toBe('dark-mode');
  expect(s.labels).toStrictEqual(['ui', 'css']);
});

test('step title is the spec H1 when present, else the humanised slug', () => {
  const [s1, s2, s3] = dark().steps;
  expect(s1.title).toBe('Extract tokens');
  expect(s2.title).toBe('Media query');
  expect(s3.title).toBe('Toggle button');
});

test('unknown step status is flagged', () => {
  expect(dark().steps[2].status).toStrictEqual({
    key: 'other',
    label: 'weird',
    flagged: true,
  });
});

test('acceptance criteria and tasks are counted only inside their sections', () => {
  const s = dark().steps[0];
  expect(s.ac).toStrictEqual({ done: 2, total: 3 });
  expect(s.tasks).toStrictEqual({ done: 2, total: 3 });
});

test('empty or missing spec file gives null md and zero progress', () => {
  const [, s2, s3] = dark().steps;
  expect(s2.specMd).toBeNull();
  expect(s2.specPath).toBe('domain-2-dark-mode/phases/phase-2-switch/step-2-media-query.md');
  expect(s3.specMd).toBeNull();
  expect(s3.specPath).toBe('');
  expect(s3.ac).toStrictEqual({ done: 0, total: 0 });
});

test('flat lists and label set cover all ideas', () => {
  const m = model();
  expect(m.phases).toHaveLength(2);
  expect(m.steps).toHaveLength(3);
  expect(m.labels).toStrictEqual(['css', 'ui']);
});

test('broken plan.json keeps the idea visible with an error', () => {
  const files = fixtureFiles();
  files['domain-2-dark-mode/plan.json'] = '{ nope';
  const i = buildModel(files).ideas[1];
  expect(i.plan).toBeNull();
  expect(i.error).toMatch(/plan\.json/);
  expect(i.status).toStrictEqual({
    key: 'other',
    label: 'invalid plan',
    flagged: true,
  });
});

test('windows separators and ./ prefixes in paths are normalised', () => {
  const files = fixtureFiles();
  const md = files['domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md'];
  delete files['domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md'];
  files['.\\domain-2-dark-mode\\phases\\phase-1-tokens\\step-1-extract-tokens.md'] = md;
  expect(buildModel(files).ideas[1].steps[0].specMd).toBe(md);
});

test('spec-file values are relative to the specs root; an old specs/ prefix finds no spec', () => {
  const files = fixtureFiles();
  const s1 = buildModel(files).ideas[1].steps[0];
  expect(s1.specPath).toBe('domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md');
  expect(s1.specMd).toContain('Extract tokens');
  const plan = JSON.parse(files['domain-2-dark-mode/plan.json']);
  plan.phases[0].steps[0]['spec-file'] = 'specs/' + plan.phases[0].steps[0]['spec-file'];
  files['domain-2-dark-mode/plan.json'] = JSON.stringify(plan);
  expect(buildModel(files).ideas[1].steps[0].specMd).toBeNull();
});

const run = (over: Partial<Run>): Run => ({
  kind: 'quick',
  id: 4,
  domain: 'domain-2-dark-mode',
  branch: 'quick-4',
  phase: 'develop',
  seen: '2026-10-06T10:00:00Z',
  ageSec: 12,
  worktree: 'D:/p/.claude/worktrees/quick-4',
  ahead: 2,
  behind: 0,
  dirty: false,
  ...over,
});

test('branch comes from plan.json and the quick step entry; plan steps share the plan branch', () => {
  const files = quickFixtureFiles();
  files['domain-2-dark-mode/plan.json'] = JSON.stringify({
    ...JSON.parse(files['domain-2-dark-mode/plan.json']),
    branch: 'plan-2',
  });
  const quick = JSON.parse(files['domain-2-dark-mode/quick-steps/quick-steps.json']);
  quick[0].branch = 'quick-4';
  files['domain-2-dark-mode/quick-steps/quick-steps.json'] = JSON.stringify(quick);
  const i = buildModel(files).ideas[1];
  expect(i.branch).toBe('plan-2');
  expect(i.phases[0].steps[0].branch).toBe('plan-2');
  expect(i.quickSteps[0].branch).toBe('quick-4');
  const plain = buildModel(quickFixtureFiles());
  expect(plain.ideas[1].branch).toBeNull();
  expect(plain.ideas[1].quickSteps[0].branch).toBeNull();
});

test('runs attach to their domain: a plan run to the idea and its steps, a quick run to its step', () => {
  const plan = run({ kind: 'plan', id: 2, branch: 'plan-2' });
  const quick = run({});
  const other = run({ id: 5, domain: 'domain-1-i18n' });
  const m = buildModel(quickFixtureFiles(), [plan, quick, other]);
  const [i18n, dark] = m.ideas;
  expect(dark.run).toBe(plan);
  expect(dark.phases[0].steps[0].run).toBe(plan);
  expect(dark.quickSteps[0].run).toBe(quick);
  expect(i18n.run).toBeNull();
  // quick step 5 of domain-1-i18n
  expect(i18n.quickSteps[0].run).toBe(other);
  expect(buildModel(quickFixtureFiles(), [run({ domain: 'domain-1-i18n' })]).ideas[1].quickSteps[0].run).toBeNull();
});

test('merged and discarded plans and steps are known statuses, not flagged', () => {
  const files = quickFixtureFiles();
  const plan = JSON.parse(files['domain-2-dark-mode/plan.json']);
  plan.status = 'merged';
  plan.phases[0].steps[0].status = 'merged';
  plan.phases[1].steps[0].status = 'discarded';
  files['domain-2-dark-mode/plan.json'] = JSON.stringify(plan);
  const i = buildModel(files).ideas[1];
  expect(i.status).toStrictEqual({ key: 'merged', label: 'merged', flagged: false });
  expect(i.steps[0].status).toStrictEqual({ key: 'merged', label: 'merged', flagged: false });
  expect(i.steps[1].status).toStrictEqual({ key: 'discarded', label: 'discarded', flagged: false });
});

test('an idea folder without idea.md takes its title from domain.json, else the plan', () => {
  const files = quickFixtureFiles();
  delete files['domain-2-dark-mode/idea.md'];
  expect(buildModel(files).ideas[1].title).toBe('Dark mode theme');
  delete files['domain-2-dark-mode/domain.json'];
  expect(buildModel(files).ideas[1].title).toBe('Dark mode');
});

test('a domain with several idea files: one entry each, planned by "ideas" of plan.json, title from the domain', () => {
  const files = quickFixtureFiles();
  delete files['domain-2-dark-mode/idea.md'];
  files['domain-2-dark-mode/idea-theme.md'] = '# Idea: Theme switch\n\n## Intent\nFollow the system.\n';
  files['domain-2-dark-mode/idea-contrast.md'] = '# Contrast\n\n## Intent\nHigh contrast.\n';
  files['domain-2-dark-mode/plan.json'] = JSON.stringify({
    ...PLAN,
    ideas: ['idea-theme.md'],
    phases: PLAN.phases.map((p) => ({ ...p, ideas: ['idea-theme.md'] })),
  });

  const i = buildModel(files).ideas[1];

  expect(i.ideaFiles.map((f) => [f.file, f.title, f.intent, f.planned])).toStrictEqual([
    ['idea-contrast.md', 'Contrast', 'High contrast.', false],
    ['idea-theme.md', 'Theme switch', 'Follow the system.', true],
  ]);
  expect(i.title).toBe('Dark mode theme');
  expect(i.intent).toBe('High contrast. · Follow the system.');
  expect(i.phases[0].ideas).toStrictEqual(['idea-theme.md']);
});

test('a plan with phases but without "ideas" covers the legacy idea.md', () => {
  const files = quickFixtureFiles();
  files['domain-2-dark-mode/idea-more.md'] = '# More';
  const i = buildModel(files).ideas[1];
  expect(i.ideaFiles.map((f) => [f.file, f.planned])).toStrictEqual([
    ['idea.md', true],
    ['idea-more.md', false],
  ]);
  expect(buildModel(files).ideas[0].ideaFiles.map((f) => f.planned)).toStrictEqual([false]);
});

test('quick steps belong to their idea without a phase and sort into the steps', () => {
  const m = buildModel(quickFixtureFiles());
  const [i18n, dark] = m.ideas;
  const q = dark.quickSteps[0];
  expect([q.number, q.slug, q.title, q.quick, q.phase]).toStrictEqual([4, 'fix-contrast', 'Fix contrast', true, null]);
  expect([q.status.key, q.hvn, q.ac]).toStrictEqual(['in-progress', true, { done: 1, total: 2 }]);
  expect(dark.steps.map((s) => s.number)).toStrictEqual([1, 2, 3, 4]);
  expect(dark.phases.flatMap((p) => p.steps)).not.toContain(q);
  expect(q.labels).toStrictEqual(['ui', 'css']);
  expect(i18n.plan).toBeNull();
  expect(i18n.quickSteps.map((s) => s.slug)).toStrictEqual(['add-german']);
  expect(m.steps).toHaveLength(5);
});

test('invalid quick-steps.json shows as an error on the idea', () => {
  const m = buildModel({
    'domain-1-x/idea.md': '# X',
    'domain-1-x/quick-steps/quick-steps.json': '{',
  });
  expect(m.ideas[0].error).toMatch(/^quick-steps\.json: /);
  expect(m.ideas[0].quickSteps).toStrictEqual([]);
});

test('a plan run joins by its id (= the domain id) even when its domain field differs', () => {
  const plan = run({ kind: 'plan', id: 2, domain: 'domain-2-renamed', branch: 'plan-2' });
  const m = buildModel(quickFixtureFiles(), [plan]);
  expect(m.ideas[1].run).toBe(plan);
  expect(m.ideas[0].run).toBeNull();
});

test('a quick run joins only a step whose id comes from its spec-file, never the list position', () => {
  const files = quickFixtureFiles();
  const quick = JSON.parse(files['domain-2-dark-mode/quick-steps/quick-steps.json']);
  quick[0]['spec-file'] = '';
  files['domain-2-dark-mode/quick-steps/quick-steps.json'] = JSON.stringify(quick);
  // the step falls back to number 1 (its position): a quick-1 run must not land on it
  const m = buildModel(files, [run({ id: 1 })]);
  expect(m.ideas[1].quickSteps[0].number).toBe(1);
  expect(m.ideas[1].quickSteps[0].run).toBeNull();
});

test('specsRel defaults to .specs and is carried as given', () => {
  expect(buildModel({}).specsRel).toBe('.specs');
  expect(buildModel({}, [], 'plans/specs').specsRel).toBe('plans/specs');
});

test('a plan with checked dependencies gives every step its depends-on; quick steps have none', () => {
  const i = dark();
  expect(i.dependenciesChecked).toBe(true);
  expect(i.steps.map((s) => [s.slug, s.dependsOn])).toStrictEqual([
    ['extract-tokens', []],
    ['media-query', []],
    ['toggle-button', ['media-query']],
  ]);
  const q = buildModel(quickFixtureFiles()).ideas.find((x) => x.slug === 'dark-mode')!;
  expect(q.quickSteps[0].dependsOn).toStrictEqual([]);
});

test('depends-on is ignored while the plan has no dependencies-checked', () => {
  const files = fixtureFiles();
  const plan = JSON.parse(files['domain-2-dark-mode/plan.json']);
  delete plan['dependencies-checked'];
  files['domain-2-dark-mode/plan.json'] = JSON.stringify(plan);
  const i = buildModel(files).ideas.find((x) => x.slug === 'dark-mode')!;
  expect(i.dependenciesChecked).toBe(false);
  expect(i.steps.map((s) => s.dependsOn)).toStrictEqual([[], [], []]);
});
