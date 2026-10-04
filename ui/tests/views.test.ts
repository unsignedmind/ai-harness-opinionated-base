import { test, expect, beforeEach } from "vitest";

import { DEFAULT_FILTERS, type Filters } from "../src/filter";
import { buildModel } from "../src/model";
import { parseRoute } from "../src/route";
import { renderBacklog } from "../src/views/backlog";
import { renderBoard } from "../src/views/board";
import { renderExplore, type ExploreUi } from "../src/views/explore";
import { filterBar } from "../src/views/filterbar";
import { fixtureFiles, quickFixtureFiles } from "./fixtures";

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
const explore = (hash: string, u = ui()) =>
  mount(renderExplore(model(), parseRoute(hash), u));

beforeEach(() => {
  document.body.innerHTML = "";
});

// ── filter bar ──

test("filter chips are links that toggle their value in the hash", () => {
  const root = mount(filterBar(model(), f({ labels: ["ui"] }), "board"));
  const ui = root.querySelector<HTMLAnchorElement>(
    'a.chip[data-kind="labels"][data-value="ui"]',
  )!;
  const css = root.querySelector<HTMLAnchorElement>(
    'a.chip[data-kind="labels"][data-value="css"]',
  )!;
  expect(ui.getAttribute("aria-pressed")).toBe("true");
  expect(ui.getAttribute("href")).toBe("#board");
  expect(css.getAttribute("href")).toBe("#board?labels=ui%2Ccss");
});

test("filter bar offers every label, status present, and idea with counts", () => {
  const root = mount(filterBar(model(), f(), "backlog"));
  const values = (kind: string) =>
    [...root.querySelectorAll<HTMLElement>(`a.chip[data-kind="${kind}"]`)].map(
      (c) => c.dataset.value,
    );
  expect(values("labels")).toStrictEqual(["css", "ui"]);
  expect(values("statuses")).toStrictEqual(["in-review", "done", "other"]);
  expect(values("ideas")).toStrictEqual(["dark-mode"]);
  expect(root.querySelector('a.chip[data-value="ui"] .n')?.textContent).toBe(
    "3",
  );
});

test("level switch and clear link keep the view", () => {
  const root = mount(filterBar(model(), f({ q: "x" }), "board"));
  expect(
    root.querySelector('a[data-level="phases"]')?.getAttribute("href"),
  ).toBe("#board?q=x&level=phases");
  expect(root.querySelector("a.clear")?.getAttribute("href")).toBe("#board");
  expect(root.querySelector<HTMLInputElement>("input#q")?.value).toBe("x");
});

test("no clear link without active filters", () => {
  expect(
    mount(filterBar(model(), f(), "board")).querySelector("a.clear"),
  ).toBeNull();
});

// ── board ──

test("board shows filtered steps as kanban with paths", () => {
  const root = mount(renderBoard(model(), f({ statuses: ["done"] })));
  expect(root.querySelectorAll(".kcard")).toHaveLength(1);
  expect(root.querySelector(".kcard .path")?.textContent).toContain(
    "Dark mode",
  );
  expect(root.querySelector(".shown")?.textContent).toBe("1 of 3 steps");
});

test("board at phase level shows phases", () => {
  const root = mount(renderBoard(model(), f({ level: "phases" })));
  expect(root.querySelectorAll(".kcard")).toHaveLength(2);
  expect(root.querySelector(".shown")?.textContent).toBe("2 of 2 phases");
});

// ── backlog ──

test("board columns follow the level: specification only for steps", () => {
  const cols = (level: Filters["level"]) =>
    [
      ...mount(
        renderBoard(model(), f({ level, q: "nothing-matches" })),
      ).querySelectorAll<HTMLElement>(".col"),
    ].map((c) => c.dataset.status);
  expect(cols("steps")).toContain("specified");
  expect(cols("phases")).not.toContain("specified");
});

test("backlog lists one row per filtered step linking to explore", () => {
  const root = mount(renderBacklog(model(), f({ labels: ["ui"] })));
  const rows = root.querySelectorAll<HTMLElement>("tbody tr[data-href]");
  expect(rows).toHaveLength(3);
  expect(rows[0].dataset.href).toBe("#explore/dark-mode/tokens/extract-tokens");
  expect(rows[0].textContent).toContain("AC 2/3");
});

