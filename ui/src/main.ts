// Entry of the live viewer (dev.html). The dev server reads specs/ and the docs folder on the host
// (src/serve-specs.ts), so every device on the network sees the same data. Reload fetches again; a
// change under either on the host refreshes by itself. The chat panel (src/chat.ts) talks to the
// project's Claude Code session through the same dev server.
import { mountApp } from './app';
import { mountChat } from './chat';
import { buildDocs } from './docs';
import { esc } from './markdown';
import { buildModel } from './model';
import { parseRoute } from './route';
import { askPrompt, contextOf, type AskKind } from './views/chat';

let model = buildModel({});
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

async function refresh() {
  try {
    const [specs, docs] = await Promise.all([get('/__specs'), get('/__docs')]);
    model = buildModel(specs);
    app.setModel(model);
    app.setDocs(buildDocs(docs));
    app.setSource('live');
    app.setNotice(null);
  } catch (e) {
    app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
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
import.meta.hot?.on('docs:changed', () => void refresh());
