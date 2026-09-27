// Dev server (`npm run dev`) and tests (`npm test`) of the specs viewer. Its own package, separate
// from the project it sits in.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    port: 5180,
    open: "/dev.html",
    // the viewer reads specs/domain-*/ at the repo root, outside its root
    fs: { allow: [fileURLToPath(new URL("../../../..", import.meta.url))] },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