test("backlog header links sort, clicking the active one flips direction", () => {
  const root = mount(renderBacklog(model(), f({ sort: "status" })));
  expect(
    root.querySelector('th a[data-sort="title"]')?.getAttribute("href"),
  ).toBe("#backlog?sort=title");
  const active = root.querySelector('th a[data-sort="status"]')!;
  expect(active.getAttribute("href")).toBe("#backlog?sort=status&dir=-1");
  expect(active.textContent).toContain("▲");
});

test("backlog status tiles filter to one status", () => {
  const root = mount(renderBacklog(model(), f()));
  expect(
    root.querySelector('a.stat[data-status="done"]')?.getAttribute("href"),
  ).toBe("#backlog?status=done");
  expect(root.querySelector("a.stat.all b")?.textContent).toBe("3");
});

test("backlog shows an empty row when nothing matches", () => {
  const root = mount(renderBacklog(model(), f({ q: "zzz" })));
  expect(root.querySelector("tbody")?.textContent).toContain("Nothing matches");
});

// ── explore ──

test("explore overview shows a card per idea with status and rollup", () => {
  const root = explore("#explore");
  const cards = root.querySelectorAll<HTMLElement>(".detail .card[data-href]");
  expect([...cards].map((c) => c.dataset.href)).toStrictEqual([
    "#explore/i18n",
    "#explore/dark-mode",
  ]);
  expect(cards[0].textContent).toContain("no plan");
  expect(cards[1].querySelector(".pill.in-progress")).not.toBeNull();
  expect(cards[1].textContent).toContain("2 phases · 3 steps");
});

test("tree lists ideas; the selected idea and phase expand", () => {
  const root = explore("#explore/dark-mode/switch");
  const nodes = [...root.querySelectorAll<HTMLElement>(".tree .node")].map(
    (n) => n.dataset.href,
  );
  expect(nodes).toStrictEqual([
    "#explore/i18n",
    "#explore/dark-mode",
    "#explore/dark-mode/tokens",
    "#explore/dark-mode/switch",
    "#explore/dark-mode/switch/media-query",
    "#explore/dark-mode/switch/toggle-button",
  ]);
  expect(root.querySelector(".tree .node.sel")?.getAttribute("data-href")).toBe(
    "#explore/dark-mode/switch",
  );
});

test("expanded set opens other nodes too", () => {
  const u = ui();
  u.expanded.add("dark-mode");
  u.expanded.add("dark-mode/tokens");
  const nodes = explore("#explore", u).querySelectorAll(".tree .node");
  expect(nodes).toHaveLength(5);
});

test("idea detail defaults to the phases board and offers the other tabs", () => {
  const root = explore("#explore/dark-mode");
  expect(root.querySelector(".detail h1")?.textContent).toContain("Dark mode");
  const tabs = [...root.querySelectorAll<HTMLElement>(".subtabs button")].map(
    (b) => b.dataset.tab,
  );
  expect(tabs).toStrictEqual([
    "Phases",
    "Steps",
    "idea.md",
    "domain.json",
    "plan.json",
  ]);
  expect(root.querySelectorAll(".subtab-body .kcard")).toHaveLength(2);
});

test("chosen subtab is remembered per key", () => {
  const u = ui();
  u.tabs.idea = "Steps";
  expect(
    explore("#explore/dark-mode", u).querySelectorAll(".subtab-body .kcard"),
  ).toHaveLength(3);
  u.tabs.idea = "idea.md";
  expect(
    explore("#explore/dark-mode", u).querySelector(".subtab-body .md")
      ?.textContent,
  ).toContain("Decisions");
});

test("idea without plan shows its idea.md and no board", () => {
  const root = explore("#explore/i18n");
  expect(root.querySelector(".subtab-body .md")?.textContent).toContain(
    "Two languages",
  );
  expect(root.querySelector(".board")).toBeNull();
});

