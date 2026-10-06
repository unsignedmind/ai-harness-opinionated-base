// Reads a folder (File System Access API in the standalone viewer, the disk on the dev server) into a
// `path relative to the specs root -> text` map. Accepts the specs root (.specs/) itself or the project
// folder that contains it (nos.config.json "specs" -> "dir", default .specs). Also reads the docs folder
// named in the project's nos.config.json ("spec-ui" -> "docs-folder", relative to the project folder).

export type FileLike = {
  kind: 'file';
  name: string;
  getFile(): Promise<{ text(): Promise<string> }>;
};
export type DirLike = {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<readonly [string, FileLike | DirLike]>;
};

export const PROJECT_CONFIG_FILE = 'nos.config.json';
export const DEFAULT_SPECS_DIR = '.specs';
export const DEFAULT_DOCS_FOLDER = 'docs';

async function children(dir: DirLike) {
  const out: (FileLike | DirLike)[] = [];
  for await (const [, h] of dir.entries()) out.push(h);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const isDomain = (h: FileLike | DirLike): h is DirLike => h.kind === 'directory' && h.name.startsWith('domain-');

const fileIn = (kids: (FileLike | DirLike)[], name: string) =>
  kids.find((h): h is FileLike => h.kind === 'file' && h.name === name);

// the project's nos.config.json, {} when missing or unreadable
async function projectConfig(root: DirLike): Promise<Record<string, unknown>> {
  const cfg = fileIn(await children(root), PROJECT_CONFIG_FILE);
  if (!cfg) return {};
  try {
    const v = JSON.parse(await (await cfg.getFile()).text());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const setting = (cfg: Record<string, unknown>, section: string, key: string) => {
  const v = (cfg[section] as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

// "a/b" -> ['a', 'b']; null for an empty path or one that leaves the folder. hidden: segments may
// start with "." (the specs root .specs), else such a segment (.git, .specs, ..) is refused
function segments(path: string, hidden = false): string[] | null {
  const parts = path.split(/[\\/]/).filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..') || /^[A-Za-z]:$/.test(parts[0])) return null;
  return hidden || parts.every((p) => !p.startsWith('.')) ? parts : null;
}

async function descend(dir: DirLike, parts: string[]): Promise<DirLike | null> {
  for (const p of parts) {
    const next = (await children(dir)).find((h): h is DirLike => h.kind === 'directory' && h.name === p);
    if (!next) return null;
    dir = next;
  }
  return dir;
}

// The specs root and the project folder it sits in (null when the specs root itself was picked).
// The project folder is the one with nos.config.json; its "specs" -> "dir" names the specs root.
// rel: the specs root relative to the project folder (".specs"); its own name when picked alone.
export async function locateSpecs(picked: DirLike): Promise<{ specs: DirLike; root: DirLike | null; rel: string }> {
  const kids = await children(picked);
  if (kids.some(isDomain)) return { specs: picked, root: null, rel: picked.name };
  if (fileIn(kids, PROJECT_CONFIG_FILE)) {
    const dir = setting(await projectConfig(picked), 'specs', 'dir') ?? DEFAULT_SPECS_DIR;
    const parts = segments(dir, true);
    const specs = parts && (await descend(picked, parts));
    if (specs) return { specs, root: picked, rel: parts.join('/') };
    throw new Error(`"${picked.name}/" has no ${dir}/ folder: run nos init there, or pick the specs folder itself.`);
  }
  const specs = kids.find((h): h is DirLike => h.kind === 'directory' && h.name === DEFAULT_SPECS_DIR);
  if (specs) return { specs, root: picked, rel: DEFAULT_SPECS_DIR };
  // a specs root without any domain yet
  if (picked.name === DEFAULT_SPECS_DIR) return { specs: picked, root: null, rel: picked.name };
  throw new Error(
    `"${picked.name}/" has no domain-* folders and no ${PROJECT_CONFIG_FILE}: pick the project folder or its ${DEFAULT_SPECS_DIR}/ folder.`,
  );
}

// Keys are relative to the specs root (domain-1-x/plan.json), like spec-file values. Only domain
// folders are read: .chat, .runs, .locks and .git never.
export async function readSpecsFolder(picked: DirLike): Promise<Record<string, string>> {
  const { specs } = await locateSpecs(picked);
  const kids = await children(specs);
  const files: Record<string, string> = {};
  const read = async (f: FileLike, path: string) => {
    files[path] = await (await f.getFile()).text();
  };
  const walkPhases = async (dir: DirLike, path: string) => {
    for (const h of await children(dir)) {
      if (h.kind === 'directory') await walkPhases(h, `${path}/${h.name}`);
      else if (h.name.endsWith('.md')) await read(h, `${path}/${h.name}`);
    }
  };
  for (const d of kids.filter(isDomain)) {
    for (const h of await children(d)) {
      const path = `${d.name}/${h.name}`;
      if (h.kind === 'file' && ['idea.md', 'domain.json', 'plan.json'].includes(h.name)) await read(h, path);
      else if (h.kind === 'directory' && h.name === 'phases') await walkPhases(h, path);
      else if (h.kind === 'directory' && h.name === 'quick-steps')
        for (const q of await children(h))
          if (q.kind === 'file' && (q.name === 'quick-steps.json' || q.name.endsWith('.md')))
            await read(q, `${path}/${q.name}`);
    }
  }
  return files;
}

// Docs: every text file under the docs folder, `path relative to it -> text`. Other files are
// skipped. `error` says why there are none (folder missing, the specs root picked without the project).
export type DocsData = {
  folder: string;
  files: Record<string, string>;
  error?: string;
};

const TEXT_EXT = new Set(
  'md markdown txt json jsonc xml yml yaml toml csv tsv html htm svg css scss js mjs cjs ts tsx jsx sh ps1 sql ini cfg env log'.split(
    ' ',
  ),
);
export const isTextFile = (name: string) => TEXT_EXT.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase());

// "spec-ui" -> "docs-folder" of the project's nos.config.json (main's on the dev server), default docs
export async function docsFolderOf(root: DirLike): Promise<string> {
  return setting(await projectConfig(root), 'spec-ui', 'docs-folder') ?? DEFAULT_DOCS_FOLDER;
}

// root: the project folder (null when only the specs root was picked)
export async function readDocs(specs: DirLike, root: DirLike | null): Promise<DocsData> {
  if (!root)
    return {
      folder: DEFAULT_DOCS_FOLDER,
      files: {},
      error: `${specs.name}/ was opened on its own. Open the project folder to see its docs as well.`,
    };
  const docsSetting = await docsFolderOf(root);
  const parts = segments(docsSetting);
  if (!parts)
    return {
      folder: docsSetting,
      files: {},
      error: `"docs-folder" in ${PROJECT_CONFIG_FILE} must name a folder inside the project (no part starting with "."), not "${docsSetting}".`,
    };
  const folder = parts.join('/');
  const dir = await descend(root, parts);
  if (!dir)
    return {
      folder,
      files: {},
      error: `No ${folder}/ folder in ${root.name}/. Set "spec-ui" → "docs-folder" in ${PROJECT_CONFIG_FILE}.`,
    };

  const files: Record<string, string> = {};
  const walk = async (d: DirLike, prefix: string) => {
    for (const h of await children(d)) {
      if (h.name.startsWith('.') || h.name === 'node_modules') continue;
      const path = prefix + h.name;
      if (h.kind === 'directory') await walk(h, path + '/');
      else if (isTextFile(h.name)) files[path] = await (await h.getFile()).text();
    }
  };
  await walk(dir, '');
  return { folder, files };
}
