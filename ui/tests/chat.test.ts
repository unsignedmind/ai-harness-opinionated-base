import { afterEach, beforeEach, expect, test } from 'vitest';

import { mountApp } from '../src/app';
import { mountChat, MOBILE, type Chat, type ChatDeps } from '../src/chat';
import { buildModel } from '../src/model';
import { parseRoute } from '../src/route';
import {
  askPrompt,
  contextOf,
  renderLog,
  renderTabs,
  splitContext,
  splitFences,
  withContext,
  type ChatEntry,
  type ChatTab,
} from '../src/views/chat';
import { fixtureFiles } from './fixtures';

const STEP = '#domains/dark-mode/tokens/extract-tokens';

test('splitFences: text and code parts, code keeps its inner lines', () => {
  expect(splitFences('Run:\n```sh\nnpm test\nnpm run lint\n```\nDone.')).toEqual([
    { code: false, text: 'Run:' },
    { code: true, text: 'npm test\nnpm run lint' },
    { code: false, text: 'Done.' },
  ]);
  expect(splitFences('plain')).toEqual([{ code: false, text: 'plain' }]);
});

test('context line round trip', () => {
  const ctx = { label: 'S1 Extract', path: 'specs/x/step-1-a.md' };
  const t = withContext('Is this done?', ctx);
  expect(t).toBe('[context: specs/x/step-1-a.md]\nIs this done?');
  expect(splitContext(t)).toEqual({ context: 'specs/x/step-1-a.md', body: 'Is this done?' });
  expect(withContext('hi', null)).toBe('hi');
});

test('contextOf names the spec of the routed step, phase or domain', () => {
  const model = buildModel(fixtureFiles());
  const step = contextOf(model, parseRoute(STEP));
  expect(step?.path).toBe('specs/domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md');
  expect(step?.label).toMatch(/^S1 /);
  expect(contextOf(model, parseRoute('#domains/dark-mode/tokens'))?.path).toBe(
    'specs/domain-2-dark-mode/phases/phase-1-tokens/',
  );
  expect(contextOf(model, parseRoute('#domains/dark-mode'))?.path).toBe('specs/domain-2-dark-mode/');
  expect(contextOf(model, parseRoute('#board'))).toBeNull();
  expect(askPrompt('specify', step!)).toContain('"specify"');
});

