import { test, expect } from "vitest";

import { buildModel } from "../src/model";
import { fixtureFiles, quickFixtureFiles } from "./fixtures";

const model = () => buildModel(fixtureFiles());
const dark = () => model().ideas.find((i) => i.slug === "dark-mode")!;

test("one idea per domain folder, sorted by number", () => {
  expect(model().ideas.map((i) => [i.folder, i.number, i.slug])).toStrictEqual([
    ["domain-1-i18n", 1, "i18n"],
    ["domain-2-dark-mode", 2, "dark-mode"],
  ]);
});

test("idea title drops the 'Idea:' prefix, intent is the first paragraph joined", () => {
  const i = dark();
  expect(i.title).toBe("Dark mode");
  expect(i.intent).toBe("App follows the system theme. Second line of intent.");
});

test("an idea without plan.json has no plan, a 'no plan' status and no phases", () => {
  const i = model().ideas[0];
  expect(i.plan).toBeNull();
  expect(i.status).toStrictEqual({
    key: "other",
    label: "no plan",
    flagged: false,
  });
  expect(i.phases).toStrictEqual([]);
  expect(i.labels).toStrictEqual([]);
});

test("plan status and labels come from plan.json", () => {
  const i = dark();
  expect(i.plan?.name).toBe("Dark mode");
  expect(i.status.key).toBe("in-progress");
  expect(i.labels).toStrictEqual(["ui", "css"]);
});

test("phases are numbered from their folder, keep intent, description and validation flag", () => {
  const [p1, p2] = dark().phases;
  expect([p1.number, p1.slug, p1.name, p1.status.key]).toStrictEqual([
    1,
    "tokens",
    "Colour tokens",
    "done",
  ]);
  expect(p1.intent).toBe("Move colours into tokens.");
  expect(p2.hvn).toBe(true);
  expect(p2.number).toBe(2);
});

test("steps are numbered from their spec file, else by position in the plan", () => {
  expect(dark().steps.map((s) => [s.number, s.slug])).toStrictEqual([
    [1, "extract-tokens"],
    [2, "media-query"],
    [3, "toggle-button"],
  ]);
});

test("steps link back to their phase and idea and inherit plan labels", () => {
  const s = dark().steps[1];
  expect(s.phase?.slug).toBe("switch");
  expect(s.quick).toBe(false);
  expect(s.idea.slug).toBe("dark-mode");
  expect(s.labels).toStrictEqual(["ui", "css"]);
});

test("step title is the spec H1 when present, else the humanised slug", () => {
  const [s1, s2, s3] = dark().steps;
  expect(s1.title).toBe("Extract tokens");
  expect(s2.title).toBe("Media query");
  expect(s3.title).toBe("Toggle button");
});

test("unknown step status is flagged", () => {
  expect(dark().steps[2].status).toStrictEqual({
    key: "other",
    label: "weird",
    flagged: true,
  });
});

test("acceptance criteria and tasks are counted only inside their sections", () => {
  const s = dark().steps[0];
  expect(s.ac).toStrictEqual({ done: 2, total: 3 });
  expect(s.tasks).toStrictEqual({ done: 2, total: 3 });
});

test("empty or missing spec file gives null md and zero progress", () => {
  const [, s2, s3] = dark().steps;
  expect(s2.specMd).toBeNull();
  expect(s2.specPath).toBe(
    "specs/domain-2-dark-mode/phases/phase-2-switch/step-2-media-query.md",
  );
  expect(s3.specMd).toBeNull();
  expect(s3.specPath).toBe("");
  expect(s3.ac).toStrictEqual({ done: 0, total: 0 });
});

test("flat lists and label set cover all ideas", () => {
  const m = model();
  expect(m.phases).toHaveLength(2);
  expect(m.steps).toHaveLength(3);
  expect(m.labels).toStrictEqual(["css", "ui"]);
});

test("broken plan.json keeps the idea visible with an error", () => {
  const files = fixtureFiles();
  files["specs/domain-2-dark-mode/plan.json"] = "{ nope";
  const i = buildModel(files).ideas[1];
  expect(i.plan).toBeNull();
  expect(i.error).toMatch(/plan\.json/);
  expect(i.status).toStrictEqual({
    key: "other",
    label: "invalid plan",
    flagged: true,
  });
});

test("windows separators and ./ prefixes in paths are normalised", () => {
  const files = fixtureFiles();
  const md =
    files[
      "specs/domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md"
    ];
  delete files[
    "specs/domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md"
  ];
  files[
    "specs\\domain-2-dark-mode\\phases\\phase-1-tokens\\step-1-extract-tokens.md"
  ] = md;
  expect(buildModel(files).ideas[1].steps[0].specMd).toBe(md);
});

test("an idea folder with only plan.json takes its title from the plan", () => {
  const files = fixtureFiles();
  delete files["specs/domain-2-dark-mode/idea.md"];
  expect(buildModel(files).ideas[1].title).toBe("Dark mode");
});

test("quick steps belong to their idea without a phase and sort into the steps", () => {
  const m = buildModel(quickFixtureFiles());
  const [i18n, dark] = m.ideas;
  const q = dark.quickSteps[0];
  expect([q.number, q.slug, q.title, q.quick, q.phase]).toStrictEqual([
    4,
    "fix-contrast",
    "Fix contrast",
    true,
    null,
  ]);
  expect([q.status.key, q.hvn, q.ac]).toStrictEqual([
    "in-progress",
    true,
    { done: 1, total: 2 },
  ]);
  expect(dark.steps.map((s) => s.number)).toStrictEqual([1, 2, 3, 4]);
  expect(dark.phases.flatMap((p) => p.steps)).not.toContain(q);
  expect(q.labels).toStrictEqual(["ui", "css"]);
  expect(i18n.plan).toBeNull();
  expect(i18n.quickSteps.map((s) => s.slug)).toStrictEqual(["add-german"]);
  expect(m.steps).toHaveLength(5);
});

test("invalid quick-steps.json shows as an error on the idea", () => {
  const m = buildModel({
    "specs/domain-1-x/idea.md": "# X",
    "specs/domain-1-x/quick-steps/quick-steps.json": "{",
  });
  expect(m.ideas[0].error).toMatch(/^quick-steps\.json: /);
  expect(m.ideas[0].quickSteps).toStrictEqual([]);
});
