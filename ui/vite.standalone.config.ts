// Builds the standalone viewer: `npm run build` -> bundle/viewer.js, one classic
// (IIFE) script that index.html loads straight from disk. Commit the result with source changes.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  build: {
    outDir: here("bundle"),
    emptyOutDir: true,
    lib: {
      entry: here("src/standalone.ts"),
      formats: ["iife"],
      name: "specsUi",
      fileName: () => "viewer.js",
    },
  },
});
