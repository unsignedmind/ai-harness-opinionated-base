// Reads a picked folder (File System Access API) into the same `path -> text` map the dev server's
// glob produces. Accepts specs/ itself or the repo root that contains it. Also reads the docs folder
// named in specs/config.json ("spec-ui" -> "docs-folder", relative to the repo root).

export type FileLike = {
  kind: "file";
  name: string;
  getFile(): Promise<{ text(): Promise<string> }>;
};
export type DirLike = {
  kind: "directory";
  name: string;
  entries(): AsyncIterable<readonly [string, FileLike | DirLike]>;
};

async function children(dir: DirLike) {
  const out: (FileLike | DirLike)[] = [];
  for await (const [, h] of dir.entries()) out.push(h);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const isDomain = (h: FileLike | DirLike): h is DirLike =>
  h.kind === "directory" && h.name.startsWith("domain-");

// The specs/ folder and the repo root it sits in (null when specs/ itself was picked)
export async function locateSpecs(
  picked: DirLike,
): Promise<{ specs: DirLike; root: DirLike | null }> {
  const kids = await children(picked);
  if (kids.some(isDomain)) return { specs: picked, root: null };
  const specs = kids.find(
    (h): h is DirLike => h.kind === "directory" && h.name === "specs",
  );
  if (specs) return { specs, root: picked };
  if (picked.name === "specs") return { specs: picked, root: null };
  throw new Error(
    `"${picked.name}/" has no domain-* folders — pick the specs/ folder.`,
  );
}

export async function readSpecsFolder(
  picked: DirLike,
): Promise<Record<string, string>> {
  const { specs } = await locateSpecs(picked);
  const kids = await children(specs);
  const files: Record<string, string> = {};
  const read = async (f: FileLike, path: string) => {
    files[path] = await (await f.getFile()).text();
  };
  const walkPhases = async (dir: DirLike, path: string) => {
    for (const h of await children(dir)) {
      if (h.kind === "directory") await walkPhases(h, `${path}/${h.name}`);
      else if (h.name.endsWith(".md")) await read(h, `${path}/${h.name}`);
    }
  };
  for (const d of kids.filter(isDomain)) {
    for (const h of await children(d)) {
      const path = `specs/${d.name}/${h.name}`;
      if (h.kind === "file" && (h.name === "idea.md" || h.name === "plan.json"))
        await read(h, path);
      else if (h.kind === "directory" && h.name === "phases")
        await walkPhases(h, path);
    }
  }
  return files;
}

// Docs: every text file under the docs folder, `path relative to it -> text`. Other files are
// skipped. `error` says why there are none (folder missing, specs/ picked without the repo root).
export type DocsData = {
  folder: string;
  files: Record<string, string>;
  error?: string;
};

export const DEFAULT_DOCS_FOLDER = "docs";

const TEXT_EXT = new Set(
  "md markdown txt json jsonc xml yml yaml toml csv tsv html htm svg css scss js mjs cjs ts tsx jsx sh ps1 sql ini cfg env log".split(
    " ",
  ),
);
export const isTextFile = (name: string) =>
  TEXT_EXT.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase());

export async function docsFolderOf(specs: DirLike): Promise<string> {
  const cfg = (await children(specs)).find(
    (h): h is FileLike => h.kind === "file" && h.name === "config.json",
  );
  if (!cfg) return DEFAULT_DOCS_FOLDER;
  try {
    const v = JSON.parse(await (await cfg.getFile()).text())?.["spec-ui"]?.[
      "docs-folder"
    ];
    return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_DOCS_FOLDER;
  } catch {
    return DEFAULT_DOCS_FOLDER;
  }
}

export async function readDocs(
  specs: DirLike,
  root: DirLike | null,
): Promise<DocsData> {
  const setting = await docsFolderOf(specs);
  const parts = setting.split(/[\\/]/).filter((p) => p && p !== ".");
  const folder = parts.join("/");
  if (!parts.length || parts.includes(".."))
    return {
      folder: setting,
      files: {},
      error: `"docs-folder" in specs/config.json must name a folder inside the repo, not "${setting}".`,
    };
  if (!root)
    return {
      folder,
      files: {},
      error: `${specs.name}/ was opened on its own. Open the repo root to see ${folder}/ as well.`,
    };

  let dir = root;
  for (const p of parts) {
    const next = (await children(dir)).find(
      (h): h is DirLike => h.kind === "directory" && h.name === p,
    );
    if (!next)
      return {
        folder,
        files: {},
        error: `No ${folder}/ folder in ${root.name}/. Set "spec-ui" → "docs-folder" in specs/config.json.`,
      };
    dir = next;
  }

  const files: Record<string, string> = {};
  const walk = async (d: DirLike, prefix: string) => {
    for (const h of await children(d)) {
      if (h.name.startsWith(".") || h.name === "node_modules") continue;
      const path = prefix + h.name;
      if (h.kind === "directory") await walk(h, path + "/");
      else if (isTextFile(h.name))
        files[path] = await (await h.getFile()).text();
    }
  };
  await walk(dir, "");
  return { folder, files };
}
