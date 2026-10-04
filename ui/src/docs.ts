// Turns the docs folder (`path relative to it -> text`) into a tree of folders and files. Pure, like
// model.ts. The tree follows whatever folders the project has; nothing about their names is assumed.
import type { DocsData } from './folder';

export type DocFile = {
  kind: 'file';
  name: string;
  path: string;
  ext: string;
  title: string;
  text: string;
};

export type DocDir = {
  kind: 'dir';
  name: string;
  path: string;
  title: string;
  children: DocNode[];
  // index.md / README.md of this folder, shown as its page
  landing: DocFile | null;
  // files below, at any depth
  count: number;
};

export type DocNode = DocFile | DocDir;

export type Docs = {
  // repo-relative, "" until something was loaded
  folder: string;
  error: string | null;
  root: DocDir;
  byPath: Map<string, DocNode>;
};

const LANDING = ['index.md', 'readme.md'];

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

function titleOf(name: string, ext: string, text: string) {
  if (ext !== 'md' && ext !== 'markdown') return name;
  const m = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(text);
  return m ? m[1] : name;
}

const dir = (name: string, path: string): DocDir => ({
  kind: 'dir',
  name,
  path,
  title: name,
  children: [],
  landing: null,
  count: 0,
});

function finish(d: DocDir): number {
  d.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  d.count = 0;
  for (const c of d.children) d.count += c.kind === 'dir' ? finish(c) : 1;
  d.landing =
    LANDING.map((n) => d.children.find((c): c is DocFile => c.kind === 'file' && c.name.toLowerCase() === n)).find(
      Boolean,
    ) ?? null;
  return d.count;
}

export function buildDocs(data: DocsData | null): Docs {
  const root = dir('', '');
  const byPath = new Map<string, DocNode>([['', root]]);
  for (const [path, text] of Object.entries(data?.files ?? {})) {
    const parts = path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      let next = byPath.get(p);
      if (!next || next.kind !== 'dir') {
        next = dir(parts[i], p);
        byPath.set(p, next);
        cur.children.push(next);
      }
      cur = next;
    }
    const name = parts[parts.length - 1];
    const ext = extOf(name);
    const file: DocFile = {
      kind: 'file',
      name,
      path,
      ext,
      title: titleOf(name, ext, text),
      text,
    };
    byPath.set(path, file);
    cur.children.push(file);
  }
  finish(root);
  return {
    folder: data?.folder ?? '',
    error: data?.error ?? null,
    root,
    byPath,
  };
}

// Resolves a link inside `from` (a file path) against the tree; the target path, or null when the
// link points outside the docs or to nothing.
export function resolveDocLink(docs: Docs, from: string, href: string): string | null {
  if (/^[a-z][\w+.-]*:|^#|^\//i.test(href)) return null;
  const target = href.replace(/[?#].*$/, '');
  if (!target) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  const parts = from.split('/').slice(0, -1);
  for (const p of decoded.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  const path = parts.join('/');
  return docs.byPath.has(path) ? path : null;
}
