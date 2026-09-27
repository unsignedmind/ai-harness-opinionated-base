// Dev server (`npm run dev`) and tests (`npm test`) of the specs viewer. Its own package, separate
// from the project it sits in.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { serveSpecs } from "./src/serve-specs.ts";

export default defineConfig({
  // specs/ sits at the repo root, outside the viewer's root
  plugins: [
    serveSpecs(fileURLToPath(new URL("../../../../specs", import.meta.url))),
  ],
  server: {
    port: 5180,
    open: "/dev.html",
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
