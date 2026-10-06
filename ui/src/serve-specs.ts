// Dev server side of the live viewer (dev.html). The host reads the project's specs root (.specs/,
// roots.specs from cli/src/roots.js) from its own disk on every request, so any device on the network
// sees it without picking a folder. Serves `/` as dev.html, `GET /__specs` as `path -> text` JSON
// (paths relative to the specs root), `GET /__docs` as the docs folder named in main's nos.config.json
// (relative to main), `GET /__runs` as the runs (src/serve-runs.ts), and pushes "specs:changed",
// "runs:changed" (a run file in .specs/.runs/) and "docs:changed" when a file under them changes.
// `POST /__promote?domain=<folder>` runs `nos create-plan --domain <folder> --hollow --root <main>`
// (Manual promote on the Ideas page). `/__chat/*` is the chat with Claude Code in the project
// (src/chat-proxy.ts). Every request, the HMR websocket included, passes src/access.ts first: this
// machine, or a paired device. Every start of the dev server restarts the project's chat server, so it
// runs the current nos code (not on vite's own restarts after a config change: once per process).
// Not set up (no nos.config.json in main, no specs root): the server still starts and answers every
// data route with the reason, so the page says "run nos init" instead of failing.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import qrcode from 'qrcode-generator';
import type { Connect, Plugin } from 'vite';

import { chatRoots, stateDirOf } from '../../cli/src/chat/paths.js';
import type { Roots } from '../../cli/src/roots.js';
import { createAccess, isLocal } from './access.ts';
import { chatHandler, nosCli, restartChatServer } from './chat-proxy.ts';
import { readDocs, readSpecsFolder, type DirLike, type FileLike } from './folder.ts';
import { runsHandler } from './serve-runs.ts';

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

// The roots of the project the viewer belongs to, or why there are none. The walk starts at cwd (the
// ui folder: it lands on the project's nos.config.json); NOS_SPECS_ROOT overrides it.
export type SpecsSetup = { roots: Roots; error?: undefined } | { roots?: undefined; error: string };

export function specsSetup({
  cwd,
  env = process.env,
}: {
  cwd: string;
  env?: Record<string, string | undefined>;
}): SpecsSetup {
  try {
    const roots = chatRoots({ cwd, env });
    if (!existsSync(roots.specs)) return { error: `nos is not set up: ${roots.specs} is missing. Run nos init` };
    return { roots };
  } catch (e) {
    const msg = (e as Error).message;
    return { error: msg.startsWith('nos is not set up') ? msg : `nos is not set up: ${msg}` };
  }
}

const DOMAIN = /^domain-\d+-[a-z0-9-]+$/;

type Res = {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
};

// promote one domain with a hollow plan.json; the CLI does all checks, its stderr is the error
export function promoteHandler(main: string, cli = nosCli()) {
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
      [cli, 'create-plan', '--domain', domain, '--hollow', '--root', main],
      (err, stdout, stderr) => {
        if (err) return fail(500, stderr.trim() || err.message);
        res.setHeader('Content-Type', 'application/json');
        res.end(stdout);
      },
    );
  };
}

// Folders under the specs root that are local state, never a reason to refresh (.runs/*.json is: the runs)
export const IGNORED_SPECS_DIRS = ['.git', '.chat', '.locks', join('.runs', 'logs')];

// what a change of file means for the pages: 'runs:changed', 'specs:changed' or null
export function specsEvent(specs: string, file: string): 'runs:changed' | 'specs:changed' | null {
  const f = resolve(file);
  const dir = resolve(specs);
  if (!f.startsWith(dir + sep)) return null;
  const rel = f.slice(dir.length + 1);
  if (IGNORED_SPECS_DIRS.some((d) => rel === d || rel.startsWith(d + sep))) return null;
  const runs = '.runs' + sep;
  if (rel === '.runs') return 'runs:changed';
  if (rel.startsWith(runs)) return /^[^\\/]+\.json$/.test(rel.slice(runs.length)) ? 'runs:changed' : null;
  return 'specs:changed';
}

// fingerprint of the HTTPS certificate (vite.config.ts), shown on the pairing page and the banner
export type ServeOptions = { fingerprint?: string | null };

const DATA_ROUTES = new Set(['/__specs', '/__docs', '/__runs', '/__promote']);

