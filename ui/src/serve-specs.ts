// Dev server side of the live viewer (dev.html). The host reads specs/ from its own disk on every
// request, so any device on the network sees them without picking a folder. Serves `/` as dev.html,
// `GET /__specs` as `path -> text` JSON, `GET /__docs` as the docs folder named in specs/config.json
// (relative to the repo root, the parent of specs/), and pushes "specs:changed" / "docs:changed"
// when a file under either changes. `POST /__promote?domain=<folder>` runs
// `nos create-plan --domain <folder> --hollow` (Manual promote on the Ideas page). `/__chat/*` and
// `/?pair=<token>` belong to the chat with the project's Claude Code session (src/chat-proxy.ts).
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';

import { chatHandler, ensureToken, pairHandler, pairUrls, stateDirOf } from './chat-proxy.ts';
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

// the nos CLI next to the viewer: .claude/skills/nos/cli (resolved on use, so importing stays cheap)
const nosCli = () => fileURLToPath(new URL('../../cli/bin/nos.js', import.meta.url));
const DOMAIN = /^domain-\d+-[a-z0-9-]+$/;

type Res = { statusCode: number; setHeader(k: string, v: string): void; end(body?: string): void };

// promote one domain with a hollow plan.json; the CLI does all checks, its stderr is the error
export function promoteHandler(root: string, cli = nosCli()) {
  return (req: Connect.IncomingMessage, res: Res) => {
    const domain = new URLSearchParams(req.url?.split('?')[1] ?? '').get('domain') ?? '';
    const fail = (code: number, msg: string) => {
      res.statusCode = code;
      res.end(msg);
    };
    if (req.method !== 'POST') return fail(405, 'Use POST');
    if (!DOMAIN.test(domain)) return fail(400, `Not a domain folder: "${domain}"`);
    execFile(
      process.execPath,
      [cli, 'create-plan', '--domain', domain, '--hollow', '--root', root],
      (err, stdout, stderr) => {
        if (err) return fail(500, stderr.trim() || err.message);
        res.setHeader('Content-Type', 'application/json');
        res.end(stdout);
      },
    );
  };
}

export function serveSpecs(specsDir: string): Plugin {
  const dir = resolve(specsDir);
  const root = dirname(dir);
  // set on each /__docs request, since the config may change
  let docsDir: string | null = null;
  const promote = promoteHandler(root);
  const chatState = stateDirOf(root);
  const chat = chatHandler(root, { stateDir: chatState });
  const pair = pairHandler(chatState);
  // chat state changes with every message: never a specs refresh
  const chatDir = join(dir, '.chat') + sep;
  return {
    name: 'serve-specs',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (pair(req, res)) return;
        if (path?.startsWith('/__chat/')) return void chat(req, res);
        if (path === '/') req.url = '/dev.html';
        if (path === '/__promote') return promote(req, res);
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

      // couch mode (`npm run dev-to-lan`): print the pairing link for phones and tablets
      server.httpServer?.once('listening', () => {
        if (!server.config.server.host || process.env.VITEST) return;
        const addr = server.httpServer?.address();
        const port = typeof addr === 'object' && addr ? addr.port : 5180;
        setTimeout(() => {
          for (const p of pairUrls(ensureToken(chatState), port))
            server.config.logger.info(
              `  ➜  Chat pairing: ${p.url}  (${p.interface}${p.virtual ? ', virtual adapter: not for the phone' : ', open on the phone once'})`,
            );
        }, 50);
      });
      server.watcher.on('all', (_event, file) => {
        const f = resolve(file);
        if (f.startsWith(dir + sep) && !f.startsWith(chatDir)) burst('specs:changed');
        if (docsDir && f.startsWith(docsDir + sep)) burst('docs:changed');
      });
    },
  };
}
