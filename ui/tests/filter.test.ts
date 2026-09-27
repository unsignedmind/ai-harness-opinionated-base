import { test, expect } from "vitest";

import { buildModel } from "../src/model";
import {
  DEFAULT_FILTERS,
  applyFilters,
  counts,
  itemsAt,
  parseQuery,
  sortItems,
  toQuery,
  toggle,
  type Filters,
} from "../src/filter";
import { fixtureFiles } from "./fixtures";

const model = () => {
  const files = fixtureFiles();
  files["specs/domain-3-sync/plan.json"] = JSON.stringify({
    name: "Sync",
    status: "open",
    labels: ["backend"],
    phases: [
      {
        slug: "api",
        name: "API",
        status: "open",
        steps: [
          {
            slug: "endpoint",
            intent: "REST endpoint",
            status: "open",
            "spec-file": "",
          },
        ],
      },
    ],
  });
  return buildModel(files);
};
const f = (over: Partial<Filters> = {}): Filters => ({
  ...DEFAULT_FILTERS,
  ...over,
});
const slugs = (xs: { slug: string }[]) => xs.map((x) => x.slug);

test("no filters keep every step", () => {
  expect(slugs(applyFilters(itemsAt(model(), "steps"), f()))).toStrictEqual([
    "extract-tokens",
    "media-query",
    "toggle-button",
    "endpoint",
  ]);
});

test("itemsAt phases lists phases", () => {
  expect(slugs(itemsAt(model(), "phases"))).toStrictEqual([
    "tokens",
    "switch",
    "api",
  ]);
});

test("labels match any of the chosen labels", () => {
  const items = itemsAt(model(), "steps");
  expect(slugs(applyFilters(items, f({ labels: ["backend"] })))).toStrictEqual([
    "endpoint",
  ]);
  expect(applyFilters(items, f({ labels: ["backend", "ui"] }))).toHaveLength(4);
});

test("statuses match any of the chosen statuses", () => {
  const items = itemsAt(model(), "steps");
  expect(
    slugs(applyFilters(items, f({ statuses: ["done", "in-review"] }))),
  ).toStrictEqual(["extract-tokens", "media-query"]);
  expect(slugs(applyFilters(items, f({ statuses: ["other"] })))).toStrictEqual([
    "toggle-button",
  ]);
});

test("ideas match by slug", () => {
  expect(
    slugs(applyFilters(itemsAt(model(), "steps"), f({ ideas: ["sync"] }))),
  ).toStrictEqual(["endpoint"]);
});

test("different filter kinds combine with AND", () => {
  const items = itemsAt(model(), "steps");
  expect(
    applyFilters(items, f({ labels: ["ui"], statuses: ["open"] })),
  ).toStrictEqual([]);
  expect(
    slugs(applyFilters(items, f({ labels: ["ui"], statuses: ["done"] }))),
  ).toStrictEqual(["extract-tokens"]);
});

test("text search matches title, intent, phase and idea, case-insensitive", () => {
  const items = itemsAt(model(), "steps");
  expect(slugs(applyFilters(items, f({ q: "REST" })))).toStrictEqual([
    "endpoint",
  ]);
  expect(slugs(applyFilters(items, f({ q: "theme switch" })))).toStrictEqual([
    "media-query",
    "toggle-button",
  ]);
  expect(applyFilters(items, f({ q: "dark mode" }))).toHaveLength(3);
});

test("counts tally labels, statuses and ideas of the given items", () => {
  const c = counts(itemsAt(model(), "steps"));
  expect(c.labels).toStrictEqual({ ui: 3, css: 3, backend: 1 });
  expect(c.statuses).toStrictEqual({
    done: 1,
    "in-review": 1,
    other: 1,
    open: 1,
  });
  expect(c.ideas).toStrictEqual({ "dark-mode": 3, sync: 1 });
});

test("query roundtrip keeps every field, defaults are omitted", () => {
  const full = f({
    labels: ["ui", "css"],
    statuses: ["open", "in-progress"],
    ideas: ["sync"],
    q: "a b&c",
    level: "phases",
    sort: "status",
    dir: -1,
  });
  expect(parseQuery(toQuery(full))).toStrictEqual(full);
  expect(toQuery(f())).toBe("");
});

test("parseQuery ignores unknown statuses, levels and sorts", () => {
  expect(
    parseQuery("status=open,bogus&level=nope&sort=nope&dir=7"),
  ).toStrictEqual(f({ statuses: ["open"] }));
});

test("toggle adds a missing value and removes a present one", () => {
  expect(toggle(["a"], "b")).toStrictEqual(["a", "b"]);
  expect(toggle(["a", "b"], "a")).toStrictEqual(["b"]);
});

test("sort by id orders by idea, phase, step number; dir flips", () => {
  const items = itemsAt(model(), "steps");
  const reversed = [...items].reverse();
  expect(slugs(sortItems(reversed, "id", 1))).toStrictEqual(slugs(items));
  expect(slugs(sortItems(items, "id", -1))).toStrictEqual(slugs(reversed));
});

test("sort by status follows the lifecycle order", () => {
  expect(
    slugs(sortItems(itemsAt(model(), "steps"), "status", 1)),
  ).toStrictEqual([
    "endpoint",
    "media-query",
    "extract-tokens",
    "toggle-button",
  ]);
});

test("sort by title is alphabetical", () => {
  expect(slugs(sortItems(itemsAt(model(), "steps"), "title", 1))).toStrictEqual(
    ["endpoint", "extract-tokens", "media-query", "toggle-button"],
  );
});
