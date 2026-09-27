// Turns the raw files of specs/ into ideas -> phases -> steps. Pure: the loader hands over
// `repo-relative path -> text`, so tests feed fixtures and the app feeds `import.meta.glob`.
import { normStatus, type Status } from "./status";

export type Progress = { done: number; total: number };

export type Idea = {
  kind: "idea";
  folder: string;
  number: number;
  slug: string;
  title: string;
  intent: string;
  md: string | null;
  planJson: string | null;
  plan: { name: string } | null;
  error: string | null;
  status: Status;
  labels: string[];
  phases: Phase[];
  steps: Step[];
};

export type Phase = {
  kind: "phase";
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
  kind: "step";
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
  phase: Phase;
  labels: string[];
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
  "human-validation-needed": boolean;
  description: string;
  "spec-file": string;
}>;
type RawPhase = Partial<{
  slug: string;
  name: string;
  status: string;
  intent: string;
  "human-validation-needed": boolean;
  description: string;
  steps: RawStep[];
}>;
type RawPlan = Partial<{
  name: string;
  status: string;
  labels: string[];
  phases: RawPhase[];
}>;

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export const humanize = (slug: string) => {
  const s = slug.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function firstH1(md: string | null): string {
  const m = /^#\s+(.+)$/m.exec(md ?? "");
  return m ? m[1].trim() : "";
}

// text of `## name…` until the next `## `
export function section(md: string | null, name: string): string {
  const re = new RegExp("^##\\s+" + name + "\\b.*$", "mi");
  const text = md ?? "";
  const m = re.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const end = /^##\s/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

export function firstParagraph(text: string): string {
  for (const b of text.split(/\n\s*\n/)) {
    const t = b.trim();
    if (t && !/^[|#`]/.test(t)) return t.replace(/\s*\n\s*/g, " ");
  }
  return "";
}

// `( )` / `(x)` (step-spec template) and `[ ]` / `[x]` (markdown) checkboxes
export function progress(text: string): Progress {
  let done = 0,
    total = 0;
  for (const line of text.split("\n")) {
    const m = /^\s*(?:[-*]\s+)?[([]([ xX])[)\]]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== " ") done++;
  }
  return { done, total };
}

const numberIn = (path: string, prefix: string) => {
  const m = new RegExp(`(?:^|/)${prefix}-(\\d+)-`).exec(path);
  return m ? Number(m[1]) : null;
};

export function buildModel(input: Record<string, string>): Model {
  const files = new Map<string, string>();
  for (const [p, text] of Object.entries(input)) files.set(normPath(p), text);

  const folders = new Set<string>();
  for (const p of files.keys()) {
    const m = /^specs\/(domain-[^/]+)\//.exec(p);
    if (m) folders.add(m[1]);
  }

  const ideas = [...folders].map((folder) => buildIdea(folder, files));
  ideas.sort((a, b) => a.number - b.number || a.folder.localeCompare(b.folder));

  const phases = ideas.flatMap((i) => i.phases);
  const steps = ideas.flatMap((i) => i.steps);
  const labels = [...new Set(ideas.flatMap((i) => i.labels))].sort();
  return { ideas, phases, steps, labels };
}

function buildIdea(folder: string, files: Map<string, string>): Idea {
  const m = /^domain-(\d+)-(.*)$/.exec(folder);
  const md = files.get(`specs/${folder}/idea.md`) ?? null;
  const planJson = files.get(`specs/${folder}/plan.json`) ?? null;

  let raw: RawPlan | null = null;
  let error: string | null = null;
  if (planJson !== null) {
    try {
      raw = JSON.parse(planJson) as RawPlan;
    } catch (e) {
      error = `plan.json: ${(e as Error).message}`;
    }
  }

  const idea: Idea = {
    kind: "idea",
    folder,
    number: m ? Number(m[1]) : 0,
    slug: m ? m[2] : folder,
    title:
      firstH1(md).replace(/^idea:\s*/i, "") ||
      raw?.name ||
      (m ? humanize(m[2]) : folder),
    intent: firstParagraph(section(md, "Intent")),
    md,
    planJson,
    plan: raw ? { name: raw.name ?? "" } : null,
    error,
    status: raw
      ? normStatus(raw.status)
      : error
        ? { key: "other", label: "invalid plan", flagged: true }
        : { key: "other", label: "no plan", flagged: false },
    labels: raw?.labels ?? [],
    phases: [],
    steps: [],
  };

  let stepIndex = 0;
  (raw?.phases ?? []).forEach((rp, pi) => {
    const rawSteps = rp.steps ?? [];
    const firstSpec =
      rawSteps.map((s) => normPath(s["spec-file"] ?? "")).find(Boolean) ?? "";
    const phase: Phase = {
      kind: "phase",
      number: numberIn(firstSpec, "phase") ?? pi + 1,
      slug: rp.slug ?? `phase-${pi + 1}`,
      name: rp.name ?? humanize(rp.slug ?? `phase ${pi + 1}`),
      status: normStatus(rp.status),
      intent: rp.intent ?? "",
      description: rp.description ?? "",
      hvn: !!rp["human-validation-needed"],
      idea,
      labels: idea.labels,
      steps: [],
    };
    for (const rs of rawSteps) {
      stepIndex++;
      const specPath = normPath(rs["spec-file"] ?? "");
      const text = specPath ? files.get(specPath) : undefined;
      const specMd = text && text.trim() ? text : null;
      const slug = rs.slug ?? `step-${stepIndex}`;
      const step: Step = {
        kind: "step",
        number: numberIn(specPath, "step") ?? stepIndex,
        slug,
        title: firstH1(specMd) || humanize(slug),
        status: normStatus(rs.status),
        intent: rs.intent ?? "",
        description: rs.description ?? "",
        hvn: !!rs["human-validation-needed"],
        specPath,
        specMd,
        ac: progress(section(specMd, "Acceptance Criteria")),
        tasks: progress(section(specMd, "Task List")),
        idea,
        phase,
        labels: idea.labels,
      };
      phase.steps.push(step);
      idea.steps.push(step);
    }
    idea.phases.push(phase);
  });
  return idea;
}
