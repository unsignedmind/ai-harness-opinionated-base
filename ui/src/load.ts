// The only untested piece: Vite bundles every spec file as text. Editing, adding or removing a spec
// while `npm run dev` runs reloads the page with fresh data.
import { buildModel, type Model } from "./model";

const raw = import.meta.glob<string>(
  [
    "../../../../../specs/domain-*/idea.md",
    "../../../../../specs/domain-*/plan.json",
    "../../../../../specs/domain-*/phases/**/*.md",
  ],
  { query: "?raw", import: "default", eager: true },
);

export function loadModel(): Model {
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(raw))
    files[path.replace(/^(\.\.\/)+/, "")] = text;
  return buildModel(files);
}