test("phase detail shows intent, validation badge and a board of its steps", () => {
  const root = explore("#explore/dark-mode/switch");
  const d = root.querySelector(".detail")!;
  expect(d.querySelector(".crumbs")?.textContent).toBe(
    "Ideas › Dark mode › P2 Theme switch",
  );
  expect(d.textContent).toContain("Toggle theme.");
  expect(d.querySelector(".hvn")).not.toBeNull();
  expect(d.querySelectorAll(".subtab-body .kcard")).toHaveLength(2);
});

test("step detail shows meta, progress and the rendered spec", () => {
  const d = explore("#explore/dark-mode/tokens/extract-tokens").querySelector(
    ".detail",
  )!;
  expect(d.querySelector("h1")?.textContent).toContain("Extract tokens");
  expect(d.textContent).toContain("AC 2/3");
  expect(d.textContent).toContain("Tasks 2/3");
  expect(d.textContent).toContain(
    "specs/domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md",
  );
  expect(d.querySelectorAll(".md .check.done").length).toBeGreaterThan(0);
});

test("step without spec says so", () => {
  const d = explore("#explore/dark-mode/switch/toggle-button").querySelector(
    ".detail",
  )!;
  expect(d.textContent).toContain("No spec written yet");
});

test("unknown path shows a not-found note with a way back", () => {
  const d = explore("#explore/nope").querySelector(".detail")!;
  expect(d.textContent).toContain("Not found");
  expect(d.querySelector('a[href="#explore"]')).not.toBeNull();
});

test("invalid plan.json shows its error on the idea", () => {
  const files = fixtureFiles();
  files["specs/domain-2-dark-mode/plan.json"] = "{";
  const root = mount(
    renderExplore(buildModel(files), parseRoute("#explore/dark-mode"), ui()),
  );
  expect(root.querySelector(".error")?.textContent).toMatch(/plan\.json/);
});

// ── quick steps ──

const quickExplore = (hash: string, u = ui()) =>
  mount(renderExplore(buildModel(quickFixtureFiles()), parseRoute(hash), u));

test("tree shows a quick steps node under the idea", () => {
  const root = quickExplore("#explore/dark-mode/quick-steps/fix-contrast");
  const quick = root.querySelector<HTMLElement>(
    '.node[data-toggle="dark-mode/quick-steps"]',
  )!;
  expect(quick.textContent).toContain("Quick steps");
  expect(quick.dataset.href).toBe("#explore/dark-mode/quick-steps");
  expect(root.querySelector(".node.lvl2.sel")?.textContent).toContain(
    "Fix contrast",
  );
});

test("quick steps detail shows a board of the idea's quick steps", () => {
  const root = quickExplore("#explore/dark-mode/quick-steps");
  expect(root.querySelector(".detail h1")?.textContent).toContain(
    "Quick steps",
  );
  const cards = [...root.querySelectorAll(".detail .kcard")];
  expect(cards).toHaveLength(1);
  expect(cards[0].querySelector(".quick")).not.toBeNull();
});

test("quick step detail links back to the quick steps of its idea", () => {
  const root = quickExplore("#explore/dark-mode/quick-steps/fix-contrast");
  const crumbs = [...root.querySelectorAll<HTMLAnchorElement>(".crumbs a")];
  expect(crumbs.map((a) => a.getAttribute("href"))).toStrictEqual([
    "#explore",
    "#explore/dark-mode",
    "#explore/dark-mode/quick-steps",
  ]);
  expect(root.querySelector(".detail h1 .quick")).not.toBeNull();
  expect(root.querySelector(".detail")?.textContent).toContain(
    "Muted text is readable",
  );
});

test("idea without plan but with quick steps offers the steps board", () => {
  const root = quickExplore("#explore/i18n");
  const tabs = [...root.querySelectorAll(".subtabs button")].map(
    (b) => b.textContent,
  );
  expect(tabs).toStrictEqual(["Steps", "idea.md"]);
});

test("board and backlog include quick steps", () => {
  const m = buildModel(quickFixtureFiles());
  expect(
    mount(renderBoard(m, f())).querySelectorAll(".kcard .quick"),
  ).toHaveLength(2);
  expect(
    mount(renderBacklog(m, f())).querySelectorAll("td .quick"),
  ).toHaveLength(2);
});
