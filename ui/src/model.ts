// Turns the raw files of the specs root (.specs/) into ideas -> phases -> steps. Pure: the loader
// hands over `path relative to the specs root -> text` (src/folder.ts readSpecsFolder), so tests feed
// fixtures. spec-file values in plan.json / quick-steps.json are relative to the specs root as well.
// Runs (GET /__runs) are joined in: a plan run by its domain, a quick run by its step.
import type { Run } from './runs';
import { normStatus, type Status } from './status';

export type Progress = { done: number; total: number };

export type Idea = {
  kind: 'idea';
  folder: string;
  number: number;
  slug: string;
  title: string;
  // domain name for Board and Backlog: `name` in domain.json, else the title
  name: string;
  intent: string;
  md: string | null;
  domainJson: string | null;
  planJson: string | null;
  plan: { name: string } | null;
  error: string | null;
  status: Status;
  // labels and cross-cutting come from domain.json
  labels: string[];
  crossCutting: boolean;
  phases: Phase[];
  // plan steps and quick steps
  steps: Step[];
  quickSteps: Step[];
  // branch of the plan (plan.json "branch", set by nos run start), null when it never ran
  branch: string | null;
  // the running plan run of this domain
  run: Run | null;
};

export type Phase = {
  kind: 'phase';
  number: number;
  slug: string;
  name: string;
  status: Status;
  intent: string;
  description: string;
  hvn: boolean;
  idea: Idea;
  labels: string[];
  steps: Step[];
};

export type Step = {
  kind: 'step';
  number: number;
  slug: string;
  title: string;
  status: Status;
  intent: string;
  description: string;
  hvn: boolean;
  specPath: string;
  specMd: string | null;
  ac: Progress;
  tasks: Progress;
  idea: Idea;
  // null for a quick step: a single step outside the plan (<domain>/quick-steps/)
  phase: Phase | null;
  quick: boolean;
  labels: string[];
  // quick step: its own branch ("branch" of the entry); plan step: the plan's
  branch: string | null;
  // quick step: its quick run; plan step: the plan run of its domain
  run: Run | null;
};

export type Model = {
  ideas: Idea[];
  phases: Phase[];
  steps: Step[];
  labels: string[];
};

