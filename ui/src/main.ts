// Entry of the live viewer (dev.html). The dev server reads the specs root (.specs/), the runs and the
// docs folder on the host (src/serve-specs.ts), so every device on the network sees the same data.
// Reload fetches again; a change under any of them on the host refreshes by itself. While runs exist
// they are fetched again every 15s too: ahead/behind and dirty change without a file event in .specs. The chat panel (src/chat.ts) talks to the
// project's Claude Code session through the same dev server.
import { mountApp } from './app';
import { mountChat } from './chat';
import { buildDocs } from './docs';
import { esc } from './markdown';
import { buildModel } from './model';
import { parseRoute } from './route';
import { parseRuns, type Run } from './runs';
import { askPrompt, contextOf, type AskKind } from './views/chat';

let model = buildModel({});
let specs: Record<string, string> = {};
let runs: Run[] = [];
const RUNS_POLL_MS = 15000;
let poll: ReturnType<typeof setInterval> | null = null;
const context = () => contextOf(model, parseRoute(location.hash));

const app = mountApp(document.body, model, {
  canPromote: true,
  canChat: true,
  onAction: (a, el) => {
    if (a === 'reload') void refresh();
    else if (a === 'promote' && el.dataset.domain) void promote(el.dataset.domain);
    else if (a === 'ask') {
      const ctx = context();
      if (ctx) chat.ask(askPrompt(el.dataset.ask as AskKind, ctx));
    }
  },
});
const chat = mountChat(document.body, { context });
window.addEventListener('hashchange', () => chat.refreshContext());

async function get(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// runs are extra: without them the specs still show
const getRuns = () => get('/__runs').then(parseRuns, () => [] as Run[]);

function show() {
  model = buildModel(specs, runs);
  app.setModel(model);
  // poll only while something runs
  if (runs.length && !poll) poll = setInterval(() => void refreshRuns(), RUNS_POLL_MS);
  else if (!runs.length && poll) {
    clearInterval(poll);
    poll = null;
  }
}

async function refresh() {
  try {
    const [s, docs, r] = await Promise.all([get('/__specs'), get('/__docs'), getRuns()]);
    specs = s;
    runs = r;
    show();
    app.setDocs(buildDocs(docs));
    app.setSource('live');
    app.setNotice(null);
  } catch (e) {
    app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
}

async function refreshRuns() {
  runs = await getRuns();
  show();
}

// Manual promote: the host runs `nos create-plan --hollow`, then the idea shows under Domains
async function promote(folder: string) {
  if (!confirm(`Promote ${folder}? This creates an empty plan.json, so the idea moves to Domains.`)) return;
  try {
    const res = await fetch(`/__promote?domain=${encodeURIComponent(folder)}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    await refresh();
    location.hash = `#domains/${encodeURIComponent(folder.replace(/^domain-\d+-/, ''))}`;
  } catch (e) {
    app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
}

void refresh();
import.meta.hot?.on('specs:changed', () => void refresh());
import.meta.hot?.on('runs:changed', () => void refreshRuns());
import.meta.hot?.on('docs:changed', () => void refresh());
// a device asks to pair, or was allowed / revoked (src/access.ts)
import.meta.hot?.on('chat:devices', () => chat.refreshDevices());
