// Docs: the docs folder as a tree on the left, the chosen file or folder on the right. Built from
// whatever folders and text files the project has, plus the docs/ folders of the domains under "Domains".
import { resolveDocLink, type DocDir, type DocFile, type Docs } from '../docs';
import { esc, renderMd } from '../markdown';
import { hrefOfDoc, type Route } from '../route';
import type { ExploreUi } from './explore';
import { crumbs, plural, treeNode } from './parts';

const key = (d: DocDir) => `docs:${d.path}`;
const isMd = (f: DocFile) => f.ext === 'md' || f.ext === 'markdown';

function tree(docs: Docs, sel: string, ui: ExploreUi) {
  let out = '';
  const walk = (d: DocDir, depth: number) => {
    for (const c of d.children) {
      const style = depth ? `padding-left: ${8 + depth * 18}px` : '';
      const cls = c.path === sel ? 'sel' : '';
      if (c.kind === 'file') {
        out += treeNode(hrefOfDoc(c.path), cls, '', '', c.title, '', '', style);
        continue;
      }
      // like explore: the selection and its folders stay open
      const open = ui.expanded.has(key(c)) || sel === c.path || sel.startsWith(c.path + '/');
      out += treeNode(
        hrefOfDoc(c.path),
        `dir ${cls}`,
        open ? '▾' : '▸',
        '',
        c.title,
        `<span class="muted">${c.count}</span>`,
        key(c),
        style,
      );
      if (open) walk(c, depth + 1);
    }
  };
  walk(docs.root, 0);
  return `<nav class="tree" aria-label="Docs">${out}</nav>`;
}

function trail(docs: Docs, path: string) {
  const parts = path.split('/');
  return crumbs(
    ['Docs', '#docs'],
    ...parts.map((p, i): [string, string?] => {
      const at = parts.slice(0, i + 1).join('/');
      const node = docs.byPath.get(at);
      const label = node?.kind === 'dir' ? node.title : p;
      return i < parts.length - 1 ? [label, hrefOfDoc(at)] : [label];
    }),
  );
}

function body(docs: Docs, f: DocFile) {
  if (isMd(f))
    return renderMd(f.text, (href) => {
      const p = resolveDocLink(docs, f.path, href);
      return p === null ? null : hrefOfDoc(p);
    });
  let text = f.text;
  if (f.ext === 'json')
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* shown as it is */
    }
  return `<h1>${esc(f.name)}</h1><pre><code>${esc(text)}</code></pre>`;
}

const where = (f: DocFile) => `<p class="muted mono">${esc(f.loc)}</p>`;

function fileDetail(docs: Docs, f: DocFile) {
  return trail(docs, f.path) + where(f) + body(docs, f);
}

function cards(d: DocDir) {
  return `<div class="cards">${d.children
    .filter((c) => c !== d.landing)
    .map(
      (c) => `<div class="card" data-href="${esc(hrefOfDoc(c.path))}">
        <h3>${c.kind === 'dir' ? '▸ ' : ''}${esc(c.title)}</h3>
        <p class="muted">${c.kind === 'dir' ? plural(c.count, 'file') : esc(c.name)}</p>
      </div>`,
    )
    .join('')}</div>`;
}

function dirDetail(docs: Docs, d: DocDir) {
  const top = d.path ? trail(docs, d.path) : '';
  // project docs that could not be read, while domain docs could
  const note = !d.path && docs.error ? `<p class="error">${esc(docs.error)}</p>` : '';
  const rest = d.children.length > (d.landing ? 1 : 0);
  if (d.landing)
    return (
      top +
      where(d.landing) +
      body(docs, d.landing) +
      (rest ? `<h2>In ${esc(d.path ? d.title : docs.folder)}${d.virtual ? '' : '/'}</h2>${cards(d)}` : '')
    );
  return (
    top +
    `<h1>${esc(d.path ? d.title : 'Docs')}</h1>
    <p class="muted">${d.loc && !note ? `<span class="mono">${esc(d.loc)}</span> · ` : ''}${d.virtual ? 'the docs/ folders of the domains · ' : ''}${plural(d.count, 'file')}</p>` +
    note +
    cards(d)
  );
}

function empty(docs: Docs, canPick: boolean | undefined) {
  const why = docs.error
    ? `<p class="error">${esc(docs.error)}</p>`
    : docs.folder
      ? `<p class="muted">No text files under <code>${esc(docs.folder)}/</code>.</p>`
      : '<p class="muted">No docs loaded.</p>';
  const pick = canPick
    ? '<button type="button" class="primary" data-action="pick">Open the project folder</button>'
    : '';
  return `<h1>Docs</h1><div class="empty">${why}${pick}
    <p class="muted">The docs folder is set in the project's <code>nos.config.json</code>: <code>"spec-ui": { "docs-folder": "docs" }</code>, relative to the project folder.</p></div>`;
}

export function renderDocs(docs: Docs, r: Route, ui: ExploreUi): string {
  if (!docs.root.count) return `<div class="explore solo"><div class="detail">${empty(docs, ui.canPick)}</div></div>`;
  const sel = r.doc ?? '';
  const node = docs.byPath.get(sel);
  const detail = !node
    ? `<h1>Not found</h1><p class="muted">${esc(sel)} does not exist (anymore).</p><p><a href="#docs">Back to docs</a></p>`
    : node.kind === 'file'
      ? fileDetail(docs, node)
      : dirDetail(docs, node);
  return `<div class="explore docs">${tree(docs, sel, ui)}<div class="detail">${detail}</div></div>`;
}
