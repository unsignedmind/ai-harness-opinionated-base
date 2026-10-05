// Chat panel of the live viewer: talks to Claude Code in the project through the dev server
// (src/chat-proxy.ts). Each tab is one chat session; by default the chat server answers every tab
// with its own headless Claude Code session (runner), else a terminal session answers (relay).
// One <dialog>, opened from #chat-toggle in the header:
//   desktop: non-modal drawer on the right, resizable, the views stay usable next to it
//   phone/tablet (MOBILE): modal, full size; the back gesture closes it (history entry)
// The project-wide event stream stays open while the panel is closed, for the presence dot and the
// unread badges.
import {
  CHAT_SHELL,
  PRESENCE_LABEL,
  renderAgents,
  renderLog,
  renderTabs,
  runningAgents,
  withContext,
  type ChatContext,
  type ChatEntry,
  type ChatTab,
  type Presence,
  renderDevices,
  renderPending,
  type PairedDevice,
  type PairLink,
} from './views/chat';
import qrcode from 'qrcode-generator';

export const MOBILE = '(max-width: 860px)';
const COARSE = '(pointer: coarse)';
const KEY_OPEN = 'nos-chat-open';
const KEY_WIDTH = 'nos-chat-width';
const KEY_TAB = 'nos-chat-tab';
const KEY_AGENTS = 'nos-chat-agents';

export type ChatDeps = {
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
  matchMedia?: (q: string) => MediaQueryList;
  storage?: Storage | null;
  // the spec the user looks at, sent along with a message unless dropped
  context?: () => ChatContext | null;
  confirm?: (msg: string) => boolean;
};

export type Chat = {
  open: () => void;
  close: () => void;
  // open with a prepared message (not sent)
  ask: (text: string) => void;
  // route changed: show the new context chip
  refreshContext: () => void;
  readonly presence: Presence;
  readonly isOpen: boolean;
  readonly active: string | null;
  // devices changed on the dev server (pairing request, approval, revoke): this machine reloads them
  refreshDevices: () => void;
  destroy: () => void;
};