test('renderLog puts message text in as text, never as markup', () => {
  const log = document.createElement('div');
  const chat: ChatEntry[] = [
    { role: 'user', text: '[context: specs/a.md]\n<img src=x onerror=alert(1)>', at: '2026-10-05T10:00:00Z' },
    { role: 'agent', text: 'ok\n```\n<b>code</b>\n```', at: '2026-10-05T10:00:01Z' },
  ];
  renderLog(log, chat, 'thinking');
  expect(log.querySelector('img')).toBeNull();
  expect(log.querySelector('.msg.user .t')!.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(log.querySelector('.msg.user .ctx')!.textContent).toBe('specs/a.md');
  expect(log.querySelector('.msg.agent pre')!.textContent).toBe('<b>code</b>');
  expect(log.querySelector('.chat-dots')).not.toBeNull();
});

test('"Ask Claude" buttons only with canChat', () => {
  document.body.innerHTML = '<main id="main"></main>';
  location.hash = STEP;
  const without = mountApp(document.body, buildModel(fixtureFiles()));
  expect(document.querySelector('[data-action="ask"]')).toBeNull();
  without.destroy();
  const app = mountApp(document.body, buildModel(fixtureFiles()), { canChat: true });
  expect([...document.querySelectorAll<HTMLElement>('[data-action="ask"]')].map((b) => b.dataset.ask)).toEqual([
    'specify',
    'develop',
    'review',
    'discuss',
  ]);
  app.destroy();
});

test('renderTabs escapes titles, marks the active tab, shows unread of the others', () => {
  const tab = (key: string, title: string): ChatTab => ({
    key,
    title,
    presence: 'ready',
    running: false,
    activity: null,
    claudeSession: '3664881e-fbdd-4b6d-942d-14b1ee5ac8be',
  });
  const html = renderTabs([tab('aaaaaaaaaaaa', '<b>x</b>'), tab('bbbbbbbbbbbb', 'Two')], 'aaaaaaaaaaaa', {
    aaaaaaaaaaaa: 3,
    bbbbbbbbbbbb: 2,
  });
  const box = document.createElement('div');
  box.innerHTML = html;
  expect(box.querySelector('b')).toBeNull();
  const [a, b] = box.querySelectorAll<HTMLElement>('[data-chat="tab"]');
  expect(a.closest('[role="tab"]')!.getAttribute('aria-selected')).toBe('true');
  expect(box.querySelectorAll('[data-chat="close-tab"]').length).toBe(2);
  expect(a.querySelector('.badge')).toBeNull();
  expect(b.querySelector('.badge')!.textContent).toBe('2');
  expect(a.title).toContain('claude --resume 3664881e');
  expect(box.querySelector('[data-chat="new"]')).not.toBeNull();
});

// ---- panel ----

class FakeES {
  static last: FakeES | null = null;
  url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeES.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

type Call = { url: string; init?: RequestInit };
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const tabOf = (key: string, extra: Partial<ChatTab> = {}): ChatTab => ({
  key,
  title: key === A ? 'Chat' : 'Second',
  presence: 'ready',
  running: false,
  activity: null,
  claudeSession: null,
  ...extra,
});

function setup(opts: { mobile?: boolean; state?: unknown; status?: number } = {}) {
  document.body.innerHTML = `<header><div class="right"><button id="chat-toggle" hidden><span class="dot"></span>Chat<span class="badge" hidden></span></button></div></header><main id="main"></main>`;
  const calls: Call[] = [];
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  const fetchFake = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/__chat/state')
      return reply(opts.status ?? 200, opts.state ?? { key: A, server: false, runner: true, tabs: [] });
    if (url.startsWith('/__chat/open'))
      return (globalThis as { __ended?: boolean }).__ended
        ? reply(409, { status: 'user-ended', key: A })
        : reply(200, { status: 'open', key: A });
    if (url === '/__chat/new') return reply(200, { status: 'open', key: B });
    if (url.startsWith('/__chat/messages')) return reply(200, { status: 'queued', presence: 'thinking' });
    if (url.startsWith('/__chat/stop') || url.startsWith('/__chat/end')) return reply(200, { status: 'ok' });
    return reply(404, {});
  }) as typeof fetch;
  const mq = (matches: boolean) =>
    ({ matches, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  const deps: ChatDeps = {
    fetch: fetchFake,
    EventSource: FakeES as unknown as typeof EventSource,
    matchMedia: (q) => mq(q === MOBILE ? !!opts.mobile : false),
    storage: null,
    context: () => ({ label: 'S1 Extract', path: 'specs/a/step-1-x.md' }),
    confirm: () => true,
  };
  chat = mountChat(document.body, deps);
  return { calls, toggle: document.getElementById('chat-toggle')!, dialog: document.getElementById('chat')! };
}

let chat: Chat | null = null;
const tick = () => new Promise((r) => setTimeout(r, 0));
const ticks = async (n = 3) => {
  for (let i = 0; i < n; i++) await tick();
};
const submit = (dialog: HTMLElement, value: string) => {
  dialog.querySelector('textarea')!.value = value;
  dialog.querySelector('.chat-composer')!.dispatchEvent(new Event('submit', { cancelable: true }));
};
beforeEach(() => {
  FakeES.last = null;
  history.replaceState(null, '', location.pathname);
});
afterEach(() => {
  chat?.destroy();
  chat = null;
});

test('desktop: the toggle opens a docked drawer; first send starts the chat and carries the context', async () => {
  const { calls, toggle, dialog } = setup();
  await tick();
  expect(toggle.hidden).toBe(false);
  expect(toggle.dataset.presence).toBe('off');
  toggle.click();
  expect(dialog.hasAttribute('open')).toBe(true);
  expect(document.body.classList.contains('chat-docked')).toBe(true);
  expect(dialog.querySelector<HTMLElement>('.chat-context')!.hidden).toBe(false);

  submit(dialog, 'Is this done?');
  await ticks();
  expect(calls.map((c) => c.url)).toEqual(['/__chat/state', '/__chat/open', `/__chat/messages?key=${A}`]);
  expect(FakeES.last?.url).toBe('/__chat/events');
  expect(JSON.parse(String(calls[2].init!.body))).toEqual({ text: '[context: specs/a/step-1-x.md]\nIs this done?' });
  expect(dialog.querySelector('textarea')!.value).toBe('');
  expect(dialog.querySelector('.chat-line')!.textContent).toMatch(/^Delivered/);

  toggle.click();
  expect(dialog.hasAttribute('open')).toBe(false);
  expect(document.body.classList.contains('chat-docked')).toBe(false);
});

test('tabs: the stream fills them, a new tab gets its own key, messages go to the active tab', async () => {
  const { calls, toggle, dialog } = setup({ state: { key: A, server: true, runner: true, tabs: [tabOf(A)] } });
  await tick();
  const es = FakeES.last!;
  es.emit('sessions', { sessions: [tabOf(A)], runner: true });
  es.emit('chat-sync', { key: A, chat: [] });
  toggle.click();
  expect([...dialog.querySelectorAll('[data-chat="tab"]')].map((b) => b.textContent)).toEqual(['Chat']);

  dialog.querySelector<HTMLElement>('[data-chat="new"]')!.click();
  await ticks();
  expect(chat!.active).toBe(B);
  submit(dialog, 'second tab');
  await ticks();
  expect(calls.at(-1)!.url).toBe(`/__chat/messages?key=${B}`);

  // a reply in the background tab counts as unread there
  es.emit('sessions', { sessions: [tabOf(A), tabOf(B)], runner: true });
  es.emit('chat-sync', { key: B, chat: [] });
  es.emit('chat-sync', { key: A, chat: [{ role: 'agent', text: 'done', at: '' }] });
  const tabA = dialog.querySelector<HTMLElement>(`[data-chat="tab"][data-key="${A}"]`)!;
  expect(tabA.querySelector('.badge')!.textContent).toBe('1');
  tabA.click();
  expect(chat!.active).toBe(A);
  expect(dialog.querySelector('.chat-log .msg.agent')!.textContent).toContain('done');
});

test('a running tab shows the activity and a stop button; closing a tab posts end', async () => {
  const { calls, toggle, dialog } = setup({ state: { key: A, server: true, runner: true, tabs: [tabOf(A)] } });
  await tick();
  const es = FakeES.last!;
  toggle.click();
  es.emit('sessions', { sessions: [tabOf(A, { running: true, presence: 'thinking' })], runner: true });
  es.emit('activity', { key: A, text: 'Bash: npm test' });
  expect(toggle.dataset.presence).toBe('thinking');
  const stop = dialog.querySelector<HTMLElement>('[data-chat="stop"]')!;
  expect(stop.hidden).toBe(false);
  expect(dialog.querySelector('.chat-activity')!.textContent).toBe('⚙ Bash: npm test');
  stop.click();
  await tick();
  expect(calls.at(-1)!.url).toBe(`/__chat/stop?key=${A}`);
  es.emit('sessions', { sessions: [tabOf(A)], runner: true });
  expect(dialog.querySelector<HTMLElement>('[data-chat="stop"]')!.hidden).toBe(true);
});

test('every tab has its own close button; closing a background tab keeps the active one', async () => {
  const { calls, toggle, dialog } = setup({ state: { key: A, server: true, runner: true, tabs: [tabOf(A)] } });
  await tick();
  FakeES.last!.emit('sessions', { sessions: [tabOf(A), tabOf(B)], runner: true });
  toggle.click();
  expect(dialog.querySelectorAll('[data-chat="close-tab"]').length).toBe(2);
  dialog.querySelector<HTMLElement>(`[data-chat="close-tab"][data-key="${B}"]`)!.click();
  await tick();
  expect(calls.at(-1)!.url).toBe(`/__chat/end?key=${B}`);
  expect([...dialog.querySelectorAll('[data-chat="tab"]')].map((b) => b.textContent)).toEqual(['Chat']);
  expect(chat!.active).toBe(A);
});

test('rename: the bar button opens a full-width field, Save posts the title, Cancel keeps it', async () => {
  const { calls, toggle, dialog } = setup({ state: { key: A, server: true, runner: true, tabs: [tabOf(A)] } });
  await tick();
  FakeES.last!.emit('sessions', { sessions: [tabOf(A)], runner: true });
  toggle.click();
  const row = dialog.querySelector<HTMLFormElement>('.chat-rename-row')!;
  const input = row.querySelector('input')!;
  expect(row.hidden).toBe(true);
  dialog.querySelector<HTMLElement>('[data-chat="rename"]')!.click();
  expect(row.hidden).toBe(false);
  expect(input.value).toBe('Chat');
  input.value = 'Couch work';
  row.dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
  expect(row.hidden).toBe(true);
  expect(calls.at(-1)!.url).toBe(`/__chat/title?key=${A}`);
  expect(JSON.parse(String(calls.at(-1)!.init!.body))).toEqual({ title: 'Couch work' });
  expect(dialog.querySelector('[data-chat="tab"] .lbl')!.textContent).toBe('Couch work');

  const before = calls.length;
  dialog.querySelector<HTMLElement>('[data-chat="rename"]')!.click();
  input.value = 'nope';
  dialog.querySelector<HTMLElement>('[data-chat="rename-cancel"]')!.click();
  expect(row.hidden).toBe(true);
  expect(calls.length).toBe(before);
  expect(dialog.querySelector('[data-chat="tab"] .lbl')!.textContent).toBe('Couch work');
});

test('opening the chat with no tab starts one; the Send button sends (no native form submit)', async () => {
  const { calls, toggle, dialog } = setup({ mobile: true });
  await tick();
  toggle.click();
  await ticks();
  expect(calls.map((c) => c.url)).toEqual(['/__chat/state', '/__chat/open']);
  expect(chat!.active).toBe(A);
  dialog.querySelector('textarea')!.value = 'from the couch';
  const submitted = new Promise<boolean>((done) =>
    dialog.querySelector('.chat-composer')!.addEventListener('submit', (e) => done(e.defaultPrevented)),
  );
  dialog.querySelector<HTMLButtonElement>('.chat-composer button[type="submit"]')!.click();
  expect(await submitted).toBe(true);
  await ticks();
  expect(calls.at(-1)!.url).toBe(`/__chat/messages?key=${A}`);
  expect(dialog.hasAttribute('open')).toBe(true);
});

test('mobile: full-size dialog with a history entry, the back gesture closes it', async () => {
  const { toggle, dialog } = setup({ mobile: true });
  await tick();
  const before = history.length;
  toggle.click();
  expect(dialog.hasAttribute('open')).toBe(true);
  expect(dialog.classList.contains('modal')).toBe(true);
  expect(document.body.classList.contains('chat-docked')).toBe(false);
  expect(history.length).toBe(before + 1);
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(dialog.hasAttribute('open')).toBe(false);
});

test('ask opens the panel with a prepared message, not sent', async () => {
  const { calls, dialog } = setup();
  await tick();
  chat!.ask('Run the nos "specify" ability for S1.');
  expect(dialog.hasAttribute('open')).toBe(true);
  expect(dialog.querySelector('textarea')!.value).toBe('Run the nos "specify" ability for S1.');
  expect(calls.some((c) => c.url.startsWith('/__chat/messages'))).toBe(false);
});

test('an unpaired device sees the pairing hint and cannot type', async () => {
  const { toggle, dialog } = setup({ status: 401, state: { error: 'unpaired' } });
  await ticks(2);
  expect(toggle.dataset.presence).toBe('unpaired');
  expect(dialog.querySelector<HTMLElement>('.chat-notice')!.hidden).toBe(false);
  expect(dialog.querySelector('textarea')!.disabled).toBe(true);
});

test('a closed chat is never revived: opening after the last tab was closed starts a fresh one', async () => {
  // the server reports the project's first chat as closed by the user
  (globalThis as { __ended?: boolean }).__ended = true;
  const { calls, toggle } = setup();
  await tick();
  toggle.click();
  await ticks(4);
  expect(calls.map((c) => c.url)).toEqual(['/__chat/state', '/__chat/open', '/__chat/new']);
  expect(chat!.active).toBe(B);
  delete (globalThis as { __ended?: boolean }).__ended;
});
