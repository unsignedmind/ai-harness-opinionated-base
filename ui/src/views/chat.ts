// Chat with Claude Code in the project: presence labels, the context a message carries (the spec
// the user looks at), the "Ask Claude" prompts, the panel markup, the tab bar and the message log.
// Message text only ever reaches the page through textContent.
import { esc } from '../markdown';
import type { Model } from '../model';
import { QUICK_SEGMENT, type Route } from '../route';
import { itemId } from './parts';

export type Presence =
  | 'ended'
  | 'typing'
  | 'thinking'
  | 'listening'
  | 'queued'
  | 'waiting'
  // the chat server runs its own Claude Code session for the tab and is idle
  | 'ready'
  // spec-ui only: no chat yet, server unreachable, device not paired
  | 'off'
  | 'offline'
  | 'unpaired';

export const PRESENCE_LABEL: Record<Presence, string> = {
  ended: 'chat ended',
  typing: 'Claude is typing…',
  thinking: 'Claude is thinking…',
  listening: 'Claude is listening',
  queued: 'queued for Claude',
  waiting: 'Claude is not connected',
  ready: 'Claude is ready',
  off: 'chat not started',
  offline: 'chat server offline',
  unpaired: 'device not paired',
};

export type ChatEntry = { role: 'user' | 'agent'; text: string; at: string };
export type ChatContext = { label: string; path: string };

// one chat tab = one Claude Code session in the project
export type ChatTab = {
  key: string;
  title: string;
  presence: Presence;
  running: boolean;
  activity: string | null;
  claudeSession: string | null;
  // subagents of the tab's last run (cli/src/chat/runner.js agentTracker)
  agents?: SubAgent[];
  // the nos run the tab's session works in (nos run start … nos run cleanup), null in main
  run?: TabRun | null;
};

// cli/src/chat/runner.js runOf: what a tab knows about its run
export type TabRun = { kind: string; id: number; domain?: string; branch?: string; worktree?: string };

// "quick-7", "" without a run
export const tabRunLabel = (t: Pick<ChatTab, 'run'>) =>
  t.run && t.run.kind && t.run.id != null ? `${t.run.kind}-${t.run.id}` : '';

export type SubAgent = {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  activity: string | null;
  tools: number;
  startedAt: number;
  endedAt: number | null;
  // to open its transcript and to message it (null: a one-shot agent that cannot be resumed)
  agentId?: string | null;
};

const AGENT_STATUS = ['running', 'done', 'failed', 'stopped'];

const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export const runningAgents = (tab: ChatTab | null) => (tab?.agents ?? []).filter((a) => a.status === 'running').length;

