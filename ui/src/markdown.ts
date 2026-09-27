// Minimal markdown renderer for idea.md and step specs. Escapes first, so raw HTML never renders.
// Ported from moodo-poc/specs/ui, plus `( )` / `(x)` checkboxes from the n_os step-spec template.

export const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c: string) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) =>
    /^https?:\/\//.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>`
      : `<span class="link" title="${href}">${label}</span>`,
  );
  return t;
}

export function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t
      .slice(1, t.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

const CHECK = /^\s*(?:[-*]\s+)?[([]([ xX])[)\]]\s*(.*)$/;
const ITEM = /^\s*([-*]|\d+\.)\s+/;

export function renderMd(md: string | null | undefined): string {
  const lines = (md ?? "").replace(/\r\n?/g, "\n").split("\n");
  let out = "";
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out += `<p>${inline(para.join(" "))}</p>`;
    para.length = 0;
  };
  while (i < lines.length) {
    const L = lines[i];
    let m: RegExpExecArray | null;
    if (/^```/.test(L)) {
      flush();
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^```/.test(lines[j])) code.push(lines[j++]);
      out += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
      i = j + 1;
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(L))) {
      flush();
      out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
      i++;
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(L)) {
      flush();
      out += "<hr>";
      i++;
    } else if (/^\s*\|/.test(L)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = tableRows(rows.join("\n"));
      if (cells.length)
        out += `<div class="tw"><table>${cells
          .map((r, ri) => {
            const tag = ri === 0 ? "th" : "td";
            return `<tr>${r.map((c) => `<${tag}>${inline(c)}</${tag}>`).join("")}</tr>`;
          })
          .join("")}</table></div>`;
    } else if (CHECK.test(L)) {
      flush();
      let items = "";
      while (i < lines.length && (m = CHECK.exec(lines[i]))) {
        const done = m[1] !== " ";
        items += `<li class="check${done ? " done" : ""}"><span class="box">${done ? "✓" : ""}</span><span class="txt">${inline(m[2])}</span></li>`;
        i++;
      }
      out += `<ul class="checks">${items}</ul>`;
    } else if ((m = ITEM.exec(L))) {
      flush();
      const ordered = /\d/.test(m[1]);
      const items: string[] = [];
      while (i < lines.length && ITEM.test(lines[i]) && !CHECK.test(lines[i])) {
        let item = lines[i].replace(ITEM, "");
        i++;
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !ITEM.test(lines[i])
        )
          item += " " + lines[i++].trim();
        items.push(item);
      }
      const tag = ordered ? "ol" : "ul";
      out += `<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`;
    } else if (/^\s*>/.test(L)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out += `<blockquote>${inline(q.join(" "))}</blockquote>`;
    } else if (!L.trim()) {
      flush();
      i++;
    } else {
      para.push(L.trim());
      i++;
    }
  }
  flush();
  return `<div class="md">${out}</div>`;
}
