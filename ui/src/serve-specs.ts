// Dev server side of the live viewer (dev.html). The host reads specs/ from its own disk on every
// request, so any device on the network sees them without picking a folder. Serves `/` as dev.html,
// `GET /__specs` as `path -> text` JSON, and pushes "specs:changed" when a file under specs/ changes.
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";

import { readSpecsFolder, type DirLike, type FileLike } from "./folder.ts";

// A folder on disk in the shape of a File System Access handle, so readSpecsFolder reads it
export function nodeDir(path: string): DirLike {
  return {
    kind: "directory",
    name: basename(path),
    async *entries() {
      for (const e of await readdir(path, { withFileTypes: true })) {
        const p = join(path, e.name);
        if (e.isDirectory()) yield [e.name, nodeDir(p)] as const;
        else if (e.isFile())
          yield [
            e.name,
            {
              kind: "file",
              name: e.name,
              getFile: async () => ({ text: () => readFile(p, "utf8") }),
            } satisfies FileLike,
          ] as const;
      }
    },
  };
}

export function serveSpecs(specsDir: string): Plugin {
  const dir = resolve(specsDir);
  return {
    name: "serve-specs",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path === "/") req.url = "/dev.html";
        if (path !== "/__specs") return next();
        readSpecsFolder(nodeDir(dir)).then(
          (files) => {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(files));
          },
          (e: Error) => {
            res.statusCode = 500;
            res.end(e.message);
          },
        );
      });

      // nos writes several files at once: one refresh per burst
      let timer: ReturnType<typeof setTimeout> | undefined;
      server.watcher.add(dir);
      server.watcher.on("all", (_event, file) => {
        if (!resolve(file).startsWith(dir + sep)) return;
        clearTimeout(timer);
        timer = setTimeout(() => server.ws.send("specs:changed"), 100);
      });
    },
  };
}