// The subagents of the active tab behind the chevron of the tab bar: one row each with status,
// type, task, current tool call, tool calls so far and time taken. A row opens the subagent.
export function renderAgents(tab: ChatTab | null, now = Date.now()): string {
  const agents = tab?.agents ?? [];
  if (!agents.length) return '<p class="muted chat-agents-empty">No subagents in the last run of this chat.</p>';
  return `<ul>${agents
    .map((a) => {
      const status = AGENT_STATUS.includes(a.status) ? a.status : 'done';
      const what = a.status === 'running' ? (a.activity ?? 'starting…') : status;
      const n = `${a.tools} tool${a.tools === 1 ? '' : 's'} · ${took((a.endedAt ?? now) - a.startedAt)}`;
      return `<li class="agent" data-status="${esc(status)}"><button type="button" class="agent-open" data-chat="inspect" data-tool="${esc(a.id)}" data-agent="${esc(a.agentId ?? '')}" title="Show what it does"><span class="dot" aria-hidden="true"></span><span class="agent-main"><span class="agent-head"><strong>${esc(a.type)}</strong><span class="agent-desc">${esc(a.description)}</span></span><span class="agent-now mono">${esc(what)}</span></span><span class="agent-n muted">${esc(n)}</span><span class="agent-go" aria-hidden="true">&#8250;</span></button></li>`;
    })
    .join('')}</ul>`;
}

// a step of a session or subagent (cli/src/chat/transcript.js createCondenser)
export type TranscriptItem = {
  id: string;
  kind: 'user' | 'text' | 'thinking' | 'tool' | 'agent' | 'notice';
  at: string | null;
  text?: string;
  cut?: boolean;
  label?: string;
  name?: string;
  summary?: string;
  input?: string;
  inputCut?: boolean;
  output?: string | null;
  outputCut?: boolean;
  state?: 'running' | 'ok' | 'error';
  type?: string;
  description?: string;
  agentId?: string | null;
};

// what is being inspected: a subagent of a tab (tool = the call that started it)
export type InspectTarget = { key: string; tool: string; agentId: string | null; type: string; description: string };

// a message to a subagent goes to the main session, which forwards it (rule in cli/src/chat/runner.js SYSTEM_NOTE)
export const toSubagent = (t: Pick<InspectTarget, 'agentId' | 'description'>, text: string) =>
  `[to subagent ${t.agentId}${t.description ? ` (${t.description})` : ''}] ${text}`;

// One tab: select button with presence dot and unread badge, and its own close button.
export function renderTabs(tabs: ChatTab[], active: string | null, unread: Record<string, number>): string {
  return (
    tabs
      .map((t) => {
        const on = t.key === active;
        const n = on ? 0 : (unread[t.key] ?? 0);
        const hint = t.claudeSession ? ` — in a terminal: claude --resume ${t.claudeSession}` : '';
        const run = tabRunLabel(t);
        const where = run ? ` — run ${run}${t.run?.branch ? ` on branch ${t.run.branch}` : ''}` : '';
        const key = esc(t.key);
        return `<span role="tab" class="chat-tab" data-key="${key}" data-presence="${esc(t.presence)}" aria-selected="${on}"><button type="button" class="chat-tab-name" data-chat="tab" data-key="${key}" title="${esc(t.title + where + hint)}"><span class="dot" aria-hidden="true"></span><span class="lbl">${esc(t.title)}</span>${run ? `<span class="run-tag mono">${esc(run)}</span>` : ''}${n ? `<span class="badge">${n}</span>` : ''}</button><button type="button" class="chat-tab-x" data-chat="close-tab" data-key="${key}" aria-label="Close ${esc(t.title)}">&#10005;</button></span>`;
      })
      .join('') +
    '<button type="button" class="chat-new" data-chat="new" title="New chat: its own Claude Code session" aria-label="New chat">+</button>'
  );
}

// paired devices (cli/src/chat/devices.js), as the dev server lists them to this machine
export type PairedDevice = {
  id: string;
  name: string;
  status: 'pending' | 'active';
  approved: boolean;
  confirm?: string;
  createdAt: number;
  lastSeen: number | null;
};

// a fresh one-time pairing link, from "Pair a device"
export type PairLink = {
  urls: { interface: string; virtual: boolean; url: string }[];
  expiresAt: number;
  fingerprint: string | null;
  // QR code of the first real (not virtual) link, as SVG
  qr: string;
};

const ago = (t: number | null, now: number) => {
  if (!t) return 'never';
  const m = Math.round((now - t) / 60000);
  return m < 1
    ? 'just now'
    : m < 60
      ? `${m} min ago`
      : m < 1440
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} d ago`;
};

// waiting devices: allow only when the device shows the same number
export function renderPending(devices: PairedDevice[]): string {
  return devices
    .filter((d) => d.status === 'pending' && !d.approved)
    .map(
      (d) => `<div class="pair-ask" data-id="${esc(d.id)}">
  <div><strong>${esc(d.name)}</strong> wants to pair. Number on the device: <span class="pair-num">${esc(d.confirm ?? '')}</span></div>
  <div class="row"><button type="button" class="primary" data-chat="dev-approve" data-id="${esc(d.id)}">Allow</button><button type="button" data-chat="dev-deny" data-id="${esc(d.id)}">Deny</button></div>
</div>`,
    )
    .join('');
}

export function renderDevices(devices: PairedDevice[], link: PairLink | null, now = Date.now()): string {
  const active = devices.filter((d) => d.status === 'active');
  const phone = link?.urls.find((u) => !u.virtual) ?? link?.urls[0];
  return `<div class="chat-devices-head"><strong>Devices</strong><button type="button" class="primary" data-chat="dev-pair">Pair a device</button></div>
