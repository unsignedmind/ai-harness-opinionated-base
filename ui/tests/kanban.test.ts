import { test, expect, beforeEach } from "vitest";

import { buildModel } from "../src/model";
import { kanban } from "../src/views/kanban";
import { itemId, pill, rollup } from "../src/views/parts";
import { fixtureFiles, quickFixtureFiles } from "./fixtures";

const model = () => buildModel(fixtureFiles());
const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};
const colKeys = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(".col")].map((c) => c.dataset.status);

beforeEach(() => {
  document.body.innerHTML = "";
});

test("lifecycle columns always show, off-spec columns only when populated", () => {
  const root = mount(kanban(model().phases));
  expect(colKeys(root)).toStrictEqual([
    "open",
    "in-progress",
    "implemented",
    "in-review",
    "reviewed",
    "done",
  ]);
  expect(colKeys(mount(kanban(model().steps)))).toContain("other");
});

test("step kanban shows the specification columns between open and in progress", () => {
  expect(colKeys(mount(kanban(model().steps))).slice(0, 4)).toStrictEqual([
    "open",
    "in-specification",
    "specified",
    "in-progress",
  ]);
});

test("phase level hides the specification columns, even without items", () => {
  const keys = colKeys(mount(kanban([], { level: "phases" })));
  expect(keys).not.toContain("in-specification");
  expect(keys).not.toContain("specified");
});

test("each card sits in its status column and links to its explore detail", () => {
  const root = mount(kanban(model().steps));
  const review = root.querySelector('.col[data-status="in-review"]')!;
  const card = review.querySelector<HTMLElement>(".kcard")!;
  expect(card.dataset.href).toBe("#explore/dark-mode/switch/media-query");
  expect(card.textContent).toContain("Media query");
});

test("empty columns show a dash and a zero count", () => {
  const root = mount(kanban(model().steps));
  const col = root.querySelector('.col[data-status="implemented"]')!;
  expect(col.querySelector(".col-empty")?.textContent).toBe("—");
  expect(col.querySelector(".col-head .count")?.textContent).toBe("0");
});

test("cards within a column are sorted by id", () => {
  const steps = model().steps.map((s) => ({
    ...s,
    status: model().steps[0].status,
  }));
  const root = mount(kanban([...steps].reverse()));
  const ids = [...root.querySelectorAll(".kcard .id")].map(
    (e) => e.textContent,
  );
  expect(ids).toStrictEqual(["S1", "S2", "S3"]);
});

test("where option adds the idea › phase path", () => {
  const card = mount(kanban(model().steps, { where: true })).querySelector(
    '.kcard[data-href$="extract-tokens"]',
  )!;
  expect(card.querySelector(".path")?.textContent).toBe(
    "Dark mode › P1 Colour tokens",
  );
  const phaseCard = mount(
    kanban(model().phases, { where: true }),
  ).querySelector('.kcard[data-href$="tokens"]')!;
  expect(phaseCard.querySelector(".path")?.textContent).toBe("Dark mode");
});

test("step cards show AC progress, labels and the human-validation badge", () => {
  const root = mount(kanban(model().steps, { labels: true }));
  const first = root.querySelector('.kcard[data-href$="extract-tokens"]')!;
  expect(first.querySelector(".ac")?.textContent).toBe("AC 2/3");
  expect(
    [...first.querySelectorAll(".label")].map((l) => l.textContent),
  ).toStrictEqual(["ui", "css"]);
  expect(
    root.querySelector('.kcard[data-href$="toggle-button"] .hvn'),
  ).not.toBeNull();
  expect(first.querySelector(".hvn")).toBeNull();
});

test("phase cards show their step rollup", () => {
  const card = mount(kanban(model().phases)).querySelector(
    '.kcard[data-href$="switch"]',
  )!;
  expect(card.querySelector(".dots")?.children).toHaveLength(2);
});

test("itemId prefixes phases with P and steps with S", () => {
  const m = model();
  expect(itemId(m.phases[1])).toBe("P2");
  expect(itemId(m.steps[2])).toBe("S3");
});

test("pill marks flagged statuses", () => {
  const el = mount(
    pill({ key: "other", label: "weird", flagged: true }),
  ).firstElementChild!;
  expect(el.className).toBe("pill other flagged");
  expect(el.textContent).toBe("weird ⚠");
});

test("rollup counts items per status in lifecycle order", () => {
  const root = mount(rollup(model().steps));
  expect(
    [...root.querySelectorAll(".pill")].map((p) => p.textContent),
  ).toStrictEqual(["1 in review", "1 done", "1 other"]);
  expect(mount(rollup([])).textContent).toBe("no steps");
});

test("quick step cards carry a quick badge and a Quick path", () => {
  const root = mount(
    kanban(buildModel(quickFixtureFiles()).steps, { where: true }),
  );
  const cards = [...root.querySelectorAll<HTMLElement>(".kcard")];
  const quick = cards.filter((c) => c.querySelector(".quick"));
  expect(quick.map((c) => c.querySelector(".id")?.textContent)).toStrictEqual([
    "S5",
    "S4",
  ]);
  const contrast = quick.find((c) => c.textContent?.includes("Fix contrast"))!;
  expect(contrast.closest<HTMLElement>(".col")?.dataset.status).toBe(
    "in-progress",
  );
  expect(contrast.querySelector(".path")?.textContent).toBe(
    "Dark mode › Quick",
  );
  expect(contrast.dataset.href).toBe(
    "#explore/dark-mode/quick-steps/fix-contrast",
  );
  expect(cards.length - quick.length).toBe(3);
});
