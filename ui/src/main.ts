// Entry of the live viewer (dev.html). The dev server reads specs/ and the docs folder on the host
// (src/serve-specs.ts), so every device on the network sees the same data. Reload fetches again; a
// change under either on the host refreshes by itself.
import { mountApp } from './app';
import { buildDocs } from './docs';
import { esc } from './markdown';
import { buildModel } from './model';

const app = mountApp(document.body, buildModel({}), {
  onAction: (a) => {
    if (a === 'reload') void refresh();
  },
});

async function get(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refresh() {
  try {
    const [specs, docs] = await Promise.all([get('/__specs'), get('/__docs')]);
    app.setModel(buildModel(specs));
    app.setDocs(buildDocs(docs));
    app.setSource('live');
    app.setNotice(null);
  } catch (e) {
    app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
}

void refresh();
import.meta.hot?.on('specs:changed', () => void refresh());
import.meta.hot?.on('docs:changed', () => void refresh());
