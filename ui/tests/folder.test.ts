import { test, expect } from "vitest";

import { readSpecsFolder, type DirLike } from "../src/folder";

// In-memory stand-in for a File System Access directory handle: nested objects are folders,
// strings are files.
type Tree = { [name: string]: Tree | string };
function dir(name: string, tree: Tree): DirLike {
  return {
    kind: "directory",
    name,
    async *entries() {
      for (const [n, v] of Object.entries(tree))
        yield [
          n,
          typeof v === "string"
            ? {
                kind: "file" as const,
                name: n,
                getFile: async () => ({ text: async () => v }),
              }
            : dir(n, v),
        ] as const;
    },
  };
}

const specs: Tree = {
  "config.json": "{}",
  ui: { "index.html": "<html>" },
  "domain-1-i18n": {
    "idea.md": "# Idea: i18n",
    "plan.json": "{}",
    "notes.txt": "skip me",
    phases: {
      "phase-1-x": { "step-1-a.md": "# A", "draft.txt": "skip" },
    },
  },
  "domain-2-dark": { "idea.md": "# Idea: dark" },
};

test("reads idea.md, plan.json and phase markdown of every domain folder", async () => {
  expect(await readSpecsFolder(dir("specs", specs))).toStrictEqual({
    "specs/domain-1-i18n/idea.md": "# Idea: i18n",
    "specs/domain-1-i18n/plan.json": "{}",
    "specs/domain-1-i18n/phases/phase-1-x/step-1-a.md": "# A",
    "specs/domain-2-dark/idea.md": "# Idea: dark",
  });
});

test("accepts the repo root and descends into its specs/ folder", async () => {
  const files = await readSpecsFolder(dir("dompaine-gate", { src: {}, specs }));
  expect(Object.keys(files)).toContain("specs/domain-2-dark/idea.md");
});

test("a folder without domain-* folders and without specs/ is rejected", async () => {
  await expect(readSpecsFolder(dir("src", { "a.ts": "" }))).rejects.toThrow(
    /"src\/" has no domain-\* folders/,
  );
});

test("an empty specs/ folder is fine and yields no files", async () => {
  expect(
    await readSpecsFolder(dir("specs", { "config.json": "{}" })),
  ).toStrictEqual({});
});
