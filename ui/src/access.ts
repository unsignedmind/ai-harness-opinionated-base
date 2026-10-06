// Who may use the spec-ui dev server. This machine always (loopback socket and loopback Host). Any
// other device only once it is paired (cli/src/chat/devices.js, <specs>/.chat/devices.json):
//   1. `nos chat pair`, the dev-server banner or "Pair a device" in the chat panel gives a one-time
//      link `/?pair=<code>` (10 min, single use)
//   2. opening it uses the code up; the device waits on /__pair with a 4-digit number
//   3. someone at this machine approves the device (chat panel or `nos chat devices --approve`)
//   4. the device's next status check sets its own cookie (30 days idle), only a hash is stored
// Unpaired devices get the pairing page for pages and 401 for everything else, including the HMR
// websocket. Devices are listed, approved and revoked only from this machine (/__chat/devices).
import type http from 'node:http';
import { networkInterfaces } from 'node:os';

import { audit, createDeviceStore, type Device, type DeviceStore } from '../../cli/src/chat/devices.js';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

export const DEVICE_COOKIE = 'nos_device';
export const PENDING_COOKIE = 'nos_pending';
const DEVICE_MAX_AGE = 30 * 24 * 3600;
const PENDING_MAX_AGE = 10 * 60;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function hostOf(header: string | undefined): string | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d{1,5})?$/.exec(String(header ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

export function cookieOf(req: Req, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// the Host header; over HTTPS vite speaks HTTP/2, which sends it as ":authority"
export const hostHeader = (req: Req) => String(req.headers.host ?? req.headers[':authority'] ?? '');

// This machine: loopback socket AND loopback Host (a LAN client can fake the Host header, a page
// using DNS rebinding cannot fake a loopback Host)
export const isLocal = (req: Req) =>
  LOOPBACK_ADDRS.has(req.socket?.remoteAddress ?? '') && LOOPBACK_HOSTS.has(hostOf(hostHeader(req)) ?? '');

// POSTs must come from the page itself
export function sameOrigin(req: Req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader(req).toLowerCase();
  } catch {
    return false;
  }
}

// adapters of VMs, WSL and containers: a phone cannot reach them (same list as `nos chat pair`)
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|br-|veth|utun|tailscale|zerotier/i;

export type PairUrl = { interface: string; virtual: boolean; url: string };

export function pairUrls(code: string, port: number, scheme = 'https', nets = networkInterfaces()): PairUrl[] {
  return Object.entries(nets)
    .flatMap(([name, list]) =>
      (list ?? [])
        .filter((n) => n.family === 'IPv4' && !n.internal)
        .map((n) => ({
          interface: name,
          virtual: VIRTUAL.test(name),
          url: `${scheme}://${n.address}:${port}/?pair=${code}`,
        })),
    )
    .sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

export type Who = { kind: 'local' } | { kind: 'device'; device: Device };

export type AccessOptions = {
  stateDir: string;
  // shown on the pairing page, to compare with the certificate the phone saw
  fingerprint?: () => string | null;
  // where this dev server can be reached from the network (for new pairing links)
  // (lan: false when it listens on this machine only)
  link?: () => { port: number; scheme: string; lan?: boolean };
  // devices changed (pairing request, approval, revoke): tell the open pages
  onChange?: () => void;
  now?: () => number;
};

const json = (res: Res, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

const cookie = (req: Req, name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
  ((req.socket as { encrypted?: boolean }).encrypted ? '; Secure' : '');

export function createAccess(opts: AccessOptions) {
  const store: DeviceStore = createDeviceStore({
    dir: opts.stateDir,
    now: opts.now,
  });
  const changed = () => opts.onChange?.();
  // open event streams per device, closed at once on revoke
  const streams = new Map<string, Set<Res>>();

  function who(req: Req): Who | null {
    if (isLocal(req)) return { kind: 'local' };
    const device = store.verify(cookieOf(req, DEVICE_COOKIE));
    return device ? { kind: 'device', device } : null;
  }

  const actor = (w: Who | null) => (w?.kind === 'device' ? w.device.id : 'local');

  function track(w: Who, res: Res) {
    if (w.kind !== 'device') return;
    const id = w.device.id;
    if (!streams.has(id)) streams.set(id, new Set());
    streams.get(id)!.add(res);
    res.on('close', () => streams.get(id)?.delete(res));
  }

  function cut(id: string) {
    for (const res of streams.get(id) ?? []) res.destroy();
    streams.delete(id);
  }

  function newLink() {
    const { port, scheme, lan = true } = opts.link?.() ?? { port: 5180, scheme: 'https' };
    // listening on this machine only: no link a phone could reach
    if (!lan) return { urls: [], expiresAt: 0, fingerprint: null, lan: false };
    const { code, expiresAt } = store.createCode();
    changed();
    return {
      urls: pairUrls(code, port, scheme),
      expiresAt,
      fingerprint: opts.fingerprint?.() ?? null,
      lan: true,
    };
  }

  // the pairing flow and the gate. Returns true when it answered the request.
  function handle(req: Req, res: Res): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;

    // 1. a pairing link: use the code up, the device waits for approval
    if (url.searchParams.has('pair') && (path === '/' || path === '/dev.html')) {
      const r = store.redeem(url.searchParams.get('pair') ?? '', {
        userAgent: String(req.headers['user-agent'] ?? ''),
        ip: req.socket?.remoteAddress ?? null,
      });
      if (!r) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          pairPage({
            state: 'invalid',
            fingerprint: opts.fingerprint?.() ?? null,
          }),
        );
        return true;
      }
      audit(opts.stateDir, {
        device: r.id,
        action: 'pair-request',
        detail: String(req.headers['user-agent'] ?? ''),
      });
      res.statusCode = 302;
      res.setHeader('Set-Cookie', cookie(req, PENDING_COOKIE, `${r.id}.${r.poll}`, PENDING_MAX_AGE));
      res.setHeader('Location', '/__pair');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      changed();
      return true;
    }

    // 2. waiting for approval
    if (path === '/__pair') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        pairPage({
          state: who(req) ? 'paired' : 'waiting',
          fingerprint: opts.fingerprint?.() ?? null,
        }),
      );
      return true;
    }
    if (path === '/__pair/status') {
      if (who(req)) return (json(res, 200, { status: 'paired' }), true);
      const [id, poll] = String(cookieOf(req, PENDING_COOKIE) ?? '').split('.');
      const c = id && poll ? store.claim(id, poll) : ({ status: 'gone' } as const);
      if (c.status === 'approved') {
        res.setHeader('Set-Cookie', [
          cookie(req, DEVICE_COOKIE, c.cookie, DEVICE_MAX_AGE),
          cookie(req, PENDING_COOKIE, '', 0),
        ]);
        audit(opts.stateDir, {
          device: c.id,
          action: 'paired',
          detail: c.name,
        });
        changed();
        json(res, 200, { status: 'paired' });
      } else json(res, 200, c);
      return true;
    }

    // 3. everything else needs this machine or a paired device
    if (who(req)) return false;
    const html = req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''));
    if (html) {
      res.statusCode = 302;
      res.setHeader('Location', '/__pair');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    } else json(res, 401, { error: 'unpaired' });
    return true;
  }

  // /__chat/devices… : only from this machine
  async function admin(req: Req, res: Res, route: string, body: () => Promise<Record<string, unknown>>) {
    if (!isLocal(req)) return json(res, 403, { error: 'only on the host' });
    const url = new URL(req.url ?? '/', 'http://x');
    const id = url.searchParams.get('id') ?? '';
    if (req.method === 'GET' && route === '/devices') return json(res, 200, { devices: store.list() });
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
    let ok = true;
    if (route === '/devices/pair') return json(res, 200, newLink());
    if (route === '/devices/approve') ok = store.approve(id);
    else if (route === '/devices/deny' || route === '/devices/revoke') {
      ok = store.revoke(id);
      cut(id);
    } else if (route === '/devices/rename') ok = store.rename(id, String((await body()).name ?? ''));
    else return json(res, 404, { error: 'not found' });
    if (ok) {
      audit(opts.stateDir, {
        device: 'local',
        action: route.slice('/devices/'.length),
        key: id,
      });
      changed();
    }
    return json(res, ok ? 200 : 404, {
      status: ok ? 'ok' : 'not-found',
      devices: store.list(),
    });
  }

  return { store, who, actor, track, handle, admin, newLink };
}

