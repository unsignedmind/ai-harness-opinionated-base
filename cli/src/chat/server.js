// Chat server of one project. Plain HTTP on 127.0.0.1, built-in modules only. Holds the event
// streams, the presence state and the Claude Code processes of the tabs; the transcripts and the queues live
// in the store. Two ways to answer a chat tab:
//   runner (default): the server runs its own headless Claude Code session per tab (runner.js)
//   relay: a Claude Code session in a terminal takes messages with `nos chat await` and answers
//          with `nos chat reply` (the parked `await` calls below)
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { allowed } from './guard.js';
import { KEY } from './paths.js';
import { relTo } from './runner.js';
import { agentFile, tailTranscript, transcriptFile } from './transcript.js';
import { CLIENT_JS, CSS, chatPage, listPage } from './ui.js';

export const MAX_BODY = 1024 * 1024;
export const MAX_TEXT = 32000;

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(400, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function checkText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
    throw new HttpError(400, `text must be a non-empty string of at most ${MAX_TEXT} characters`);
  }
  return text;
}

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

export function createChatServer({
  store,
  version,
  fingerprint = null,
  root = '',
  thinkingMs = 90000,
  typingMs = 30000,
  sweepMs = 5000,
  heartbeatMs = 15000,
  pingMs = 25000,
  idleMs = 1800000,
  // a tab's Claude Code process with nothing to do (no turn, no subagent) ends after this
  procIdleMs = 600000,
  runner = null,
  // where the transcripts of Claude Code are (CLAUDE_CONFIG_DIR), see transcript.js
  claudeEnv = process.env,
  onStop = () => {},
}) {
  const wake = new EventEmitter();
  wake.setMaxListeners(0);
  const streams = new Map(); // key -> Set<res>
  const parked = new Set(); // { key, finish(result) }
  const workingAt = new Map();
  const typingAt = new Map();
  const awaitCount = new Map();
  const lastPresence = new Map();
  const procs = new Map(); // key -> Claude Code process of the tab (runner mode, runner.js open)
  const activity = new Map(); // key -> last tool call of the run
  const agents = new Map(); // key -> subagents of the last run (runner.js agentTracker)
  const allStreams = new Set(); // project-wide streams (spec-ui tabs)
  const tailStreams = new Set(); // details views: a followed transcript each
  let lastActive = Date.now();
  let stopping = false;

  function presenceFor(key, now = Date.now()) {
    const s = store.get(key);
    if (!s || s.status === 'ended') return 'ended';
    if (procs.get(key)?.busy) return 'thinking';
    if (runner) return s.pending.length > 0 ? 'queued' : 'ready';
    if (typingAt.has(key) && now - typingAt.get(key) < typingMs) return 'typing';
    if (workingAt.has(key) && now - workingAt.get(key) < thinkingMs) return 'thinking';
    if ((awaitCount.get(key) || 0) > 0) return 'listening';
    return s.pending.length > 0 ? 'queued' : 'waiting';
  }

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // per-session streams get the data as is, project-wide streams with the key
  const each = (key, event, data) => {
    for (const res of streams.get(key) ?? []) send(res, event, data);
    for (const res of allStreams) send(res, event, { key, ...data });
  };
  // open tabs, oldest first
  function sessionsView() {
    return store
      .list()
      .filter((s) => s.status !== 'ended')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((s) => ({
        key: s.key,
        title: s.title || 'New chat',
        presence: presenceFor(s.key),
        running: working(procs.get(s.key)),
        activity: activity.get(s.key) ?? null,
        agents: agents.get(s.key) ?? [],
        messages: s.messages,
        claudeSession: s.claudeSession,
        run: s.run,
        updatedAt: s.updatedAt,
      }));
  }
  function broadcastSessions() {
    if (!allStreams.size) return;
    const sessions = sessionsView();
    for (const res of allStreams) send(res, 'sessions', { sessions, runner: !!runner });
  }
  function broadcastPresence(key) {
    const state = presenceFor(key);
    lastPresence.set(key, state);
    each(key, 'presence', { state });
    broadcastSessions();
  }
  function broadcastChat(key) {
    const s = store.get(key);
    if (s) each(key, 'chat-sync', { chat: s.chat });
  }
  function broadcastEnded(key) {
    const s = store.get(key);
    each(key, 'ended', { endedBy: s?.endedBy ?? null });
    broadcastSessions();
  }

  const reply = (key, text) => {
    if (stopping || !store.get(key)) return;
    store.addAgentReply(key, text);
    broadcastChat(key);
  };
  // runner mode: the tab's own long-lived Claude Code process (runner.js), started on its first
  // message; it ends when the user stops it or after procIdleMs with nothing to do
  function openProc(key) {
    const cur = store.get(key);
    if (agents.delete(key)) each(key, 'agents', { agents: [] });
    const proc = runner.open({
      sessionId: cur.claudeSession,
      resume: cur.claudeStarted,
      title: cur.title,
      onStarted: () => {
        if (store.get(key) && !store.get(key).claudeStarted) store.update(key, { claudeStarted: true });
      },
      onBusy: (busy) => {
        if (!busy) activity.delete(key);
        broadcastPresence(key);
      },
      onText: (text) => reply(key, text),
      onError: (text) => reply(key, `⚠ ${text}`),
      onActivity: (text) => {
        activity.set(key, text);
        each(key, 'activity', { text });
        broadcastSessions();
      },
      onAgents: (list) => {
        agents.set(key, list);
        each(key, 'agents', { agents: list });
        broadcastSessions();
      },
      // the session started (or ended) a nos run: the tab shows it, sessions.json keeps it for a restart
      onRun: (run) => {
        if (!store.get(key)) return;
        store.update(key, { run });
        broadcastSessions();
      },
      onExit: (r) => {
        if (procs.get(key) === proc) procs.delete(key);
        activity.delete(key);
        if (r.stopped) reply(key, '_Stopped._');
        else if (r.error) reply(key, `⚠ ${r.error}`);
        broadcastPresence(key);
        pump(key);
      },
    });
    procs.set(key, proc);
    return proc;
  }
  // hand the queued messages of a tab to its process at once, also while Claude works
  function pump(key) {
    if (!runner || stopping) return;
    const s = store.get(key);
    if (!s || s.status === 'ended' || !s.pending.length) return;
    const batch = store.takeMessages(key);
    if (batch.status !== 'messages') return;
    const prompt = batch.items.map((i) => i.text).join('\n\n');
    if (!s.title) {
      const first = batch.items[0].text
        .replace(/^\[context: [^\]]*\]\n/, '')
        .replace(/\s+/g, ' ')
        .trim();
      store.update(key, { title: first.length > 40 ? first.slice(0, 39) + '…' : first });
    }
    if (!s.claudeSession) store.update(key, { claudeSession: randomUUID(), claudeStarted: false });
    try {
      (procs.get(key) ?? openProc(key)).send(prompt);
    } catch (err) {
      reply(key, `⚠ ${err.message}`);
    }
    broadcastPresence(key);
  }
  const stopRun = (key) => procs.get(key)?.stop();
  const working = (p) => !!p && (p.busy || p.agentsRunning);
  const clear = (key) => {
    workingAt.delete(key);
    typingAt.delete(key);
  };
  function handedOver(key, result) {
    if (result.status === 'messages') {
      workingAt.set(key, Date.now());
      typingAt.delete(key);
    }
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    const keys = allStreams.size ? store.list().map((s) => s.key) : [...streams.keys()];
    for (const key of keys) {
      const state = presenceFor(key, now);
      if (state !== lastPresence.get(key)) broadcastPresence(key);
    }
    const busy =
      [...streams.values()].some((s) => s.size) ||
      allStreams.size > 0 ||
      parked.size > 0 ||
      procs.size > 0 ||
      tailStreams.size > 0;
    for (const p of procs.values()) if (!working(p) && now - p.lastUse > procIdleMs) p.close();
    if (busy) lastActive = now;
    else if (idleMs > 0 && now - lastActive > idleMs) void stop();
  }, sweepMs);
  const ping = setInterval(() => {
    for (const set of [...streams.values(), allStreams, tailStreams]) for (const res of set) res.write(': ping\n\n');
  }, pingMs);

  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function html(res, body) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CSP,
    });
    res.end(body);
  }
  function asset(res, type, body) {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  }

  function session(key) {
    if (!KEY.test(key)) throw new HttpError(404, 'unknown session');
    const s = store.get(key);
    if (!s) throw new HttpError(404, 'unknown session');
    return s;
  }

  function events(req, res, key) {
    session(key);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    if (!streams.has(key)) streams.set(key, new Set());
    streams.get(key).add(res);
    send(res, 'chat-sync', { chat: store.get(key).chat });
    const state = presenceFor(key);
    lastPresence.set(key, state);
    send(res, 'presence', { state });
    res.on('close', () => streams.get(key)?.delete(res));
  }

  // Details view: the transcript of a tab's Claude Code session, or of one of its subagents
  // (?agent=<agentId> or ?tool=<tool_use id>), as `items` events: first the last steps, then each
  // new or changed step. Waits for the session to get its Claude Code id (first message).
  function transcriptEvents(res, q) {
    const key = q.get('key') ?? '';
    const agentId = q.get('agent') || null;
    const toolUseId = q.get('tool') || null;
    if (!KEY.test(key) || (agentId && !/^\w+$/.test(agentId)) || (toolUseId && !/^[\w-]+$/.test(toolUseId)))
      throw new HttpError(400, 'invalid key, agent or tool');
    session(key);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    tailStreams.add(res);
    let tail = null;
    let waiter = null;
    const follow = () => {
      const s = store.get(key);
      if (!s?.claudeSession) return false;
      const main = transcriptFile(root, s.claudeSession, claudeEnv);
      const file = agentId || toolUseId ? agentFile(main, { agentId, toolUseId }) : main;
      if (!file) return false;
      tail = tailTranscript(file, (items, info) => send(res, 'items', { items, ...info }), { rel: relTo(root) });
      return true;
    };
    if (!follow()) {
      send(res, 'items', { items: [], initial: true, truncated: false });
      waiter = setInterval(() => follow() && clearInterval(waiter), 1000);
    }
    res.on('close', () => {
      tailStreams.delete(res);
      clearInterval(waiter);
      tail?.close();
    });
  }

  function awaitCall(res, key, timeoutMs) {
    const first = store.takeMessages(key);
    if (first.status !== 'waiting' || timeoutMs === 0) {
      handedOver(key, first);
      if (first.status === 'messages') broadcastPresence(key);
      return json(res, 200, first);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.write(' ');
    clear(key);
    awaitCount.set(key, (awaitCount.get(key) || 0) + 1);
    broadcastPresence(key);

    let done = false;
    const entry = { key, finish };
    const heartbeat = setInterval(() => res.write(' '), heartbeatMs);
    const timer = timeoutMs > 0 ? setTimeout(() => finish({ status: 'waiting' }), timeoutMs) : null;
    const onWake = () => {
      const r = store.takeMessages(key);
      if (r.status !== 'waiting') finish(r);
    };
    function finish(result) {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      wake.off(key, onWake);
      parked.delete(entry);
      awaitCount.set(key, Math.max(0, (awaitCount.get(key) || 0) - 1));
      if (result) {
        handedOver(key, result);
        res.end(JSON.stringify(result));
      }
      broadcastPresence(key);
    }
    wake.on(key, onWake);
    parked.add(entry);
    res.on('close', () => {
      if (!done) {
        // client gone: put nothing on the wire
        finish(null);
      }
    });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const m = req.method;
    let k;

    if (m === 'GET' && p === '/health')
      return json(res, 200, { ok: true, app: 'nos-chat', version, fingerprint, root });
    if (m === 'POST' && p === '/shutdown') {
      json(res, 200, { status: 'stopping' });
      setImmediate(() => void stop());
      return;
    }
    if (m === 'GET' && p === '/') return html(res, listPage(store.list()));
    if (m === 'GET' && (k = /^\/chat\/([^/]+)$/.exec(p))) {
      const s = session(k[1]);
      return html(res, chatPage({ key: s.key, dir: s.dir, status: s.status, endedBy: s.endedBy, chat: s.chat }));
    }
    if (m === 'GET' && p === '/chat.css') return asset(res, 'text/css; charset=utf-8', CSS);
    if (m === 'GET' && p === '/client.js') return asset(res, 'text/javascript; charset=utf-8', CLIENT_JS);
    if (m === 'GET' && p === '/events-all') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      allStreams.add(res);
      const tabs = sessionsView();
      send(res, 'sessions', { sessions: tabs, runner: !!runner });
      for (const t of tabs) send(res, 'chat-sync', { key: t.key, chat: store.get(t.key).chat });
      res.on('close', () => allStreams.delete(res));
      return;
    }
    if (m === 'GET' && (k = /^\/events\/([^/]+)$/.exec(p))) return events(req, res, k[1]);
    if (m === 'GET' && p === '/transcript-events') return transcriptEvents(res, url.searchParams);
    if (m === 'GET' && p === '/api/sessions')
      return json(res, 200, { sessions: store.list(), tabs: sessionsView(), runner: !!runner });
    if (m === 'GET' && (k = /^\/api\/session\/([^/]+)$/.exec(p))) {
      const s = session(k[1]);
      const { key, dir, name, status, endedBy, chat } = s;
      const run = s.run ?? null;
      return json(res, 200, {
        key,
        dir,
        name,
        status,
        endedBy,
        chat,
        run,
        presence: presenceFor(key),
        running: working(procs.get(key)),
      });
    }
    if (m !== 'POST') throw new HttpError(404, 'not found');

    const body = await readJson(req);
    if (p === '/api/sessions') {
      if (typeof body.dir !== 'string' || !body.dir) throw new HttpError(400, 'dir is required');
      const r = store.open(body.dir, typeof body.name === 'string' ? body.name : '', body.reopen === true);
      if (r.status === 'refused') return json(res, 409, { status: 'user-ended', key: r.key });
      broadcastChat(r.key);
      broadcastPresence(r.key);
      return json(res, 200, { status: 'open', key: r.key, url: `/chat/${r.key}` });
    }
    if (p === '/api/sessions/new') {
      if (typeof body.dir !== 'string' || !body.dir) throw new HttpError(400, 'dir is required');
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : '';
      const r = store.create(body.dir, title);
      broadcastSessions();
      return json(res, 200, { status: 'open', key: r.key });
    }
    if (p === '/api/await') {
      const key = String(body.key ?? '');
      if (!KEY.test(key)) throw new HttpError(400, 'invalid key');
      const t = body.timeoutMs;
      const timeoutMs = t === undefined || t === null ? -1 : Number(t);
      if (!Number.isFinite(timeoutMs)) throw new HttpError(400, 'invalid timeoutMs');
      if (!store.get(key)) return json(res, 200, { status: 'missing' });
      // the server answers the chat itself: a terminal session must not take its messages
      if (runner) return json(res, 200, { status: 'runner' });
      return awaitCall(res, key, timeoutMs);
    }
    if (!(k = /^\/api\/session\/([^/]+)\/(messages|end|reply|typing|agent-end|stop|title)$/.exec(p))) {
      throw new HttpError(404, 'not found');
    }
    const s = session(k[1]);
    const key = s.key;
    switch (k[2]) {
      case 'messages': {
        const text = checkText(body.text);
        const item = store.addUserMessage(key, text, body.endSession === true);
        if (!item) return json(res, 409, { error: 'session ended' });
        broadcastChat(key);
        if (!runner) wake.emit(key);
        if (store.get(key).status === 'ended') {
          clear(key);
          broadcastEnded(key);
        }
        pump(key);
        broadcastPresence(key);
        return json(res, 200, {
          status: 'queued',
          id: item.id,
          pending: store.get(key).pending.length,
          presence: presenceFor(key),
        });
      }
      case 'end':
      case 'agent-end': {
        const by = k[2] === 'end' ? 'user' : 'agent';
        stopRun(key);
        store.end(key, by);
        clear(key);
        wake.emit(key);
        broadcastEnded(key);
        broadcastPresence(key);
        return json(res, 200, { status: 'ended', endedBy: by });
      }
      case 'stop': {
        const was = working(procs.get(key));
        stopRun(key);
        return json(res, 200, { status: was ? 'stopping' : 'idle' });
      }
      case 'title': {
        if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'title is required');
        store.update(key, { title: body.title.trim().slice(0, 60) });
        broadcastSessions();
        return json(res, 200, { status: 'ok' });
      }
      case 'reply': {
        const at = store.addAgentReply(key, checkText(body.text));
        clear(key);
        broadcastChat(key);
        broadcastPresence(key);
        return json(res, 200, { status: 'sent', at });
      }
      case 'typing': {
        const state = body.state ?? 'typing';
        if (state === 'thinking') {
          workingAt.set(key, Date.now());
          typingAt.delete(key);
        } else if (state === 'typing') typingAt.set(key, Date.now());
        else if (state === 'idle') clear(key);
        else throw new HttpError(400, 'state must be thinking, typing or idle');
        broadcastPresence(key);
        return json(res, 200, { status: 'ok', presence: presenceFor(key) });
      }
    }
  }

  const server = http.createServer((req, res) => {
    lastActive = Date.now();
    if (!allowed(req)) return json(res, 403, { error: 'forbidden' });
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      json(res, err instanceof HttpError ? err.code : 500, { error: err.message });
    });
  });

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(sweep);
    clearInterval(ping);
    for (const entry of [...parked]) entry.finish({ status: 'waiting', note: 'server stopping, run await again' });
    for (const p of procs.values()) p.stop();
    for (const set of streams.values()) for (const res of set) res.end();
    for (const res of allStreams) res.end();
    for (const res of tailStreams) res.end();
    streams.clear();
    allStreams.clear();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    onStop();
  }

  return {
    server,
    presenceFor,
    stop,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
  };
}
