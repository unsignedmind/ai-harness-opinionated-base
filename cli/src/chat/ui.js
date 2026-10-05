// The chat server's own page (fallback when the spec-ui is not running): the session list, the chat
// page shell, its stylesheet and its browser script, as strings. No framework, no build step.
// Message text only ever goes into the page through textContent.

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const folderName = (dir) => String(dir).split(/[\\/]/).filter(Boolean).pop() ?? dir;

const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escHtml(title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/chat.css"></head>
<body>${body}</body></html>`;

export function listPage(sessions) {
  const rows = sessions.length
    ? sessions
        .map(
          (s) =>
            `<li><a href="/chat/${escHtml(s.key)}">${escHtml(folderName(s.dir))}${s.name ? ' · ' + escHtml(s.name) : ''}</a>
             <span class="muted">${escHtml(s.status)}${s.pending ? ` · ${s.pending} queued` : ''}</span></li>`,
        )
        .join('')
    : '<li class="muted">No chats yet. Run <code>nos chat open</code> in a project.</li>';
  return shell('nos chat', `<main class="list"><h1>nos chat</h1><ul>${rows}</ul></main>`);
}

export function chatPage(boot) {
  const data = JSON.stringify(boot).replace(/</g, '\\u003c');
  return shell(
    `chat · ${folderName(boot.dir)}`,
    `<header><strong>Claude chat</strong><span class="muted">${escHtml(folderName(boot.dir))}</span>
  <span id="pill" class="pill">…</span><span class="grow"></span>
  <button type="button" id="theme" title="Toggle theme">◐</button>
  <button type="button" id="end">End chat</button></header>
<main id="log" aria-live="polite"></main>
<form id="composer"><textarea id="text" rows="2" placeholder="Message Claude…" aria-label="Message"></textarea>
  <button type="submit" id="send">Send</button><p id="line" class="muted"></p></form>
<script type="application/json" id="boot">${data}</script>
<script src="/client.js"></script>`,
  );
}

export const CSS = `:root{--bg:#14161a;--fg:#e6e6e6;--muted:#8b9099;--line:#2a2e35;--me:#2b4a7a;--agent:#23272e;--accent:#6ea8fe}
:root[data-theme=light]{--bg:#fafafa;--fg:#1d1f23;--muted:#6b7079;--line:#d9dce1;--me:#d6e6ff;--agent:#eceef1;--accent:#1f6feb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;display:flex;flex-direction:column;height:100dvh}
header{display:flex;gap:10px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}.grow{flex:1}
.muted{color:var(--muted)}.pill{border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:13px}
button{background:none;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 10px;font:inherit;cursor:pointer}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:min(720px,85%);padding:8px 12px;border-radius:10px;background:var(--agent)}.msg.user{align-self:flex-end;background:var(--me)}
.msg .meta{font-size:12px;color:var(--muted);margin-bottom:2px}.msg .t{white-space:pre-wrap;overflow-wrap:anywhere}
.msg pre{white-space:pre;overflow:auto;background:rgba(0,0,0,.25);padding:8px;border-radius:6px;margin:6px 0}
.note,.dots{align-self:flex-start;color:var(--muted)}.dots span{display:inline-block;animation:b 1s infinite}.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
@keyframes b{50%{opacity:.2}}@media (prefers-reduced-motion:reduce){.dots span{animation:none}}
#composer{display:grid;grid-template-columns:1fr auto;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line)}
#text{resize:vertical;background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px;font:16px/1.4 system-ui,sans-serif}
#line{grid-column:1/-1;margin:0;font-size:13px}.list{padding:16px;max-width:720px;margin:auto}.list li{margin:6px 0}a{color:var(--accent)}`;

export const CLIENT_JS = `(() => {
  const boot = JSON.parse(document.getElementById('boot').textContent);
  const log = document.getElementById('log'), pill = document.getElementById('pill');
  const text = document.getElementById('text'), line = document.getElementById('line');
  const LABEL = { ended: 'session ended', typing: 'Claude is typing…', thinking: 'Claude is thinking…', listening: 'Claude is listening', queued: 'queued for Claude', waiting: 'Claude is not connected' };
  let chat = boot.chat, presence = boot.status === 'ended' ? 'ended' : 'waiting', ended = boot.status === 'ended', busy = false;
  try { const t = localStorage.getItem('nos-chat-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  document.getElementById('theme').onclick = () => {
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('nos-chat-theme', t); } catch {}
  };
  function body(t) {
    const frag = document.createDocumentFragment();
    String(t).split(/^\\x60\\x60\\x60.*$/m).forEach((part, i) => {
      if (!part.trim() && i % 2 === 0) return;
      const el = document.createElement(i % 2 ? 'pre' : 'div');
      if (!(i % 2)) el.className = 't';
      el.textContent = i % 2 ? part.replace(/^\\n|\\n$/g, '') : part.replace(/^\\n+|\\n+$/g, '');
      frag.append(el);
    });
    return frag;
  }
  function draw() {
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = '';
    if (!chat.length) { const p = document.createElement('p'); p.className = 'note'; p.textContent = 'Type a message. It goes to your Claude Code session.'; log.append(p); }
    for (const m of chat) {
      const d = document.createElement('div'); d.className = 'msg ' + m.role;
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = (m.role === 'user' ? 'You' : 'Claude') + ' · ' + new Date(m.at).toLocaleTimeString();
      d.append(meta, body(m.text)); log.append(d);
    }
    if (presence === 'thinking' || presence === 'typing') {
      const b = document.createElement('div'); b.className = 'dots'; b.setAttribute('role', 'status');
      b.setAttribute('aria-label', LABEL[presence]); b.innerHTML = '<span>●</span><span>●</span><span>●</span>'; log.append(b);
    } else if (presence === 'queued') {
      const n = document.createElement('p'); n.className = 'note'; n.setAttribute('role', 'status');
      n.textContent = 'Your message is in the queue. Claude Code is not listening right now.'; log.append(n);
    }
    pill.textContent = LABEL[presence] || presence;
    text.disabled = ended; document.getElementById('send').disabled = ended;
    if (stick) log.scrollTop = log.scrollHeight;
  }
  const es = new EventSource('/events/' + boot.key);
  es.addEventListener('chat-sync', (e) => { chat = JSON.parse(e.data).chat; draw(); });
  es.addEventListener('presence', (e) => { presence = JSON.parse(e.data).state; draw(); });
  es.addEventListener('ended', (e) => { ended = true; presence = 'ended'; line.textContent = 'Chat ended by ' + (JSON.parse(e.data).endedBy || 'someone') + '.'; es.close(); draw(); });
  es.onerror = () => { if (!ended) pill.textContent = 'chat server offline'; };
  async function sendMsg() {
    const t = text.value; if (busy || ended || !t.trim()) return; busy = true;
    try {
      const r = await fetch('/api/session/' + boot.key + '/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
      if (!r.ok) throw new Error();
      const j = await r.json(); text.value = ''; presence = j.presence;
      line.textContent = presence === 'thinking' || presence === 'typing' ? 'Delivered. Claude has it.' : 'Queued. Claude picks this up when it next listens.';
      draw();
    } catch { line.textContent = 'Send failed. Is the chat server running?'; } finally { busy = false; }
  }
  document.getElementById('composer').onsubmit = (e) => { e.preventDefault(); sendMsg(); };
  text.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); } };
  document.getElementById('end').onclick = async () => {
    if (ended || !confirm('End this chat? Claude stops listening.')) return;
    await fetch('/api/session/' + boot.key + '/end', { method: 'POST' }).catch(() => {});
  };
  draw();
})();`;