${
  link && !link.urls.length
    ? '<p class="pair-off">The spec-ui runs on this PC only. Start it with <code>npm run dev-to-lan</code> to pair a phone.</p>'
    : link
      ? `<div class="pair-link">
  ${link.qr}
  <div><p>Scan or open on the phone, <strong>once</strong>, within 10 minutes. Then allow it here.</p>
  ${phone ? `<p class="mono pair-url">${esc(phone.url)}</p>` : '<p class="muted">No network address found.</p>'}
  ${link.fingerprint ? `<p class="muted">Certificate: <span class="mono">${esc(link.fingerprint)}</span></p>` : ''}</div>
</div>`
      : ''
}
${renderPending(devices)}
${
  active.length
    ? `<ul class="dev-list">${active
        .map(
          (d) =>
            `<li><span>${esc(d.name)}</span><span class="muted">${ago(d.lastSeen, now)}</span><button type="button" data-chat="dev-revoke" data-id="${esc(d.id)}">Revoke</button></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">No paired devices. This PC needs none.</p>'
}`;
}

// the specs root as Claude sees it from main (spec paths in the model are relative to it)
export const SPECS_PREFIX = '.specs/';

// what the user looks at, as a spec path Claude can open
export function contextOf(model: Model, r: Route): ChatContext | null {
  if (r.view !== 'domains' && r.view !== 'ideas') return null;
  const idea = r.idea ? model.ideas.find((i) => i.slug === r.idea) : undefined;
  if (!idea) return null;
  const base = `${SPECS_PREFIX}${idea.folder}/`;
  const spec = (s: { specPath: string }) => (s.specPath ? SPECS_PREFIX + s.specPath : '');
  if (r.phase === QUICK_SEGMENT) {
    const s = r.step ? idea.quickSteps.find((q) => q.slug === r.step) : undefined;
    return s
      ? { label: `${itemId(s)} ${s.title}`, path: spec(s) || `${base}quick-steps/` }
      : { label: `${idea.title} · quick steps`, path: `${base}quick-steps/` };
  }
  const phase = r.phase ? idea.phases.find((p) => p.slug === r.phase) : undefined;
  if (phase) {
    const s = r.step ? phase.steps.find((x) => x.slug === r.step) : undefined;
    if (s) return { label: `${itemId(s)} ${s.title}`, path: spec(s) || base };
    return { label: `${itemId(phase)} ${phase.name}`, path: `${base}phases/phase-${phase.number}-${phase.slug}/` };
  }
  return { label: idea.title, path: base };
}

const CONTEXT_LINE = /^\[context: ([^\]\n]+)\]\n/;

export const withContext = (text: string, ctx: ChatContext | null) => (ctx ? `[context: ${ctx.path}]\n${text}` : text);

export function splitContext(text: string): { context: string | null; body: string } {
  const m = CONTEXT_LINE.exec(text);
  return m ? { context: m[1], body: text.slice(m[0].length) } : { context: null, body: text };
}

// text and fenced code parts, split on lines starting with three backticks
export function splitFences(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  text.split(/^```.*$/m).forEach((part, i) => {
    const code = i % 2 === 1;
    const t = code ? part.replace(/^\n/, '').replace(/\n$/, '') : part.replace(/^\n+/, '').replace(/\n+$/, '');
    if (t || code) out.push({ code, text: t });
  });
  return out;
}

export type AskKind = 'specify' | 'develop' | 'review' | 'plan' | 'discuss';

// the message prefilled by an "Ask Claude" button; the context line carries the path
export function askPrompt(kind: AskKind, ctx: ChatContext): string {
  const what = ctx.label;
  switch (kind) {
    case 'specify':
      return `Run the nos "specify" ability for ${what}.`;
    case 'develop':
      return `Run the nos "develop" ability for ${what}.`;
    case 'review':
      return `Review ${what} (nos "review-pessimistic").`;
    case 'plan':
      return `Create the plan for ${what} (nos "plan").`;
    case 'discuss':
      return `About ${what}: `;
  }
}