function store(storage: Storage | null | undefined) {
  return {
    get(k: string) {
      try {
        return storage?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set(k: string, v: string) {
      try {
        storage?.setItem(k, v);
      } catch {
        // storage blocked: fine
      }
    },
  };
}

type State = { key: string; server: boolean; runner: boolean; tabs: ChatTab[]; local?: boolean };

export function mountChat(root: HTMLElement, deps: ChatDeps = {}): Chat {
  const f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const ES = deps.EventSource ?? EventSource;
  const mm = deps.matchMedia ?? ((q: string) => matchMedia(q));
  const ls = store(deps.storage === undefined ? safeLocalStorage() : deps.storage);
  const ask = deps.confirm ?? ((m: string) => confirm(m));

  const toggle = root.querySelector<HTMLButtonElement>('#chat-toggle');
  const dialog = document.createElement('dialog');
  dialog.id = 'chat';
  dialog.className = 'chat';
  dialog.setAttribute('aria-label', 'Chat with Claude');
  dialog.innerHTML = CHAT_SHELL;
  root.append(dialog);
  const $ = <T extends HTMLElement>(sel: string) => dialog.querySelector<T>(sel)!;
  const log = $('.chat-log');
  const tabBar = $('.chat-tabs');
  const tabRow = $('.chat-tabs-row');
  const agentsBtn = $<HTMLButtonElement>('[data-chat="agents"]');
  const agentsBox = $('.chat-agents');
  agentsBox.hidden = ls.get(KEY_AGENTS) !== '1';
  const activityLine = $('.chat-activity');
  const text = $<HTMLTextAreaElement>('textarea');
  const line = $('.chat-line');
  const notice = $('.chat-notice');
  const chip = $('.chat-context');
  const stopBtn = $<HTMLButtonElement>('[data-chat="stop"]');
  const renameBtn = $<HTMLButtonElement>('[data-chat="rename"]');
  const devicesBtn = $<HTMLButtonElement>('[data-chat="devices"]');
  const devicesBox = $('.chat-devices');
  // pairing requests show on the page even with the chat closed (this machine only)
  const toast = document.createElement('div');
  toast.className = 'pair-toast';
  toast.setAttribute('role', 'alert');
  toast.hidden = true;
  root.append(toast);
  const renameRow = $<HTMLFormElement>('.chat-rename-row');
  const renameInput = $<HTMLInputElement>('.chat-rename');
  const form = $<HTMLFormElement>('.chat-composer');

  let tabs: ChatTab[] = [];
  const chats: Record<string, ChatEntry[]> = {};
  const unread: Record<string, number> = {};
  let active: string | null = ls.get(KEY_TAB);
  let defaultKey: string | null = null;
  // device-level state: not paired, server unreachable, no chat yet
  let status: Presence | null = 'off';
  let es: EventSource | null = null;
  let isOpen = false;
  let modal = false;
  let pushed = false;
  let sending = false;
  let ctx: ChatContext | null = null;
  let useContext = true;
  let destroyed = false;
  // the first look at the server is done (tabs known)
  let synced = false;
  // this machine (not a paired device): may pair, allow and revoke devices
  let local = false;
  let devices: PairedDevice[] = [];
  let link: PairLink | null = null;
  // when the link was made: a device asking after that has used it
  let linkAt = 0;

  const width = Number(ls.get(KEY_WIDTH));
  if (width >= 320) root.style.setProperty('--chat-w', `${width}px`);

  const tabOf = (key: string | null) => tabs.find((t) => t.key === key) ?? null;
  const current = () => tabOf(active);
  const presenceNow = (): Presence => status ?? current()?.presence ?? 'off';
  // header dot: busy if any tab works, else the active tab
  const headerPresence = (): Presence => status ?? (tabs.some((t) => t.running) ? 'thinking' : presenceNow());

  function pickActive() {
    if (tabOf(active)) return;
    active = tabOf(defaultKey)?.key ?? tabs[0]?.key ?? null;
    if (active) ls.set(KEY_TAB, active);
  }

  function draw() {
    const p = presenceNow();
    const tab = current();
    renderLog(log, (active && chats[active]) || [], p);
    tabBar.innerHTML = renderTabs(tabs, active, unread);
    tabRow.hidden = status === 'unpaired' || (!tabs.length && status !== null);
    drawAgents();
    const pill = $('.chat-presence');
    pill.dataset.presence = p;
    pill.querySelector('.lbl')!.textContent = PRESENCE_LABEL[p];
    stopBtn.hidden = !tab?.running;
    renameBtn.hidden = !tab || status !== null;
    devicesBtn.hidden = !local;
    if (!local) devicesBox.hidden = true;
    // the requests show in the toast, unless the devices panel already shows them
    const asks = local && !(isOpen && !devicesBox.hidden) ? renderPending(devices) : '';
    toast.innerHTML = asks;
    toast.hidden = !asks;
    if (!tab && !renameRow.hidden) renameRow.hidden = true;
    activityLine.hidden = !tab?.running || !tab.activity;
    activityLine.textContent = tab?.activity ? `⚙ ${tab.activity}` : '';
    text.disabled = status === 'unpaired';
    if (toggle) {
      const hp = headerPresence();
      const total = Object.entries(unread).reduce((n, [k, v]) => (isOpen && k === active ? n : n + v), 0);
      toggle.hidden = false;
      toggle.dataset.presence = hp;
      toggle.title = `Chat with Claude — ${PRESENCE_LABEL[hp]}`;
      toggle.setAttribute('aria-expanded', String(isOpen));
      const badge = toggle.querySelector<HTMLElement>('.badge');
      if (badge) {
        badge.hidden = total === 0;
        badge.textContent = String(total);
      }
    }
  }

  // chevron at the end of the tab bar: number of running subagents, the list when expanded
  function drawAgents() {
    const n = runningAgents(current());
    const badge = agentsBtn.querySelector<HTMLElement>('.badge')!;
    badge.hidden = n === 0;
    badge.textContent = String(n);
    agentsBtn.dataset.running = String(n > 0);
    agentsBtn.title = n ? `Subagents: ${n} running` : 'Subagents';
    agentsBtn.setAttribute('aria-expanded', String(!agentsBox.hidden));
    if (!agentsBox.hidden) agentsBox.innerHTML = renderAgents(current());
  }

  function setNotice(html: string | null) {
    notice.hidden = !html;
    notice.innerHTML = html ?? '';
  }

  function setTabs(next: ChatTab[]) {
    tabs = next;
    pickActive();
    if (tabs.length) status = null;
    else if (status === null) status = 'off';
    draw();
  }

  function connect() {
    if (es) return;
    es = new ES('/__chat/events');
    const data = <T>(e: Event) => JSON.parse((e as MessageEvent).data) as T;
    es.addEventListener('sessions', (e) => {
      status = null;
      setNotice(null);
      setTabs(data<{ sessions: ChatTab[] }>(e).sessions);
    });
    es.addEventListener('chat-sync', (e) => {
      const { key, chat } = data<{ key: string; chat: ChatEntry[] }>(e);
      const before = chats[key];
      if (before && (!isOpen || key !== active))
        unread[key] = (unread[key] ?? 0) + chat.slice(before.length).filter((m) => m.role === 'agent').length;
      chats[key] = chat;
      draw();
    });
    es.addEventListener('presence', (e) => {
      const { key, state } = data<{ key: string; state: Presence }>(e);
      const t = tabOf(key);
      if (t) t.presence = state;
      draw();
    });
    es.addEventListener('agents', (e) => {
      const { key, agents } = data<{ key: string; agents: ChatTab['agents'] }>(e);
      const t = tabOf(key);
      if (t) t.agents = agents;
      draw();
    });
    es.addEventListener('activity', (e) => {
      const { key, text: a } = data<{ key: string; text: string }>(e);
      const t = tabOf(key);
      if (t) t.activity = a;
      draw();
    });
    es.onerror = () => {
      status = 'offline';
      draw();
    };
  }

  async function sync() {
    try {
      const r = await f('/__chat/state');
      if (r.status === 401) {
        status = 'unpaired';
        setNotice(
          'This device is not paired. Open the pairing link printed by <code>npm run dev-to-lan</code> (or <code>nos chat pair</code>) on the host.',
        );
        return draw();
      }
      if (!r.ok) throw new Error();
      const s = (await r.json()) as State;
      if (s.local && !local) {
        local = true;
        void refreshDevices();
      }
      defaultKey = s.key;
      if (s.server) {
        connect();
        setTabs(s.tabs);
      } else {
        status = 'off';
        draw();
      }
    } catch {
      status = 'offline';
      draw();
    }
  }

  // connected to a chat server that answers (not offline, not an older one)
  const live = () => !!es && status === null;

  // a fresh tab on the running server: its own chat, its own Claude Code session
  async function createTab(): Promise<string> {
    const r = await f('/__chat/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const out = (await r.json()) as { key?: string; error?: string };
    if (!r.ok || !out.key) throw new Error(out.error);
    return out.key;
  }

  // starts the chat server when needed (nos chat open) and opens a tab: the project's first one,
  // or a fresh one when that was closed (a closed chat is never revived)
  let starting$: Promise<boolean> | null = null;
  // one start at a time: a send during the auto-start waits for it
  function start(): Promise<boolean> {
    starting$ ??= doStart().finally(() => (starting$ = null));
    return starting$;
  }

  async function doStart(): Promise<boolean> {
    try {
      const r = await f('/__chat/open', { method: 'POST' });
      const out = (await r.json()) as { status?: string; key?: string; error?: string };
      let key: string;
      if (out.status === 'user-ended') key = await createTab();
      else if (r.ok && out.status === 'open' && out.key) key = out.key;
      else throw new Error(out.error);
      status = null;
      if (!tabOf(key)) tabs = [...tabs, emptyTab(key)];
      setNotice(null);
      // the server may be new (restarted, other port): a fresh stream
      es?.close();
      es = null;
      connect();
      selectTab(key);
      return true;
    } catch (e) {
      line.textContent = `Could not start the chat${(e as Error).message ? `: ${(e as Error).message}` : ''}.`;
      return false;
    }
  }

  async function newTab() {
    if (status === 'unpaired') return;
    // nothing open yet: the first tab is the new one
    if (!live()) {
      if (await start()) text.focus();
      return;
    }
    try {
      const key = await createTab();
      if (!tabOf(key)) tabs = [...tabs, emptyTab(key)];
      selectTab(key);
      text.focus();
    } catch {
      line.textContent = 'Could not open a new chat.';
    }
  }

  function selectTab(key: string) {
    if (renaming) endRename(false);
    active = key;
    unread[key] = 0;
    ls.set(KEY_TAB, key);
    line.textContent = '';
    draw();
    log.scrollTop = log.scrollHeight;
  }

  const post = (path: string, body?: unknown, key = active) =>
    f(`/__chat/${path}?key=${encodeURIComponent(key ?? '')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  async function send() {
    const t = text.value;
    if (sending || !t.trim() || status === 'unpaired') return;
    sending = true;
    try {
      if ((!live() || !active) && !(await start())) return;
      const body = { text: withContext(t, useContext ? ctx : null) };
      let r = await post('messages', body);
      if ((r.status === 503 || r.status === 409 || r.status === 404) && (await start()))
        r = await post('messages', body);
      if (!r.ok) throw new Error();
      const j = (await r.json()) as { presence: Presence };
      text.value = '';
      const tab = current();
      if (tab) tab.presence = j.presence;
      line.textContent =
        j.presence === 'thinking' || j.presence === 'typing'
          ? 'Delivered. Claude is on it.'
          : 'Queued. Claude picks this up when it next listens.';
      draw();
    } catch {
      line.textContent = 'Send failed. Is the dev server running?';
    } finally {
      sending = false;
    }
  }

  // rename the active tab in a full-width row under the tabs (big enough for a phone)
  let renaming: string | null = null;
  function startRename() {
    const tab = current();
    if (!tab) return;
    renaming = tab.key;
    renameInput.value = tab.title;
    renameRow.hidden = false;
    renameInput.focus();
    renameInput.select();
  }

  function endRename(save: boolean) {
    const tab = tabOf(renaming);
    const title = renameInput.value.trim().slice(0, 60);
    renaming = null;
    renameRow.hidden = true;
    if (save && tab && title && title !== tab.title) {
      tab.title = title;
      void post('title', { title }, tab.key);
    }
    draw();
  }

  function closeTab(key: string) {
    const tab = tabOf(key);
    if (!tab) return;
    const busy = tab.running ? ' Claude stops working on it.' : '';
    if ((tab.running || chats[key]?.length) && !ask(`Close "${tab.title}"?${busy}`)) return;
    if (renaming === key) endRename(false);
    tabs = tabs.filter((t) => t.key !== key);
    if (active === key) active = null;
    pickActive();
    draw();
    void post('end', {}, key);
  }

  function setDialog(open: boolean, asModal: boolean) {
    try {
      if (!open) dialog.close();
      else if (asModal) dialog.showModal();
      else dialog.show();
    } catch {
      // no <dialog> support (old browsers, tests): attribute only
      dialog.toggleAttribute('open', open);
    }
    if (!open) dialog.removeAttribute('open');
  }

  function show() {
    modal = mm(MOBILE).matches;
    setDialog(true, modal);
    dialog.classList.toggle('modal', modal);
    if (modal) {
      history.pushState({ nosChat: true }, '');
      pushed = true;
      // the page behind stays put while the keyboard comes and goes
      document.documentElement.classList.add('chat-modal');
      onViewport();
    } else {
      root.classList.add('chat-docked');
      ls.set(KEY_OPEN, '1');
    }
    isOpen = true;
    if (active) unread[active] = 0;
    refreshContext();
    draw();
    log.scrollTop = log.scrollHeight;
    if (!modal) text.focus();
    ensureTab();
  }

  // opening the chat with no tab open starts one (its own Claude Code session)
  function ensureTab() {
    if (!isOpen || !synced || starting$ || tabs.length || status === 'unpaired') return;
    void newTab();
  }

  function hide(remember = true) {
    if (renaming) endRename(false);
    setDialog(false, modal);
    root.classList.remove('chat-docked');
    document.documentElement.classList.remove('chat-modal');
    isOpen = false;
    if (remember && !modal) ls.set(KEY_OPEN, '0');
    draw();
    toggle?.focus();
  }

  function close() {
    if (!isOpen) return;
    if (pushed) {
      // popstate closes it, so the history entry is gone too
      pushed = false;
      history.back();
    } else hide();
  }

  function open() {
    if (!isOpen) show();
  }

  function refreshContext() {
    ctx = deps.context?.() ?? null;
    useContext = true;
    chip.hidden = !ctx;
    if (ctx) {
      chip.querySelector('.lbl')!.textContent = `📎 ${ctx.label}`;
      chip.title = ctx.path;
    }
  }

  async function refreshDevices() {
    if (!local) return;
    try {
      const r = await f('/__chat/devices');
      if (!r.ok) return;
      devices = ((await r.json()) as { devices: PairedDevice[] }).devices;
      // a link works once: hide it as soon as a device asked after it was made
      if (link && devices.some((d) => d.status === 'pending' && d.createdAt >= linkAt)) link = null;
      if (!devicesBox.hidden) devicesBox.innerHTML = renderDevices(devices, link);
      draw();
    } catch {
      // dev server gone: nothing to show
    }
  }

  async function pairDevice() {
    const r = await f('/__chat/devices/pair', { method: 'POST' });
    if (!r.ok) return;
    const out = (await r.json()) as Omit<PairLink, 'qr'>;
    const phone = out.urls.find((u) => !u.virtual) ?? out.urls[0];
    let qr = '';
    if (phone) {
      const q = qrcode(0, 'L');
      q.addData(phone.url);
      q.make();
      qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    }
    link = { ...out, qr };
    linkAt = Date.now();
    devicesBox.hidden = false;
    devicesBox.innerHTML = renderDevices(devices, link);
  }

  async function deviceAction(action: 'approve' | 'deny' | 'revoke', id: string) {
    const d = devices.find((x) => x.id === id);
    if (action === 'revoke' && !ask(`Revoke "${d?.name ?? id}"? It loses access at once.`)) return;
    await f(`/__chat/devices/${action}?id=${encodeURIComponent(id)}`, { method: 'POST' });
    await refreshDevices();
  }

  // the toast lives outside the dialog
  const onToastClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]');
    const a = el?.dataset.chat;
    if ((a === 'dev-approve' || a === 'dev-deny') && el?.dataset.id)
      void deviceAction(a === 'dev-approve' ? 'approve' : 'deny', el.dataset.id);
  };

  // events
  const onToggle = () => (isOpen ? close() : open());
  const onPop = () => {
    if (isOpen && modal) {
      pushed = false;
      hide(false);
    }
  };
  const onCancel = (e: Event) => {
    e.preventDefault();
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target === renameInput && e.key === 'Escape') {
      e.preventDefault();
      endRename(false);
      return;
    }
    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      close();
    } else if (e.target === text && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mm(COARSE).matches) {
      e.preventDefault();
      void send();
    }
  };
  const onSubmit = (e: Event) => {
    e.preventDefault();
    void send();
  };
  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]');
    const a = el?.dataset.chat;
    if (a === 'close') close();
    else if (a === 'tab' && el?.dataset.key) selectTab(el.dataset.key);
    else if (a === 'close-tab' && el?.dataset.key) closeTab(el.dataset.key);
    else if (a === 'rename') startRename();
    else if (a === 'rename-cancel') endRename(false);
    else if (a === 'agents') {
      agentsBox.hidden = !agentsBox.hidden;
      ls.set(KEY_AGENTS, agentsBox.hidden ? '0' : '1');
      drawAgents();
    } else if (a === 'devices') {
      devicesBox.hidden = !devicesBox.hidden;
      draw();
      if (!devicesBox.hidden) void refreshDevices();
    } else if (a === 'dev-pair') void pairDevice();
    else if (a?.startsWith('dev-') && el?.dataset.id)
      void deviceAction(a.slice(4) as 'approve' | 'deny' | 'revoke', el.dataset.id);
    else if (a === 'new') void newTab();
    else if (a === 'stop') void post('stop');
    else if (a === 'drop-context') {
      useContext = false;
      chip.hidden = true;
    }
  };
  const onRename = (e: Event) => {
    e.preventDefault();
    endRename(true);
  };
  // switching between drawer and full-size dialog while open: reopen in the other mode, the
  // draft stays in the same textarea
  const mq = mm(MOBILE);
  const onBreakpoint = () => {
    if (!isOpen) return;
    hide(false);
    pushed = false;
    show();
  };
  // phone keyboard: the visible area shrinks and the browser scrolls it; the full-size dialog
  // follows it (height and top), so the bar and the composer stay in view
  const vv = typeof visualViewport === 'undefined' ? null : visualViewport;
  function onViewport() {
    if (!vv) return;
    dialog.style.setProperty('--chat-vh', `${vv.height}px`);
    dialog.style.setProperty('--chat-top', `${vv.offsetTop}px`);
    if (modal && isOpen) log.scrollTop = log.scrollHeight;
  }
  // drawer width by dragging its left edge
  const onResizeStart = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).closest('[data-chat="resize"]') || modal) return;
    e.preventDefault();
    const move = (m: PointerEvent) => {
      const w = Math.round(Math.min(Math.max(innerWidth - m.clientX, 320), innerWidth * 0.7));
      root.style.setProperty('--chat-w', `${w}px`);
      ls.set(KEY_WIDTH, String(w));
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  toggle?.addEventListener('click', onToggle);
  toast.addEventListener('click', onToastClick);
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('keydown', onKey);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('pointerdown', onResizeStart);
  renameRow.addEventListener('submit', onRename);
  form.addEventListener('submit', onSubmit);
  window.addEventListener('popstate', onPop);
  mq.addEventListener?.('change', onBreakpoint);
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);

  draw();
  void sync().then(() => {
    synced = true;
    if (destroyed) return;
    if (ls.get(KEY_OPEN) === '1' && !mm(MOBILE).matches && !isOpen) show();
    else ensureTab();
  });
  // not connected yet (the server may be started later): look again now and then
  const recheck = setInterval(() => {
    if (!es && !sending && status !== 'unpaired') void sync();
  }, 10000);
  // time taken of the running subagents
  const tick = setInterval(() => {
    if (isOpen && !agentsBox.hidden && runningAgents(current())) drawAgents();
  }, 1000);

  return {
    open,
    close,
    ask(t: string) {
      open();
      text.value = t;
      text.focus();
      text.setSelectionRange(t.length, t.length);
    },
    refreshContext,
    refreshDevices: () => void refreshDevices(),
    get presence() {
      return presenceNow();
    },
    get isOpen() {
      return isOpen;
    },
    get active() {
      return active;
    },
    destroy() {
      destroyed = true;
      clearInterval(recheck);
      clearInterval(tick);
      es?.close();
      toggle?.removeEventListener('click', onToggle);
      window.removeEventListener('popstate', onPop);
      mq.removeEventListener?.('change', onBreakpoint);
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
      document.documentElement.classList.remove('chat-modal');
      root.classList.remove('chat-docked');
      dialog.remove();
      toast.remove();
    },
  };
}

const emptyTab = (key: string): ChatTab => ({
  key,
  title: 'New chat',
  presence: 'ready',
  running: false,
  activity: null,
  claudeSession: null,
  agents: [],
});

function safeLocalStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