export type Access = ReturnType<typeof createAccess>;

// The page an unpaired device sees: waiting for approval (polls), invalid link, or nothing yet.
export function pairPage({
  state,
  fingerprint,
}: {
  state: 'waiting' | 'invalid' | 'paired';
  fingerprint: string | null;
}) {
  const fp = fingerprint
    ? `<p class="fp">Certificate: <code>${fingerprint}</code><br>It should match the fingerprint shown on the PC.</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pair this device</title><link rel="icon" href="data:,">
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--muted:#6b6b66;--accent:#2f5bea;--line:#e2e2dd}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececea;--muted:#9a9a94;--accent:#7a9bff;--line:#2c2c2c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh}
main{max-width:420px;padding:24px 16px;text-align:center}
.code{font:600 44px/1.2 ui-monospace,monospace;letter-spacing:.2em;margin:16px 0;color:var(--accent)}
.muted,.fp{color:var(--muted);font-size:14px}code{font-size:12px;word-break:break-all}
</style></head><body><main>
<h1>Pair this device</h1>
<div id="body">${
    state === 'invalid'
      ? '<p>This pairing link is used up or expired.</p><p class="muted">Get a new one on the PC: "Pair a device" in the chat panel, or <code>nos chat pair</code>.</p>'
      : state === 'paired'
        ? '<p>This device is paired.</p><p><a href="/">Open the specs</a></p>'
        : '<p class="muted">Checking…</p>'
  }</div>${fp}
</main>${
    state === 'waiting'
      ? `<script>
const body = document.getElementById('body');
async function poll() {
  try {
    const r = await (await fetch('/__pair/status', { cache: 'no-store' })).json();
    if (r.status === 'paired') { location.replace('/'); return; }
    if (r.status === 'pending') {
      body.innerHTML = '<p>Approve this device on the PC.</p><div class="code"></div><p class="muted">Allow it only if the PC shows the same number.</p>';
      body.querySelector('.code').textContent = r.confirm;
    } else {
      body.innerHTML = '<p>Not paired.</p><p class="muted">Open a pairing link from the PC: "Pair a device" in the chat panel, or <code>nos chat pair</code>. A link works once, for 10 minutes.</p>';
      return;
    }
  } catch {}
  setTimeout(poll, 2000);
}
poll();
</script>`
      : ''
  }</body></html>`;
}
