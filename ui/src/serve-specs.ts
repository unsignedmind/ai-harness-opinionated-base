// Dev server side of the live viewer (dev.html). The host reads specs/ from its own disk on every
// request, so any device on the network sees them without picking a folder. Serves `/` as dev.html,
// `GET /__specs` as `path -> text` JSON, `GET /__docs` as the docs folder named in specs/config.json
// (relative to the repo root, the parent of specs/), and pushes "specs:changed" / "docs:changed"
// when a file under either changes.
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

import { readDocs, readSpecsFolder, type DirLike, type FileLike } from './folder.ts';

// A folder on disk in the shape of a File System Access handle, so readSpecsFolder reads it
export function nodeDir(path: string): DirLike {
  return {
    kind: 'directory',
    name: basename(path),
    async *entries() {
      for (const e of await readdir(path, { withFileTypes: true })) {
        const p = join(path, e.name);
        if (e.isDirectory()) yield [e.name, nodeDir(p)] as const;
        else if (e.isFile())
          yield [
            e.name,
            {
              kind: 'file',
              name: e.name,
              getFile: async () => ({ text: () => readFile(p, 'utf8') }),
            } satisfies FileLike,
          ] as const;
      }
    },
  };
}

export function serveSpecs(specsDir: string): Plugin {
  const dir = resolve(specsDir);
  const root = dirname(dir);
  // set on each /__docs request, since the config may change
  let docsDir: string | null = null;
  return {
    name: 'serve-specs',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (path === '/') req.url = '/dev.html';
        if (path !== '/__specs' && path !== '/__docs') return next();
        const read =
          path === '/__specs'
            ? readSpecsFolder(nodeDir(dir))
            : readDocs(nodeDir(dir), nodeDir(root)).then((docs) => {
                if (!docs.error) {
                  docsDir = resolve(root, docs.folder);
                  server.watcher.add(docsDir);
                }
                return docs;
              });
        read.then(
          (data) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(data));
          },
          (e: Error) => {
            res.statusCode = 500;
            res.end(e.message);
          },
        );
      });

      // nos writes several files at once: one refresh per burst
      const timers: Record<string, ReturnType<typeof setTimeout>> = {};
      const burst = (event: string) => {
        clearTimeout(timers[event]);
        timers[event] = setTimeout(() => server.ws.send(event), 100);
      };
      server.watcher.add(dir);
      server.watcher.on('all', (_event, file) => {
        const f = resolve(file);
        if (f.startsWith(dir + sep)) burst('specs:changed');
        if (docsDir && f.startsWith(docsDir + sep)) burst('docs:changed');
      });
    },
  };
}
