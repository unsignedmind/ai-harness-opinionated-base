import { test, expect } from "vitest";

import { esc, inline, renderMd } from "../src/markdown";

const body = (md: string) =>
  renderMd(md).replace(/^<div class="md">|<\/div>$/g, "");

test("esc escapes html special characters", () => {
  expect(esc(`<a href="x">'&'</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
  expect(esc(undefined)).toBe("");
});

test("raw html in markdown is escaped, never rendered", () => {
  const html = renderMd("<script>alert(1)</script>\n\n# <img src=x onerror=y>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});

test("headings, paragraphs and horizontal rules", () => {
  expect(body("# One\n## Two\n\nline a\nline b\n\n---")).toBe(
    "<h1>One</h1><h2>Two</h2><p>line a line b</p><hr>",
  );
});

test("inline code, bold, italic", () => {
  expect(inline("`a<b` **bold** *it*")).toBe(
    "<code>a&lt;b</code> <strong>bold</strong> <em>it</em>",
  );
});

test("http links open in a new tab, other links render as plain text", () => {
  expect(inline("[x](https://e.com)")).toBe(
    '<a href="https://e.com" target="_blank" rel="noopener">x</a>',
  );
  expect(inline("[x](javascript:alert(1))")).not.toContain("href");
});

test("unordered and ordered lists", () => {
  expect(body("- a\n- b\n\n1. c\n2. d")).toBe(
    "<ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol>",
  );
});

test("indented continuation lines join the list item", () => {
  expect(body("- a\n  more")).toBe("<ul><li>a more</li></ul>");
});

test("( ) / (x) and [ ] / [x] lines render as checkboxes", () => {
  expect(body("(x) done\n( ) todo\n- [X] md done")).toBe(
    '<ul class="checks">' +
      '<li class="check done"><span class="box">✓</span><span class="txt">done</span></li>' +
      '<li class="check"><span class="box"></span><span class="txt">todo</span></li>' +
      '<li class="check done"><span class="box">✓</span><span class="txt">md done</span></li>' +
      "</ul>",
  );
});

test("checkbox text with inline code stays one element", () => {
  expect(body("(x) a `b` c `d`")).toBe(
    '<ul class="checks"><li class="check done"><span class="box">✓</span>' +
      '<span class="txt">a <code>b</code> c <code>d</code></span></li></ul>',
  );
});

test("pipe tables render with a header row", () => {
  expect(body("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
    '<div class="tw"><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></div>',
  );
});

test("fenced code keeps content verbatim and escaped", () => {
  expect(body("```ts\nconst a = <b>;\n```")).toBe(
    "<pre><code>const a = &lt;b&gt;;</code></pre>",
  );
});

test("blockquotes", () => {
  expect(body("> a\n> b")).toBe("<blockquote>a b</blockquote>");
});

test("windows line endings", () => {
  expect(body("# A\r\n\r\ntext")).toBe("<h1>A</h1><p>text</p>");
});
