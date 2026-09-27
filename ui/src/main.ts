// Entry of the live viewer (dev.html). The dev server reads specs/ on the host (src/serve-specs.ts),
// so every device on the network sees the same data. Reload fetches again; a change under specs/
// on the host refreshes by itself.
import { mountApp } from "./app";
import { esc } from "./markdown";
import { buildModel } from "./model";

const app = mountApp(document.body, buildModel({}), {
  onAction: (a) => {
    if (a === "reload") void refresh();
  },
});

async function refresh() {
  try {
    const res = await fetch("/__specs");
    if (!res.ok) throw new Error(await res.text());
    app.setModel(buildModel(await res.json()));
    app.setSource("live");
    app.setNotice(null);
  } catch (e) {
    app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
}

void refresh();
import.meta.hot?.on("specs:changed", () => void refresh());
