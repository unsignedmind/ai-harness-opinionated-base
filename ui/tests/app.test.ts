import { test, expect, beforeEach, afterEach } from 'vitest';

import { mountApp, type App, type AppOptions } from '../src/app';
import { buildDocs } from '../src/docs';
import { buildModel } from '../src/model';
import { fixtureFiles } from './fixtures';

const shell = (files = fixtureFiles(), opts: AppOptions = {}) => {
  document.body.innerHTML = `
    <nav id="nav"><a data-view="ideas" href="#ideas">Ideas</a><a data-view="domains" href="#domains">Explore</a><a data-view="board" href="#board">Board</a><a data-view="backlog" href="#backlog">Backlog</a><a data-view="docs" href="#docs">Docs</a></nav>
    <span id="status"></span>
    <span id="source"></span>
    <button id="pick" data-action="pick">Open folder</button>
    <button id="reload" data-action="reload" hidden>Reload</button>
    <main id="main"></main>`;
  app = mountApp(document.body, buildModel(files), opts);
  return app;
};
let app: App | null = null;
const main = () => document.getElementById('main')!;
const go = (app: App, hash: string) => {
  window.location.hash = hash;
  app.render();
};

beforeEach(() => {
  history.replaceState(null, '', '#');
  history.replaceState(null, '', location.pathname);
});
afterEach(() => {
  app?.destroy();
  app = null;
});

test('renders explore by default and marks the nav tab active', () => {
  shell();
  expect(main().querySelector('.explore')).not.toBeNull();
  expect(document.querySelector('#nav a[data-view="domains"]')?.classList.contains('active')).toBe(true);
  expect(document.getElementById('status')?.textContent).toBe('2 ideas · 3 steps');
});

test('clicking an idea card navigates into the idea', () => {
  const app = shell();
  main().querySelector<HTMLElement>('.detail .card[data-href="#domains/dark-mode"]')!.click();
  expect(window.location.hash).toBe('#domains/dark-mode');
  app.render();
  expect(main().querySelector('.detail h1')?.textContent).toContain('Dark mode');
});

test('clicking a subtab switches it and keeps it on re-render', () => {
  const app = shell();
  go(app, '#domains/dark-mode');
  main().querySelector<HTMLElement>('.subtabs button[data-tab="Steps"]')!.click();
  expect(main().querySelectorAll('.subtab-body .kcard')).toHaveLength(3);
  app.render();
  expect(main().querySelector('.subtabs button.active')?.textContent).toBe('Steps');
});

test('clicking a twisty expands the node without navigating', () => {
  shell();
  main().querySelector<HTMLElement>('.node[data-toggle="dark-mode"] .tw')!.click();
  expect(window.location.hash).toBe('');
  expect(main().querySelector('.node[data-href="#domains/dark-mode/tokens"]')).not.toBeNull();
});

test('board: typing in search updates the hash query and keeps focus', () => {
  const app = shell();
  go(app, '#board');
  const q = main().querySelector<HTMLInputElement>('#q')!;
  q.focus();
  q.value = 'media';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  expect(window.location.hash).toBe('#board?q=media');
  app.render();
  expect(main().querySelectorAll('.kcard')).toHaveLength(1);
  expect(document.activeElement?.id).toBe('q');
});

