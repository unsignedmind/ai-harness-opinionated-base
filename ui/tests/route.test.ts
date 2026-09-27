import { test, expect } from "vitest";

import { DEFAULT_FILTERS } from "../src/filter";
import { buildModel } from "../src/model";
import { hrefOf, parseRoute, viewHref } from "../src/route";
import { fixtureFiles } from "./fixtures";

test("empty or unknown hash opens explore overview", () => {
  for (const h of ["", "#", "#nope/x"])
    expect(parseRoute(h)).toStrictEqual({
      view: "explore",
      filters: DEFAULT_FILTERS,
    });
});

test("explore paths name idea, phase and step", () => {
  expect(parseRoute("#explore/dark-mode/switch/media-query")).toStrictEqual({
    view: "explore",
    idea: "dark-mode",
    phase: "switch",
    step: "media-query",
    filters: DEFAULT_FILTERS,
  });
  expect(parseRoute("#explore/dark-mode")).toMatchObject({ idea: "dark-mode" });
});

test("board and backlog read their filters from the query", () => {
  expect(parseRoute("#board?labels=ui&level=phases")).toStrictEqual({
    view: "board",
    filters: { ...DEFAULT_FILTERS, labels: ["ui"], level: "phases" },
  });
  expect(parseRoute("#backlog?sort=title")).toStrictEqual({
    view: "backlog",
    filters: { ...DEFAULT_FILTERS, sort: "title" },
  });
});

test("path segments are url-decoded", () => {
  expect(parseRoute("#explore/a%20b")).toMatchObject({ idea: "a b" });
});

test("hrefOf links ideas, phases and steps into explore", () => {
  const m = buildModel(fixtureFiles());
  const idea = m.ideas[1];
  expect(hrefOf(idea)).toBe("#explore/dark-mode");
  expect(hrefOf(idea.phases[1])).toBe("#explore/dark-mode/switch");
  expect(hrefOf(idea.steps[1])).toBe("#explore/dark-mode/switch/media-query");
});

test("viewHref appends a query only when filters differ from default", () => {
  expect(viewHref("board", DEFAULT_FILTERS)).toBe("#board");
  expect(viewHref("backlog", { ...DEFAULT_FILTERS, q: "x" })).toBe(
    "#backlog?q=x",
  );
});
