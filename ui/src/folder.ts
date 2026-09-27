// Reads a picked folder (File System Access API) into the same `path -> text` map the dev server's
// glob produces. Accepts specs/ itself or the repo root that contains it.

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

export async function readSpecsFolder(
  picked: DirLike,
): Promise<Record<string, string>> {
  let root = picked;
  let kids = await children(root);
  if (!kids.some(isDomain)) {
    const specs = kids.find(
      (h): h is DirLike => h.kind === "directory" && h.name === "specs",
    );
    if (specs) {
      root = specs;
      kids = await children(specs);
    } else if (picked.name !== "specs") {
      throw new Error(
        `"${picked.name}/" has no domain-* folders — pick the specs/ folder.`,
      );
    }
  }

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