test('board: label box lists labels on focus, typing narrows, keyboard pick adds a badge and refocuses', () => {
  const app = shell();
  go(app, '#board');
  const type = (v: string) => {
    const lq = main().querySelector<HTMLInputElement>('#lq')!;
    lq.focus();
    lq.value = v;
    lq.dispatchEvent(new Event('input', { bubbles: true }));
    return lq;
  };
  const list = () => main().querySelector<HTMLElement>('#lsug')!;
  main().querySelector<HTMLInputElement>('#lq')!.focus();
  expect(list().hidden).toBe(false);
  expect(list().querySelectorAll('[role="option"]')).toHaveLength(2);
  const lq = type('cs');
  expect(list().querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(list().hidden).toBe(false);
  expect(lq.getAttribute('aria-expanded')).toBe('true');
  lq.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(lq.getAttribute('aria-activedescendant')).toBe('lsug-0');
  lq.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(window.location.hash).toBe('#board?labels=css');
  app.render();
  expect(main().querySelector('a.chip.badge[data-value="css"]')).not.toBeNull();
  expect(document.activeElement?.id).toBe('lq');
  expect(main().querySelector<HTMLInputElement>('#lq')!.value).toBe('');
  expect(list().hidden).toBe(false);
});

test('backlog: domain box picks a domain by title with Enter on the sole match', () => {
  const app = shell();
  go(app, '#backlog');
  const dq = main().querySelector<HTMLInputElement>('#dq')!;
  dq.focus();
  dq.value = 'dark';
  dq.dispatchEvent(new Event('input', { bubbles: true }));
  expect(main().querySelector<HTMLElement>('#dsug')!.hidden).toBe(false);
  dq.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(window.location.hash).toBe('#backlog?domain=dark-mode');
  app.render();
  expect(main().querySelector('a.chip.badge[data-kind="ideas"]')?.textContent).toContain('Dark mode theme');
  expect(document.activeElement?.id).toBe('dq');
});

test('board: Escape clears the label box and closes the suggestions', () => {
  const app = shell();
  go(app, '#board');
  const lq = main().querySelector<HTMLInputElement>('#lq')!;
  lq.value = 'css';
  lq.dispatchEvent(new Event('input', { bubbles: true }));
  lq.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(lq.value).toBe('');
  expect(main().querySelector<HTMLElement>('#lsug')!.hidden).toBe(true);
  lq.click();
  expect(main().querySelector<HTMLElement>('#lsug')!.hidden).toBe(false);
});

test('nav links to board and backlog carry the current filters', () => {
  const app = shell();
  go(app, '#board?labels=ui');
  expect(document.querySelector('#nav a[data-view="backlog"]')?.getAttribute('href')).toBe('#backlog?labels=ui');
  expect(document.querySelector('#nav a[data-view="board"]')?.classList.contains('active')).toBe(true);
});

test('backlog: clicking a row opens the step', () => {
  const app = shell();
  go(app, '#backlog');
  main().querySelector<HTMLElement>('tbody tr[data-href]')!.click();
  expect(window.location.hash).toBe('#domains/dark-mode/tokens/extract-tokens');
});

test('setModel re-renders with new data', () => {
  const app = shell();
  const files = fixtureFiles();
  delete files['domain-1-i18n/idea.md'];
  app.setModel(buildModel(files));
  expect(main().querySelectorAll('.detail .card[data-href]')).toHaveLength(1);
});

test('status line and overview count in singular for one', () => {
  const files = fixtureFiles();
  delete files['domain-1-i18n/idea.md'];
  shell().setModel(buildModel(files));
  expect(document.getElementById('status')?.textContent).toBe('1 idea · 3 steps');
  expect(main().querySelector('.detail > p.muted')?.textContent).toBe('1 domain · 2 phases · 3 steps');
});

// ── opening a folder (standalone viewer) ──

test('without specs the overview offers to open the specs folder', () => {
  shell({}, { canPick: true });
  const btn = main().querySelector<HTMLButtonElement>('.empty button[data-action="pick"]');
  expect(btn?.textContent).toBe('Open the project folder');
});

test('without the File System Access API the empty state says which browsers work', () => {
  shell({}, { canPick: false });
  expect(main().querySelector('.empty [data-action="pick"]')).toBeNull();
  expect(main().querySelector('.empty')?.textContent).toContain('Chrome or Edge');
});

test('clicks on data-action elements reach onAction', () => {
  const seen: string[] = [];
  shell({}, { canPick: true, onAction: (a) => seen.push(a) });
  main().querySelector<HTMLElement>('[data-action="pick"]')!.click();
  document.getElementById('reload')!.click();
  expect(seen).toStrictEqual(['pick', 'reload']);
});

test('Manual promote reaches onAction with the domain folder', () => {
  const seen: [string, string | undefined][] = [];
  const app = shell(fixtureFiles(), { canPromote: true, onAction: (a, el) => seen.push([a, el.dataset.domain]) });
  go(app, '#ideas/i18n');
  main().querySelector<HTMLElement>('[data-action="promote"]')!.click();
  expect(seen).toStrictEqual([['promote', 'domain-1-i18n']]);
});

test('setNotice shows a message above the view, null removes it', () => {
  const a = shell();
  a.setNotice('<button data-action="regrant">Reopen specs/</button>');
  expect(main().querySelector('.notice button')?.textContent).toBe('Reopen specs/');
  expect(main().querySelector('.explore')).not.toBeNull();
  a.setNotice(null);
  expect(main().querySelector('.notice')).toBeNull();
});

test('setSource names the open folder and reveals reload', () => {
  const a = shell();
  a.setSource('specs/');
  expect(document.getElementById('source')?.textContent).toBe('specs/');
  expect(document.getElementById('reload')?.hidden).toBe(false);
});

test('with no ideas there is no empty tree panel', () => {
  shell({}, { canPick: true });
  expect(main().querySelector('.tree')).toBeNull();
  expect(main().querySelector('.explore.solo')).not.toBeNull();
});

test('docs view renders the loaded docs, its nav link keeps no filters', () => {
  const app = shell();
  go(app, '#board?labels=ui');
  app.setDocs(
    buildDocs({
      folder: 'docs',
      files: { 'guide/a.md': '# A guide', 'notes/b.md': '# B' },
    }),
  );
  go(app, '#docs/guide');
  const nav = (v: string) => document.querySelector<HTMLAnchorElement>(`#nav a[data-view="${v}"]`)!;
  expect(nav('docs').classList.contains('active')).toBe(true);
  expect(nav('docs').getAttribute('href')).toBe('#docs');
  expect(nav('board').getAttribute('href')).toBe('#board?labels=ui');
  expect(main().querySelector('.detail .card h3')?.textContent).toBe('A guide');
  expect(main().querySelector('.node[data-href="#docs/guide/a.md"]')).not.toBeNull();
  main().querySelector<HTMLElement>('.node[data-toggle="docs:notes"] .tw')!.click();
  expect(window.location.hash).toBe('#docs/guide');
  expect(main().querySelector('.node[data-href="#docs/notes/b.md"]')).not.toBeNull();
});
