import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test, expect } from "vitest";

import { buildModel } from "../src/model";

// Reads the real specs/ the same way the viewer's glob does, so a plan.json the viewer cannot parse
// fails here first. specs/ sits at the repo root, five levels above this folder.
function readSpecs(): Record<string, string> {
  const root = resolve(import.meta.dirname, "../../../../../specs");
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|json)$/.test(name))
        out["specs/" + relative(root, p).replace(/\\/g, "/")] = readFileSync(
          p,
          "utf8",
        );
    }
  };
  for (const name of readdirSync(root))
    if (name.startsWith("domain-")) walk(join(root, name));
  return out;
}

test("every idea in specs/ parses without error", () => {
  const model = buildModel(readSpecs());
  expect(model.ideas.length).toBeGreaterThan(0);
  for (const idea of model.ideas) expect(idea.error).toBeNull();
});

test("every step names a known status and its spec file exists", () => {
  const files = readSpecs();
  for (const s of buildModel(files).steps) {
    expect(s.status.flagged, `${s.idea.folder}/${s.slug}`).toBe(false);
    if (s.specPath) expect(files[s.specPath], s.specPath).toBeDefined();
  }
});
