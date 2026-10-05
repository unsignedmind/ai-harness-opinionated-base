// Loopback HTTP calls of the CLI and the Stop hook, and starting the chat server of a project.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStateDir, files, portOf, realDir } from './paths.js';

export const BIN = fileURLToPath(new URL('../../bin/nos.js', import.meta.url));
export const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// JSON over loopback. Leading spaces (await heartbeats) are trimmed before parsing.
export function request(port, method, urlPath, body, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          try {
            resolve({ code: res.statusCode, body: raw ? JSON.parse(raw) : {} });
          } catch {
            reject(new Error(`bad response from chat server: ${raw.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      },
    );
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

export function readServerJson(stateDir) {
  try {
    const s = JSON.parse(readFileSync(files(stateDir).server, 'utf8'));
    return Number.isInteger(s?.port) ? s : null;
  } catch {
    return null;
  }
}

export function writeServerJson(stateDir, info) {
  writeFileSync(files(stateDir).server, JSON.stringify(info, null, 2) + '\n');
}

export function removeServerJson(stateDir, pid = process.pid) {
  const s = readServerJson(stateDir);
  if (s && s.pid === pid) rmSync(files(stateDir).server, { force: true });
}

export async function health(port, timeoutMs = 1000) {
  try {
    const r = await request(port, 'GET', '/health', undefined, { timeoutMs });
    return r.code === 200 && r.body.ok && r.body.app === 'nos-chat' ? r.body : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The running server of this project (port from server.json), or null
export async function liveServer(root, stateDir) {
  const s = readServerJson(stateDir);
  if (!s) return null;
  const h = await health(s.port);
  return h && h.root === realDir(root) ? { port: s.port, version: h.version } : null;
}

// Reuse, restart (other version) or start the server of this project. Returns its port.
export async function ensureServer(root, stateDir, { env = process.env, log = () => {} } = {}) {
  ensureStateDir(stateDir);
  const me = realDir(root);
  const known = readServerJson(stateDir);
  const port = known?.port ?? portOf(root, env);
  const h = await health(port);
  if (h && h.root === me) {
    if (h.version === VERSION) return port;
    log(`chat server ${h.version} is outdated, restarting`);
    await request(port, 'POST', '/shutdown', {}).catch(() => {});
    for (let i = 0; i < 50 && (await health(port, 200)); i++) await sleep(100);
  }
  // the default port may belong to another project's server: then the new server picks a free one
  const want = h && h.root !== me ? 0 : portOf(root, env);
  const out = openSync(files(stateDir).log, 'a');
  const child = spawn(process.execPath, [BIN, 'chat', 'server', '--root', root, '--port', String(want)], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env,
  });
  closeSync(out);
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const s = readServerJson(stateDir);
    if (s && s.pid === child.pid && (await health(s.port, 500))) return s.port;
  }
  throw new Error(`chat server did not start, see ${files(stateDir).log}`);
}

export const sessionsFile = (stateDir) => files(stateDir).sessions;
export const hasState = (stateDir) => existsSync(path.join(stateDir, 'sessions.json'));
