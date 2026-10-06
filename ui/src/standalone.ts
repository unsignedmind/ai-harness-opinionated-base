// Entry of the standalone viewer (.claude/skills/nos/ui/index.html, opened straight from disk). Built into
// bundle/viewer.js as a classic script, because file:// pages cannot load ES modules. Data comes
// from a folder the user picks: the specs folder (by default <project>.specs next to the project, which a
// picked project folder cannot reach), or a project folder whose specs root lies inside it, docs included
// (src/folder.ts locateSpecs). The handle is remembered so a revisit is one click.
import { mountApp } from './app';
import { buildDocs } from './docs';
import { locateSpecs, readDocs, readSpecsFolder, type DirLike } from './folder';
import { loadHandle, saveHandle } from './handle-store';
import { esc } from './markdown';
import { buildModel } from './model';

type Picker = (o: { mode: 'read'; id: string }) => Promise<FileSystemDirectoryHandle>;
type Permissioned = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' }): Promise<PermissionState>;
};

const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
let current: Permissioned | null = null;
let remembered: Permissioned | null = null;

const app = mountApp(document.body, buildModel({}), {
  canPick: !!picker,
  onAction: (a) => {
    if (a === 'pick') void pick();
    else if (a === 'reload' && current) void open(current);
    else if (a === 'regrant') void regrant();
  },
});

async function open(h: Permissioned) {
  try {
    const dir = h as unknown as DirLike;
    const files = await readSpecsFolder(dir);
    const { specs, root, rel } = await locateSpecs(dir);
    const docs = await readDocs(specs, root);
    current = h;
    app.setModel(buildModel(files, [], rel));
    app.setDocs(buildDocs(docs));
    app.setSource(`${h.name}/`);
    app.setNotice(null);
    await saveHandle(h);
  } catch (e) {
    app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
}

async function pick() {
  if (!picker) return;
  try {
    await open((await picker({ mode: 'read', id: 'specs-ui' })) as Permissioned);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
}

// reading again needs a user gesture after a browser restart
async function regrant() {
  if (!remembered) return;
  try {
    if ((await remembered.requestPermission({ mode: 'read' })) === 'granted') await open(remembered);
    else app.setNotice('<p class="error">Read access was not granted.</p>');
  } catch (e) {
    app.setNotice(`<p class="error">${esc((e as Error).message)}</p>`);
  }
}

void (async () => {
  remembered = (await loadHandle()) as Permissioned | null;
  if (!remembered) return;
  if ((await remembered.queryPermission({ mode: 'read' })) === 'granted') return open(remembered);
  app.setNotice(
    `Last time you opened <code>${esc(remembered.name)}/</code>. <button type="button" class="primary" data-action="regrant">Reopen ${esc(remembered.name)}/</button>`,
  );
})();
