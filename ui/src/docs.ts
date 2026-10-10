// Turns the docs folder (`path relative to it -> text`) into a tree of folders and files. Pure, like
// model.ts. The tree follows whatever folders the project has; nothing about their names is assumed.
// The docs/ folders of the domains sit below a virtual folder DOMAINS_DIR, last in the root; its dot
// keeps it apart from the docs folder, whose hidden entries are never read.
import type { DocsData } from './folder';

export type DocFile = {
  kind: 'file';
  name: string;
  path: string;
  ext: string;
  title: string;
  text: string;
  // where it lies, as shown: docs/a/b.md, ../moodo-poc.specs/domain-5-x/docs/b.md
  loc: string;
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
  // as `loc` of DocFile, with a trailing slash; "" for the virtual folder
  loc: string;
  virtual?: true;
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
export const DOMAINS_DIR = '.domains';

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

function titleOf(name: string, ext: string, text: string) {
  if (ext !== 'md' && ext !== 'markdown') return name;
  const m = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(text);
  return m ? m[1] : name;
}

const dir = (name: string, path: string, loc: string, title = name): DocDir => ({
  kind: 'dir',
  name,
  path,
  title,
  children: [],
  landing: null,
  count: 0,
  loc,
});

// virtual folder last, then folders before files, by name
const rank = (n: DocNode) => (n.kind === 'file' ? 1 : n.virtual ? 2 : 0);

function finish(d: DocDir): number {
  d.children.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  d.count = 0;
  for (const c of d.children) d.count += c.kind === 'dir' ? finish(c) : 1;
  d.landing =
    LANDING.map((n) => d.children.find((c): c is DocFile => c.kind === 'file' && c.name.toLowerCase() === n)).find(
      Boolean,
    ) ?? null;
  return d.count;
}

// specsRel: the specs root as the project sees it, the start of the shown place of domain docs
export function buildDocs(data: DocsData | null, specsRel = ''): Docs {
  const folder = data?.folder ?? '';
  const root = dir('', '', folder && folder + '/');
  const byPath = new Map<string, DocNode>([['', root]]);
  // files of `files` below `top`, shown as lying in `loc`
  const add = (top: DocDir, files: Record<string, string>, loc: string) => {
    for (const [rel, text] of Object.entries(files)) {
      const parts = rel.split('/');
      let cur = top;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = [top.path, ...parts.slice(0, i + 1)].filter(Boolean).join('/');
        let next = byPath.get(p);
        if (!next || next.kind !== 'dir') {
          next = dir(parts[i], p, loc + parts.slice(0, i + 1).join('/') + '/');
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
        path: top.path ? `${top.path}/${rel}` : rel,
        ext,
        title: titleOf(name, ext, text),
        text,
        loc: loc + rel,
      };
      byPath.set(file.path, file);
      cur.children.push(file);
    }
  };
  add(root, data?.files ?? {}, root.loc);
  const domains = Object.entries(data?.domains ?? {});
  if (domains.length) {
    const virtual = { ...dir(DOMAINS_DIR, DOMAINS_DIR, '', 'Domains'), virtual: true as const };
    byPath.set(DOMAINS_DIR, virtual);
    root.children.push(virtual);
    const base = specsRel ? specsRel.replace(/\/+$/, '') + '/' : '';
    for (const [folderName, files] of domains) {
      const loc = `${base}${folderName}/docs/`;
      const d = dir(folderName, `${DOMAINS_DIR}/${folderName}`, loc, folderName.replace(/^domain-\d+-/, ''));
      byPath.set(d.path, d);
      virtual.children.push(d);
      add(d, files, loc);
    }
  }
  finish(root);
  return {
    folder,
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
  // a domain's docs end at its own folder
  const floor = parts[0] === DOMAINS_DIR ? 2 : 0;
  for (const p of decoded.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (parts.length <= floor) return null;
      parts.pop();
    } else parts.push(p);
  }
  const path = parts.join('/');
  return docs.byPath.has(path) ? path : null;
}