// "Ask Claude" buttons on a detail page (dev server only)
export function askButtons(kinds: AskKind[]): string {
  const label: Record<AskKind, string> = {
    specify: 'Specify',
    develop: 'Develop',
    review: 'Review',
    plan: 'Plan',
    discuss: 'Ask…',
  };
  return `<div class="ask" role="group" aria-label="Ask Claude"><span class="muted">Ask Claude</span>${kinds
    .map((k) => `<button type="button" data-action="ask" data-ask="${k}">${esc(label[k])}</button>`)
    .join('')}</div>`;
}

// static markup of the panel, filled by src/chat.ts
export const CHAT_SHELL = `<div class="chat-bar">
  <button type="button" class="chat-back" data-chat="close" aria-label="Back to specs">&#8249; specs</button>
  <strong>Claude</strong>
  <span class="chat-presence" data-presence="off"><span class="dot"></span><span class="lbl"></span></span>
  <span class="grow"></span>
  <span class="chat-view" role="group" aria-label="View">
    <button type="button" data-chat="view" data-view="chat" aria-pressed="true" title="Your messages and Claude's answers">Chat</button>
    <button type="button" data-chat="view" data-view="details" aria-pressed="false" title="Everything the session does: tool calls, outputs, subagents">Details</button>
  </span>
  <button type="button" data-chat="devices" hidden title="Phones and tablets paired with this PC" aria-label="Devices">&#128241;<span class="t"> Devices</span></button>
  <button type="button" data-chat="rename" hidden title="Rename this chat" aria-label="Rename">&#9998;<span class="t"> Rename</span></button>
  <button type="button" data-chat="stop" hidden title="Stop what Claude is doing" aria-label="Stop">&#9632;<span class="t"> Stop</span></button>
  <button type="button" class="chat-x" data-chat="close" aria-label="Close chat">&#10005;</button>
</div>
<div class="chat-tabs-row">
  <div class="chat-tabs" role="tablist" aria-label="Chats"></div>
  <button type="button" class="chat-agents-toggle" data-chat="agents" aria-expanded="false" aria-controls="chat-agents" title="Subagents"><span class="badge" hidden></span><span class="chev" aria-hidden="true">&#8964;</span></button>
</div>
<div class="chat-inspect" hidden>
  <button type="button" class="chat-inspect-back" data-chat="back"><span aria-hidden="true">&#8249;</span> <span class="lbl"></span></button>
  <span class="chat-inspect-what"><span class="dot" aria-hidden="true"></span><strong class="type"></strong><span class="desc"></span></span>
</div>
<section class="chat-agents" id="chat-agents" hidden aria-label="Subagents"></section>
<section class="chat-devices" hidden aria-label="Devices"></section>
<form class="chat-rename-row" hidden>
  <input class="chat-rename" maxlength="60" aria-label="Chat name" enterkeyhint="done" autocomplete="off">
  <button type="submit" class="primary">Save</button>
  <button type="button" data-chat="rename-cancel">Cancel</button>
</form>
<div class="chat-log" aria-live="polite"></div>
<p class="chat-activity mono" hidden></p>
<div class="chat-notice" hidden></div>
<form class="chat-composer">
  <div class="chat-context" hidden>
    <span class="chip"><span class="lbl"></span><button type="button" data-chat="drop-context" aria-label="Do not send the context">&#10005;</button></span>
  </div>
  <textarea rows="2" placeholder="Message Claude…" aria-label="Message to Claude"></textarea>
  <button type="submit" class="primary">Send</button>
  <p class="chat-line muted" role="status"></p>
</form>
<div class="chat-resize" data-chat="resize" aria-hidden="true"></div>`;