type RawStep = Partial<{
  slug: string;
  intent: string;
  status: string;
  'human-validation-needed': boolean;
  description: string;
  'spec-file': string;
}>;
type RawQuickStep = RawStep & Partial<{ labels: string[]; branch: string }>;
type RawPhase = Partial<{
  slug: string;
  name: string;
  status: string;
  intent: string;
  'human-validation-needed': boolean;
  description: string;
  steps: RawStep[];
}>;
type RawPlan = Partial<{
  name: string;
  status: string;
  branch: string;
  phases: RawPhase[];
}>;
type RawDomain = Partial<{
  name: string;
  labels: string[];
  'cross-cutting': boolean;
}>;

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export const humanize = (slug: string) => {
  const s = slug.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function firstH1(md: string | null): string {
  const m = /^#\s+(.+)$/m.exec(md ?? '');
  return m ? m[1].trim() : '';
}

// text of `## name…` until the next `## `
export function section(md: string | null, name: string): string {
  const re = new RegExp('^##\\s+' + name + '\\b.*$', 'mi');
  const text = md ?? '';
  const m = re.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const end = /^##\s/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

export function firstParagraph(text: string): string {
  for (const b of text.split(/\n\s*\n/)) {
    const t = b.trim();
    if (t && !/^[|#`]/.test(t)) return t.replace(/\s*\n\s*/g, ' ');
  }
  return '';
}

// `( )` / `(x)` (step-spec template) and `[ ]` / `[x]` (markdown) checkboxes
export function progress(text: string): Progress {
  let done = 0,
    total = 0;
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*]\s+)?[([]([ xX])[)\]]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

const numberIn = (path: string, prefix: string) => {
  const m = new RegExp(`(?:^|/)${prefix}-(\\d+)-`).exec(path);
  return m ? Number(m[1]) : null;
};

export function buildModel(input: Record<string, string>, runs: Run[] = []): Model {
  const files = new Map<string, string>();
  for (const [p, text] of Object.entries(input)) files.set(normPath(p), text);

  const folders = new Set<string>();
  for (const p of files.keys()) {
    const m = /^(domain-[^/]+)\//.exec(p);
    if (m) folders.add(m[1]);
  }

  const ideas = [...folders].map((folder) => buildIdea(folder, files, runs));
  ideas.sort((a, b) => a.number - b.number || a.folder.localeCompare(b.folder));

  const phases = ideas.flatMap((i) => i.phases);
  const steps = ideas.flatMap((i) => i.steps);
  const labels = [...new Set(ideas.flatMap((i) => i.labels))].sort();
  return { ideas, phases, steps, labels };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function buildIdea(folder: string, files: Map<string, string>, runs: Run[]): Idea {
  const m = /^domain-(\d+)-(.*)$/.exec(folder);
  const md = files.get(`${folder}/idea.md`) ?? null;
  const domainJson = files.get(`${folder}/domain.json`) ?? null;
  const planJson = files.get(`${folder}/plan.json`) ?? null;

  let domain: RawDomain | null = null;
  let raw: RawPlan | null = null;
  let error: string | null = null;
  if (domainJson !== null) {
    try {
      domain = JSON.parse(domainJson) as RawDomain;
    } catch (e) {
      error = `domain.json: ${(e as Error).message}`;
    }
  }
  if (planJson !== null) {
    try {
      raw = JSON.parse(planJson) as RawPlan;
    } catch (e) {
      const msg = `plan.json: ${(e as Error).message}`;
      error = error ? `${error}; ${msg}` : msg;
    }
  }

  const title = firstH1(md).replace(/^idea:\s*/i, '') || domain?.name || raw?.name || (m ? humanize(m[2]) : folder);
  const idea: Idea = {
    kind: 'idea',
    folder,
    number: m ? Number(m[1]) : 0,
    slug: m ? m[2] : folder,
    title,
    name: domain?.name?.trim() || title,
    intent: firstParagraph(section(md, 'Intent')),
    md,
    domainJson,
    planJson,
    plan: raw ? { name: raw.name ?? '' } : null,
    error,
    status: raw
      ? normStatus(raw.status)
      : planJson !== null
        ? { key: 'other', label: 'invalid plan', flagged: true }
        : { key: 'other', label: 'no plan', flagged: false },
    labels: domain?.labels ?? [],
    crossCutting: !!domain?.['cross-cutting'],
    phases: [],
    steps: [],
    quickSteps: [],
    branch: str(raw?.branch),
    run: runs.find((r) => r.kind === 'plan' && r.domain === folder) ?? null,
  };

  let stepIndex = 0;
  (raw?.phases ?? []).forEach((rp, pi) => {
    const rawSteps = rp.steps ?? [];
    const firstSpec = rawSteps.map((s) => normPath(s['spec-file'] ?? '')).find(Boolean) ?? '';
    const phase: Phase = {
      kind: 'phase',
      number: numberIn(firstSpec, 'phase') ?? pi + 1,
      slug: rp.slug ?? `phase-${pi + 1}`,
      name: rp.name ?? humanize(rp.slug ?? `phase ${pi + 1}`),
      status: normStatus(rp.status),
      intent: rp.intent ?? '',
      description: rp.description ?? '',
      hvn: !!rp['human-validation-needed'],
      idea,
      labels: idea.labels,
      steps: [],
    };
    for (const rs of rawSteps) {
      stepIndex++;
      const step = buildStep(rs, files, idea, phase, stepIndex);
      phase.steps.push(step);
      idea.steps.push(step);
    }
    idea.phases.push(phase);
  });

  const quickJson = files.get(`${folder}/${QUICK_STEPS_JSON}`);
  if (quickJson !== undefined) {
    try {
      const rawQuick = JSON.parse(quickJson) as RawQuickStep[];
      if (!Array.isArray(rawQuick)) throw new Error('expected an array');
      rawQuick.forEach((rs, qi) => {
        const step = buildStep(rs, files, idea, null, qi + 1);
        step.labels = rs.labels ?? idea.labels;
        step.branch = str(rs.branch);
        step.run = runs.find((r) => r.kind === 'quick' && r.id === step.number && r.domain === folder) ?? null;
        idea.quickSteps.push(step);
        idea.steps.push(step);
      });
    } catch (e) {
      const msg = `quick-steps.json: ${(e as Error).message}`;
      idea.error = idea.error ? `${idea.error}; ${msg}` : msg;
    }
  }
  return idea;
}

// a domain with a plan.json is matured (Explore); without one it is a not yet refined idea (Ideas)
export const isMatured = (i: Idea) => i.planJson !== null;

export const QUICK_STEPS_JSON = 'quick-steps/quick-steps.json';

function buildStep(rs: RawStep, files: Map<string, string>, idea: Idea, phase: Phase | null, index: number): Step {
  const specPath = normPath(rs['spec-file'] ?? '');
  const text = specPath ? files.get(specPath) : undefined;
  const specMd = text && text.trim() ? text : null;
  const slug = rs.slug ?? `step-${index}`;
  return {
    kind: 'step',
    number: numberIn(specPath, 'step') ?? index,
    slug,
    title: firstH1(specMd) || humanize(slug),
    status: normStatus(rs.status),
    intent: rs.intent ?? '',
    description: rs.description ?? '',
    hvn: !!rs['human-validation-needed'],
    specPath,
    specMd,
    ac: progress(section(specMd, 'Acceptance Criteria')),
    tasks: progress(section(specMd, 'Task List')),
    idea,
    phase,
    quick: !phase,
    labels: idea.labels,
    branch: phase ? idea.branch : null,
    run: phase ? idea.run : null,
  };
}
