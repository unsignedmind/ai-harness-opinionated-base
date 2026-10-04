import { test, expect, beforeEach } from "vitest";

import { buildDocs, resolveDocLink, type DocDir } from "../src/docs";
import type { DocsData } from "../src/folder";
import { parseRoute } from "../src/route";
import { renderDocs } from "../src/views/docs";
import type { ExploreUi } from "../src/views/explore";

const data = (
  files: Record<string, string>,
  over: Partial<DocsData> = {},
): DocsData => ({
  folder: "docs",
  files,
  ...over,
});
const sample = () =>
  buildDocs(
    data({
      "index.md":
        "# Project docs\n\nSee [layers](architecture/layers.md) and [gone](nope.md).",
      "architecture/layers.md":
        "# The layers\n\nBack to [index](../index.md#top).",
      "architecture/reports/r1.md": "no heading",
      "guardrails.xml": "<rules/>",
      "config/app.json": '{"a":1}',
    }),
  );
const ui = (): ExploreUi => ({ expanded: new Set(), tabs: {} });
const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};
const view = (hash: string, u = ui(), docs = sample()) =>
  mount(renderDocs(docs, parseRoute(hash), u));

beforeEach(() => {
  document.body.innerHTML = "";
});

// ── model ──

test("builds a folder tree: folders first, then files, alphabetic", () => {
  const d = sample();
  expect(d.root.children.map((c) => c.name)).toStrictEqual([
    "architecture",
    "config",
    "guardrails.xml",
    "index.md",
  ]);
  const arch = d.byPath.get("architecture") as DocDir;
  expect(arch.children.map((c) => c.path)).toStrictEqual([
    "architecture/reports",
    "architecture/layers.md",
  ]);
  expect(arch.count).toBe(2);
  expect(d.root.count).toBe(5);
});

test("markdown files take their title from the first H1, others their name", () => {
  const d = sample();
  expect(d.byPath.get("architecture/layers.md")?.title).toBe("The layers");
  expect(d.byPath.get("architecture/reports/r1.md")?.title).toBe("r1.md");
  expect(d.byPath.get("guardrails.xml")?.title).toBe("guardrails.xml");
});

test("index.md or README.md is the landing page of its folder", () => {
  expect(sample().root.landing?.path).toBe("index.md");
  const d = buildDocs(data({ "a/README.md": "# A", "a/x.md": "" }));
  expect((d.byPath.get("a") as DocDir).landing?.path).toBe("a/README.md");
});

test("nothing loaded gives an empty tree", () => {
  const d = buildDocs(null);
  expect(d.root.count).toBe(0);
  expect(d.folder).toBe("");
  expect(d.error).toBeNull();
});

test("relative links resolve against the linking file", () => {
  const d = sample();
  expect(resolveDocLink(d, "index.md", "architecture/layers.md")).toBe(
    "architecture/layers.md",
  );
  expect(resolveDocLink(d, "architecture/layers.md", "../index.md#top")).toBe(
    "index.md",
  );
  expect(resolveDocLink(d, "architecture/layers.md", "./reports/r1.md")).toBe(
    "architecture/reports/r1.md",
  );
  expect(resolveDocLink(d, "index.md", "architecture")).toBe("architecture");
});

test("links outside the docs, to nothing, or absolute stay unresolved", () => {
  const d = sample();
  expect(resolveDocLink(d, "index.md", "nope.md")).toBeNull();
  expect(resolveDocLink(d, "index.md", "../src/app.ts")).toBeNull();
  expect(resolveDocLink(d, "index.md", "/index.md")).toBeNull();
  expect(resolveDocLink(d, "index.md", "mailto:a@b.c")).toBeNull();
  expect(resolveDocLink(d, "index.md", "#top")).toBeNull();
});

// ── view ──

test("root shows its landing page with working links, then its contents", () => {
  const detail = view("#docs").querySelector(".detail")!;
  expect(detail.querySelector("h1")?.textContent).toBe("Project docs");
  expect(
    detail.querySelector('a[href="#docs/architecture/layers.md"]')?.textContent,
  ).toBe("layers");
  expect(detail.querySelector("span.link")?.textContent).toBe("gone");
  expect(
    [...detail.querySelectorAll<HTMLElement>(".card")].map(
      (c) => c.dataset.href,
    ),
  ).toStrictEqual([
    "#docs/architecture",
    "#docs/config",
    "#docs/guardrails.xml",
  ]);
});

test("the tree lists top-level entries and opens the folders of the selection", () => {
  const root = view("#docs/architecture/reports/r1.md");
  expect(
    [...root.querySelectorAll<HTMLElement>(".tree .node")].map(
      (n) => n.dataset.href,
    ),
  ).toStrictEqual([
    "#docs/architecture",
    "#docs/architecture/reports",
    "#docs/architecture/reports/r1.md",
    "#docs/architecture/layers.md",
    "#docs/config",
    "#docs/guardrails.xml",
    "#docs/index.md",
  ]);
  expect(root.querySelector(".tree .node.sel")?.getAttribute("data-href")).toBe(
    "#docs/architecture/reports/r1.md",
  );
});

test("expanded folders stay open without being selected", () => {
  const u = ui();
  u.expanded.add("docs:config");
  const root = view("#docs", u);
  expect(
    root.querySelector('.tree .node[data-href="#docs/config/app.json"]'),
  ).not.toBeNull();
  expect(
    root.querySelector('.tree .node[data-href="#docs/architecture/layers.md"]'),
  ).toBeNull();
});

test("a folder without landing page lists its contents under crumbs", () => {
  const root = view("#docs/architecture");
  expect(root.querySelector(".crumbs")?.textContent).toBe(
    "Docs › architecture",
  );
  expect(root.querySelector(".detail h1")?.textContent).toBe("architecture");
  expect(root.querySelectorAll(".detail .card")).toHaveLength(2);
});

test("non-markdown files show as code, json pretty-printed", () => {
  const root = view("#docs/config/app.json");
  expect(root.querySelector(".detail h1")?.textContent).toBe("app.json");
  expect(root.querySelector(".detail pre code")?.textContent).toBe(
    '{\n  "a": 1\n}',
  );
  expect(
    view("#docs/guardrails.xml").querySelector("pre code")?.textContent,
  ).toBe("<rules/>");
});

test("an unknown path says so", () => {
  expect(view("#docs/nope.md").querySelector(".detail h1")?.textContent).toBe(
    "Not found",
  );
});

test("empty docs say why, with the pick button in the standalone viewer", () => {
  const err = buildDocs(data({}, { error: "No docs/ folder in repo/." }));
  const root = view("#docs", { ...ui(), canPick: true }, err);
  expect(root.querySelector(".empty .error")?.textContent).toBe(
    "No docs/ folder in repo/.",
  );
  expect(root.querySelector('.empty [data-action="pick"]')).not.toBeNull();
  expect(root.querySelector(".tree")).toBeNull();
  expect(
    view("#docs", ui(), buildDocs(data({}))).querySelector(".empty")
      ?.textContent,
  ).toContain("No text files under docs/");
});