const time = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function el(tag: string, cls: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// redraws the log; keeps it at the bottom only when the reader already is (within 40px)
export function renderLog(log: HTMLElement, chat: ChatEntry[], presence: Presence) {
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = '';
  if (!chat.length)
    log.append(el('p', 'chat-empty muted', 'Type a message. It goes to the Claude Code session of this project.'));
  for (const m of chat) {
    const msg = el('div', `msg ${m.role}`);
    const { context, body } = m.role === 'user' ? splitContext(m.text) : { context: null, body: m.text };
    msg.append(el('div', 'meta', `${m.role === 'user' ? 'You' : 'Claude'} · ${time(m.at)}`));
    if (context) msg.append(el('div', 'ctx mono', context));
    for (const part of splitFences(body)) msg.append(el(part.code ? 'pre' : 'div', part.code ? '' : 't', part.text));
    log.append(msg);
  }
  if (presence === 'thinking' || presence === 'typing') {
    const b = el('div', 'chat-dots');
    b.setAttribute('role', 'status');
    b.setAttribute('aria-label', PRESENCE_LABEL[presence]);
    for (let i = 0; i < 3; i++) b.append(el('span', '', '●'));
    log.append(b);
  } else if (presence === 'queued') {
    const n = el('p', 'chat-note muted', 'Your message is in the queue. Claude Code is not listening right now.');
    n.setAttribute('role', 'status');
    log.append(n);
  }
  if (stick) log.scrollTop = log.scrollHeight;
}

const STATE_MARK = { running: '…', ok: '✓', error: '✗' } as const;

// The details view: every step, text only through textContent. Tool calls and thinking fold;
// the folds the reader opened stay open across redraws. `who` names the speaker of text steps.
export function renderTranscript(
  log: HTMLElement,
  items: TranscriptItem[],
  { truncated = false, who = 'Claude', empty = 'No steps yet.' } = {},
) {
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const open = new Set([...log.querySelectorAll<HTMLElement>('details[open]')].map((d) => d.dataset.id));
  log.textContent = '';
  if (truncated) log.append(el('p', 'chat-note muted', 'Earlier steps are not shown.'));
  if (!items.length) log.append(el('p', 'chat-empty muted', empty));
  const pre = (label: string, text: string, cut = false) => {
    const box = el('div', 'tr-io');
    box.append(el('div', 'tr-io-label muted', label), el('pre', '', text + (cut ? '\n…' : '')));
    return box;
  };
  for (const it of items) {
    if (it.kind === 'user' || it.kind === 'text') {
      const user = it.kind === 'user';
      const msg = el('div', `msg ${user ? 'user' : 'agent'}`);
      const { context, body } = user ? splitContext(it.text ?? '') : { context: null, body: it.text ?? '' };
      msg.append(el('div', 'meta', `${it.label ?? (user ? 'You' : who)}${it.at ? ' · ' + time(it.at) : ''}`));
      if (context) msg.append(el('div', 'ctx mono', context));
      for (const part of splitFences(body)) msg.append(el(part.code ? 'pre' : 'div', part.code ? '' : 't', part.text));
      if (it.cut) msg.append(el('div', 't muted', '…'));
      log.append(msg);
    } else if (it.kind === 'thinking' || it.kind === 'tool') {
      const d = el('details', it.kind === 'tool' ? 'tr-tool' : 'tr-think') as HTMLDetailsElement;
      d.dataset.id = it.id;
      if (open.has(it.id)) d.open = true;
      const sum = el('summary', '');
      if (it.kind === 'tool') {
        const state = it.state ?? 'running';
        d.dataset.state = state;
        sum.append(
          el('span', 'tr-mark', STATE_MARK[state] ?? '…'),
          el('span', 'tr-sum mono', it.summary ?? it.name ?? ''),
        );
        d.append(sum, pre('Input', it.input ?? '', it.inputCut));
        d.append(it.output == null ? el('p', 'muted tr-wait', 'Running…') : pre('Output', it.output, it.outputCut));
      } else {
        sum.append(el('span', 'tr-sum muted', 'Thinking'));
        d.append(sum, el('div', 't', it.text ?? ''));
      }
      log.append(d);
    } else if (it.kind === 'agent') {
      const row = el('div', 'tr-agent');
      row.dataset.state = it.state ?? 'running';
      const b = el('button', 'tr-agent-open') as HTMLButtonElement;
      b.type = 'button';
      b.dataset.chat = 'inspect';
      b.dataset.tool = it.id;
      b.dataset.agent = it.agentId ?? '';
      b.append(
        el('span', 'tr-mark', '⇢'),
        el('strong', '', it.type ?? 'agent'),
        el('span', 'tr-sum', it.description ?? ''),
        el('span', 'tr-go', 'Open ›'),
      );
      row.append(b);
      log.append(row);
    } else if (it.kind === 'notice') {
      log.append(el('p', 'tr-notice muted', it.text ?? ''));
    }
  }
  if (stick) log.scrollTop = log.scrollHeight;
}