// not set up: this machine gets the reason on every data route, other devices nothing
function unconfigured(error: string): Plugin {
  return {
    name: 'serve-specs',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.warn(`  ➜  ${error}`);
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        if (!isLocal(req)) {
          res.statusCode = 401;
          return res.end('nos is not set up');
        }
        if (path === '/') req.url = '/dev.html';
        if (!DATA_ROUTES.has(path) && !path.startsWith('/__chat/')) return next();
        res.statusCode = 503;
        res.setHeader('Cache-Control', 'no-store');
        if (path.startsWith('/__chat/')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.end(JSON.stringify({ error }));
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(error);
      });
    },
  };
}

export function serveSpecs(setup: SpecsSetup, serveOpts: ServeOptions = {}): Plugin {
  if (!setup.roots) return unconfigured(setup.error);
  const roots = setup.roots;
  const dir = resolve(roots.specs);
  const root = roots.main;
  // set on each /__docs request, since the config may change
  let docsDir: string | null = null;
  const promote = promoteHandler(root);
  const runs = runsHandler(roots);
  const chatState = stateDirOf(roots);
  // filled in configureServer: where the server listens and how to tell the pages about devices
  let link = { port: 5180, scheme: 'http', lan: false };
  let notify = () => {};
  const access = createAccess({
    stateDir: chatState,
    fingerprint: () => serveOpts.fingerprint ?? null,
    link: () => link,
    onChange: () => notify(),
  });
  const chat = chatHandler(roots, { stateDir: chatState, access });
  return {
    name: 'serve-specs',
    apply: 'serve',
    // chat state, locks and run logs change all the time: not even watched (vite ignores .git itself)
    config: () => ({
      server: {
        watch: {
          ignored: IGNORED_SPECS_DIRS.filter((d) => d !== '.git').map((d) => `${join(dir, d).split(sep).join('/')}/**`),
        },
      },
    }),
    configureServer(server) {
      notify = () => server.ws.send('chat:devices');
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (access.handle(req, res)) return;
        if (path?.startsWith('/__chat/')) return void chat(req, res);
        if (path === '/') req.url = '/dev.html';
        if (path === '/__promote') return promote(req, res);
        if (path === '/__runs') return runs(req, res);
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

      // the HMR websocket only for this machine and paired devices (before vite's own handler)
      server.httpServer?.prependListener('upgrade', (req, socket) => {
        if (access.who(req)) return;
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
      });

      // couch mode (`npm run dev-to-lan`): a one-time pairing link (and QR code) for a phone
      server.httpServer?.once('listening', () => {
        const g = globalThis as { __nosChatRestarted?: boolean };
        if (!process.env.VITEST && !g.__nosChatRestarted) {
          g.__nosChatRestarted = true;
          restartChatServer(root).then(
            (url) => server.config.logger.info(`  ➜  Chat server: ${url} (restarted)`),
            (e: Error) => server.config.logger.warn(`  ➜  Chat server did not start: ${e.message}`),
          );
        }
        const addr = server.httpServer?.address();
        link = {
          port: typeof addr === 'object' && addr ? addr.port : 5180,
          scheme: server.config.server.https ? 'https' : 'http',
          lan: !!server.config.server.host,
        };
        if (!server.config.server.host || process.env.VITEST) return;
        setTimeout(() => {
          const { urls, fingerprint } = access.newLink();
          const log = (m: string) => server.config.logger.info(m);
          const phone = urls.find((u) => !u.virtual);
          if (phone) {
            const qr = qrcode(0, 'L');
            qr.addData(phone.url);
            qr.make();
            log('\n' + qr.createASCII(1, 2));
          }
          for (const u of urls)
            log(
              `  ➜  Pair a phone: ${u.url}  (${u.interface}${u.virtual ? ', virtual adapter: not for the phone' : ''})`,
            );
          log('     One device, once, within 10 minutes; then allow it on this PC (same number).');
          log('     New link: "Pair a device" in the chat panel, or `nos chat pair`.');
          if (fingerprint) log(`     Certificate fingerprint: ${fingerprint}`);
        }, 50);
      });
      server.watcher.on('all', (_event, file) => {
        const event = specsEvent(dir, file);
        if (event) burst(event);
        if (docsDir && resolve(file).startsWith(docsDir + sep)) burst('docs:changed');
      });
    },
  };
}
