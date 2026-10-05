// Dev server side of the live viewer (dev.html). The host reads specs/ from its own disk on every
// request, so any device on the network sees them without picking a folder. Serves `/` as dev.html,
// `GET /__specs` as `path -> text` JSON, `GET /__docs` as the docs folder named in specs/config.json
// (relative to the repo root, the parent of specs/), and pushes "specs:changed" / "docs:changed"
// when a file under either changes. `POST /__promote?domain=<folder>` runs
// `nos create-plan --domain <folder> --hollow` (Manual promote on the Ideas page). `/__chat/*` is the
// chat with Claude Code in the project (src/chat-proxy.ts). Every request, the HMR websocket
// included, passes src/access.ts first: this machine, or a paired device. Every start of the dev
// server restarts the project's chat server, so it runs the current nos code (not on vite's own
// restarts after a config change: once per process).
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import type { Connect, Plugin } from 'vite';

import { createAccess } from './access.ts';
import { chatHandler, restartChatServer, stateDirOf } from './chat-proxy.ts';
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

type Res = {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
};

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

// fingerprint of the HTTPS certificate (vite.config.ts), shown on the pairing page and the banner
export type ServeOptions = { fingerprint?: string | null };

export function serveSpecs(specsDir: string, serveOpts: ServeOptions = {}): Plugin {
  const dir = resolve(specsDir);
  const root = dirname(dir);
  // set on each /__docs request, since the config may change
  let docsDir: string | null = null;
  const promote = promoteHandler(root);
  const chatState = stateDirOf(root);
  // filled in configureServer: where the server listens and how to tell the pages about devices
  let link = { port: 5180, scheme: 'http', lan: false };
  let notify = () => {};
  const access = createAccess({
    stateDir: chatState,
    fingerprint: () => serveOpts.fingerprint ?? null,
    link: () => link,
    onChange: () => notify(),
  });
  const chat = chatHandler(root, { stateDir: chatState, access });
  // chat state changes with every message: never a specs refresh
  const chatDir = join(dir, '.chat') + sep;
  return {
    name: 'serve-specs',
    apply: 'serve',
    configureServer(server) {
      notify = () => server.ws.send('chat:devices');
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (access.handle(req, res)) return;
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
        const f = resolve(file);
        if (f.startsWith(dir + sep) && !f.startsWith(chatDir)) burst('specs:changed');
        if (docsDir && f.startsWith(docsDir + sep)) burst('docs:changed');
      });
    },
  };
}
