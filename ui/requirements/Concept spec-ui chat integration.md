# Concept: local Claude Code chat inside nos spec-ui

Status: implemented (phases 1–5, own sessions and tabs, couch mode, details view). Deviations from the first draft are
folded in below; the first draft's relay model is now the option, own sessions (runner) the default.

## Context
`requirements/Technical design local web chat for Claude Code.md` specs a loopback chat relay (server + CLI `await`/`reply` + skill + Stop hook). Goal: use it from the spec-ui so the user chats with Claude Code running **in the project repo** (`moodo-poc/`, where `specs/` lives), not in the nos skill folder (`.claude/skills/nos/`).

Key facts from codebase:
- nos lives copied in the project at `.claude/skills/nos/`. spec-ui dev server (vite, port 5180, `ui/vite.config.ts`) already resolves project root = `dirname(../../../../specs)`.
- `src/serve-specs.ts` = vite middleware (`/__specs`, `/__docs`, `POST /__promote` → spawns nos CLI with `--root <root>`). Pattern to reuse.
- Standalone mode (`index.html` via `file://`) has no server → chat not possible there.
- nos CLI (`cli/src/cli.js`, `COMMANDS` map, JSON out, `--root` default cwd) — natural home for chat commands.
- Project `.claude/settings.json` = `{"hooks":{}}` → place for permission rule (+ Stop hook in relay mode).

## Core decision: session = project root
- Chat key = sha256(realpath(project root))[0..12] (spec rule). Claude Code runs with cwd = `moodo-poc/` → `nos chat open` uses cwd → same key.
- spec-ui computes the **same** key from its known root (shared `keyOf()` function), so UI and agent meet without IDs.
- Guard: CLI resolves root by walking up from cwd to dir containing `specs/` (or `--root`), so calling from `ui/` folder still targets project, never nos folder.
- Tabs: a tab = `keyOf(root, "t-<random>")`, its own transcript and its own Claude Code session (see *Own sessions*).

## Decisions
- CLI: `nos chat …` subcommand of the nos CLI (no separate `harness-chat` bin).
- UI: drawer on desktop, full-size dialog on mobile, opened from one header button.
- State: per project in `specs/.chat/`, not global.
- Answering: by default the chat server runs its own headless Claude Code session per tab (runner). The relay through a terminal session (`await`/`reply`, Stop hook) stays as `"chat": { "runner": false }`.

## Per-project state
- State dir = `<project>/specs/.chat/` (env `NOS_CHAT_STATE_DIR` overrides, for tests). Files: `sessions.json` (tabs, transcripts, queues), `server.json`, `server.log`, `devices.json` (paired devices, hashes only), `audit.log`, `tls/` (couch-mode certificate).
- `nos chat` creates `specs/.chat/.gitignore` containing `*` → never committed, no edit to the project `.gitignore` needed.
- **One server per project.** Port: `specs/config.json` → `"chat": { "port": 4611 }` (default 4611). `/health` also returns `root`. If the port is held by another project's server, `open` picks a free port and writes it to `server.json`. Vite proxy reads `server.json` on each request, so port changes need no vite restart.
- **Every dev server start runs `nos chat start`** (once per vite process): a running chat server with this CLI's code is kept, its tabs and running Claude Code runs stay live. "This CLI's code" = same version and same code fingerprint (a hash of the content of `cli/src/**/*.js`, reported by `/health` and `server.json`). None running, another version or another fingerprint (local nos edits) → the server is replaced, which ends its running runs; transcripts and Claude Code session ids survive, the next message resumes. `nos chat open` applies the same check.
- spec-ui watcher ignores `specs/.chat/`, else every chat message fires `specs:changed` and reloads the board. `readSpecsFolder` reads only `domain-*` folders, so it needed no change.
- Stop hook (relay only) reads `<cwd>/specs/.chat/sessions.json` directly: no global lookup, and no `dir` match needed. In runner mode (`chatConfig(root).runner`) the hook returns at once, so it never takes a runner tab's messages, not even while the server is down.

## Architecture
```
Browser (spec-ui :5180)  --same-origin /__chat/*-->  vite proxy  -->  chat server 127.0.0.1:4611
                                                                       |  spawns, per tab (runner, default)
                                                                       +--> claude -p (stream-json in/out, cwd = project)
                                                                       |
Claude Code in a terminal (relay option) -- nos chat await/reply ------+
Stop hook (relay option) -- drains queue -------------------------------+
```
1. **Chat server** = spec as written, independent process (works without UI, restarted by the dev server). Location: `.claude/skills/nos/cli/src/chat/` (`paths.js`, `sessions.js`, `server.js`, `guard.js`, `launch.js`, `ui.js`, `client.js`, `commands.js`, `hook.js`, `runner.js`, `transcript.js`, `devices.js`), ESM like the rest of the CLI, built-ins only.
2. **CLI**: `nos chat <open|new|await|reply|typing|pending|end|stop|restart|server|pair|devices|hook>` in `cli/src/cli.js`. One permission rule, one tool. Output/next_step per spec.
3. **spec-ui integration** (dev mode only):
   - `src/chat-proxy.ts` (used by `serve-specs.ts`): same-origin routes, key fixed server-side, only the user's side of the API: `GET /__chat/state`, `POST /__chat/open` (runs `nos chat open --no-open`), `POST /__chat/new`, `GET /__chat/events` (project-wide stream), `GET /__chat/transcript-events` (details view), `POST /__chat/messages|end|stop|title` (`?key=` picks the tab), `/__chat/devices…` (this machine only). Port read from `specs/.chat/server.json` per request. No EventSource CORS needed.
   - **Chat panel**: see *Chat UI* below.
   - Implementation in TS like other views: `src/chat.ts` (EventSource, send, presence, tabs, details), `src/views/chat.ts` (pure HTML render, `textContent`-safe insertion of messages and steps, code-fence split). Hidden when `opts.canChat` false (standalone).
   - **Context-aware messages** (nos value-add): message carries current route (`domain/phase/step` from `parseRoute`) as prefix, e.g. `[context: specs/domain-3/phases/phase-1/step-2.md] …`. Toggleable chip in composer.
   - **Action shortcuts** on step/domain detail: "Ask Claude: specify / develop / review this step" → prefills composer with nos ability invocation. Reuses existing `[data-action]` delegation in `app.ts` → `onAction`.
   - Presence pill in header (see *Chat UI*) even when drawer closed.
4. **Skill**: ability `abilities/chat.md` (runner by default, relay section), listed in nos `SKILL.md`. `workflow.md`: CHAT menu entry, chat runs in the main session, relay rules.
5. **Setup**: nos `setup` ability (step7) writes into project `.claude/settings.json`: permission `Bash(node .claude/skills/nos/cli/bin/nos.js chat *)` (+ `nos chat *` if linked). Relay only: `"chat": { "runner": false }` in `specs/config.json` and the Stop hook `node .claude/skills/nos/cli/bin/nos.js chat hook`. A hook left over from an earlier relay setup is harmless in runner mode (see *Per-project state*).

## Own sessions (runner, default) and tabs
The chat does not depend on a terminal session: the chat server answers every chat tab with its own headless
Claude Code session (`cli/src/chat/runner.js`).
- One tab = one chat session in the store (own key, own transcript) = one Claude Code session (`claudeSession` uuid).
- **One long-lived process per tab**: `claude -p --input-format stream-json --output-format stream-json --verbose
  --permission-prompts none --permission-mode auto --session-id <uuid>` (first start, plus `--name "nos chat: <title>"`)
  or `--resume <uuid>`, cwd = project root, `--append-system-prompt` with the chat rules (short replies, no prompts
  possible, "[to subagent …]" forwarding). Started on the tab's first message. Messages go in on stdin as they come,
  also mid-turn (Claude Code queues them); every top-level text block is a reply as soon as it comes, the `result`
  ends a turn, `tool_use` events become the activity line, errors a "⚠ …" reply. The process closes after 10 min with
  no turn and no running subagent; the next message resumes the session. Stop kills the process tree (`taskkill /T` on
  Windows). Env vars of a calling Claude Code session are dropped. Unmodified Claude Code with the user's own login.
- **Subagents** are tracked from the stream (Agent/Task tool calls, their child tool calls, `task_started/progress/
  notification` events, SendMessage resumes) and sent per tab as `agents`. The tab bar ends in a chevron with the
  running count; expanded it lists type, task, current tool call, tool count and time per subagent. A row opens the
  subagent (see *Details view*).
- Tab title = first message (40 chars, context prefix stripped); "✎ Rename" in the bar opens a full-width name field
  (phone-sized targets). Every tab has its own ✕ (asks only when it has messages or is running). A closed chat is
  never revived: "+" after the last tab was closed opens a fresh one. Opening the chat with no tab open starts one.
  Tooltip shows `claude --resume <uuid>`.
- Phone keyboard: the full-size dialog follows `visualViewport` (height and offsetTop), the page behind is locked
  (`html.chat-modal`), and `interactive-widget=resizes-content` in the viewport meta for Android.
- Presence in runner mode: thinking (turn or subagent running), queued, ready.
- Project-wide event stream `/events-all`: `sessions` (tabs), `chat-sync`, `presence`, `activity`, `agents`, `ended`,
  each with the key. Server API: `POST /api/sessions/new`, `POST /api/session/<key>/stop|title|messages|end`,
  `GET /transcript-events`.
- Config `"chat"` in `specs/config.json`: `runner` (default true), `permissionMode` (default `auto`), `model`, `claude`
  (path of the executable).
- `runner: false` = relay as before (terminal session with `await`/`reply`, Stop hook); in runner mode `/api/await`
  answers `runner` so a terminal session cannot take the messages.
- Risk accepted by the user: anyone holding a paired device can make Claude Code act in the project in auto mode.

## Details view and subagent inspection
A Chat | Details switch in the bar (remembered in localStorage).
- **Details** shows every step of the tab's Claude Code session: user prompts, Claude's texts, thinking (folded),
  tool calls with input and output (folded, state ✓/✗/…), subagent launches, notices (task updates, agent messages,
  interrupts). Injected context (skill text, system reminders) is not shown.
- Source: Claude Code's **own transcripts** (`<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug>/<session>.jsonl`, a
  subagent in `<session>/subagents/agent-<id>.jsonl` + `.meta.json`). Nothing new is captured and the history survives
  restarts. `cli/src/chat/transcript.js`: `createCondenser` turns lines into items, `tailTranscript` follows a file
  (`fs.watch` + 1 s poll) and pushes new and changed items; the first push holds the last 400 items. Fields are
  capped at 4000 chars. The server streams them as `items` events on `/transcript-events?key=&agent=|tool=`; the
  proxy route is `/__chat/transcript-events`.
- **Open a subagent** from the chevron list or its step: a back button takes the place of the tab bar, its steps
  stream in. A message typed there goes to the **main session** as `[to subagent <id> (<task>)] <text>`; the system
  note makes Claude forward it with SendMessage and confirm. This is a convention, not a channel: it needs the main
  process alive and the model to comply, and costs a main-session turn. The composer is hidden for agents without an
  id (one-shot, cannot be resumed).
- Runner mode only: a relay session has no `claudeSession`, so Details stays empty ("No steps yet").
- Bar buttons (Devices, Rename, Stop) turn into icons on phones.
- **Security impact**: a paired device now sees everything the session read, not only the replies and the one-line
  tool activity. Covered by the accepted risk above (a device that can act can also read), and every details view is
  in the audit log (`details`, with key and agent/tool).

## LAN use (couch mode) + security
Goal: instruct the agents from a phone on the home network via `npm run dev-to-lan`, with auto mode and dedicated
sessions kept. "A paired device" means: a device approved on the PC, over an encrypted connection, revocable.
- **This machine** = loopback socket and loopback Host (`:authority` over HTTP/2) — needs no pairing.
- **HTTPS** (`vite --host --mode lan`): self-signed certificate made once with `selfsigned`, kept in `specs/.chat/tls`
  (SAN: localhost, hostname, 127.0.0.1, the LAN IPs; 2 years; remade only when a new IP is not covered). Its short
  SHA-256 fingerprint is printed in the banner and on the pairing page (trust on first use). Vite serves HTTP/2.
  `vite --host` without `--mode lan` also pairs, over plain HTTP: the cookie then lacks `Secure` and the device secret
  crosses the wire in clear once. Use `dev-to-lan`.
- **One-time pairing** (`cli/src/chat/devices.js`, shared with the dev server through `devices.d.ts`): a code (24
  random bytes, 10 min, single use, stored as hash) from the banner (with an ASCII QR code), "Pair a device" in the chat
  panel (SVG QR code, `qrcode-generator`) or `nos chat pair`. Opening it uses the code up and creates a *pending*
  device with a 4-digit number (pending cookie, 10 min); the phone waits on `/__pair` and polls `/__pair/status`.
- **Approval on the PC**: toast and Devices panel (this machine only) or `nos chat devices --approve`; allow only when
  the numbers match. The next poll hands the device its own secret once: cookie `nos_device=<id>.<secret>`
  (`HttpOnly; SameSite=Strict; Secure` on HTTPS, 30 days idle); only `sha256(secret)` is stored.
- **Gate** (`ui/src/access.ts`): every request — pages, `/__specs`, `/__docs`, `/__promote`, `/__chat/*` — and the HMR
  websocket upgrade need this machine or a paired device; unpaired pages redirect to `/__pair`, the rest gets 401.
- **Per device**: list, approve, deny, revoke (open event streams are cut at once), rename — this machine only
  (`/__chat/devices…`, same-origin POSTs). `nos chat devices [--approve|--deny|--revoke <id>] [--revoke-all]`.
- **Audit**: `specs/.chat/audit.log` — pair requests, approvals, revokes, open, new tab, message, stop, close, rename,
  details view, with device id. Gitignored with the rest of `specs/.chat/`.
- CSRF: mutating POSTs need `Origin` host == Host. Runs stay unrestricted (auto mode, no disallowed tools).
- Chat server itself: loopback Host and loopback Origin only (`guard.js`); a missing Origin is fine (CLI). Any local
  process can therefore use its API, `POST /shutdown` included — accepted, it never faces the network.
- Not done on purpose: passkeys/WebAuthn (need a domain and a trusted certificate, not a LAN IP), own WebCrypto key per
  device (no gain over the HttpOnly per-device cookie), password login (sniffable, phishable, shared secret).

## Chat UI (desktop drawer, mobile dialog)
One component, `<dialog id="chat">` in `dev.html`. Layout and modality depend on screen width.
- **Header button** `#chat-toggle` in `.right`: chat icon + presence dot (green = ready/listening, pulsing = thinking/typing, amber = queued, grey = not connected, red = server offline/unpaired). Badge with count of unread agent replies when panel closed. Always visible, so presence is readable while browsing.
- **Desktop (> 860px)**: `dialog.show()` (non-modal). Fixed right drawer, ~420px, resizable by drag handle (width in localStorage). `#main` gets `margin-right` so board stays usable next to it. Open/closed state persisted in localStorage (try/catch).
- **Phone/tablet (≤ 860px, same breakpoint as the existing layout)**: `dialog.showModal()`. Full size (`inset:0`, `100dvh`). Own top bar: back arrow "specs", presence label, End-chat in overflow menu. Composer pinned to bottom, `env(safe-area-inset-bottom)`, textarea font 16px (no iOS zoom). `visualViewport` resize keeps the composer above the keyboard. Enter = newline on touch devices, explicit Send button (desktop: Enter sends, Shift+Enter newline).
- **Back button**: opening on mobile does `history.pushState({chat:true}, '', location.hash)`; `popstate` closes the dialog, so the Android/iOS back gesture closes chat instead of leaving the page. Esc closes on desktop.
- **Breakpoint change** (rotate, resize) while open: close and reopen in the right mode, keeping the draft.
- Same-origin `EventSource('/__chat/events')` stays connected while closed (for presence + unread badge); reconnects by itself. The details stream is open only while Details or a subagent is shown.
- Message log: user right, Claude left; text via `textContent` + `pre-wrap`; code fences as `<pre>`; stick-to-bottom within 40px; `role="status"` on activity bubble; reduced-motion respected. The details view renders the same way; opened folds stay open across redraws.
- Context chip above the composer ("📎 step 1.2.3", tap to remove) and action shortcuts as described above. On mobile, step detail gets an "Ask Claude" button that opens the dialog prefilled.

## Files
- CLI: `cli/src/chat/*.js` (incl. `runner.js`, `transcript.js`, `devices.js` + `devices.d.ts`), `cli/bin/nos.js` (async `chat` branch), `cli/src/cli.js` (usage, `nos help chat`), `cli/test/chat/{store,server,tool,runner,transcript,devices}.test.js`, `cli/README.md`
- skill: `abilities/chat.md`, `SKILL.md`, `workflow.md` (CHAT menu entry, chat rules), `abilities/setup.md` (step7: permissions, relay-only Stop hook)
- spec-ui: `src/chat-proxy.ts`, `src/access.ts`, `src/tls.ts`, `src/chat.ts`, `src/views/chat.ts`, `src/serve-specs.ts` (routes, gate, restart, pairing print, `.chat` ignored by the watcher), `src/main.ts`, `src/app.ts` + `src/views/explore.ts` (`canChat`, "Ask Claude"), `dev.html` (header button, viewport meta), `styles.css`, `tests/chat.test.ts`, `tests/chat-proxy.test.ts`, `bundle/viewer.js` (rebuilt)
- The chat server's own page (`cli/src/chat/ui.js`) stays as fallback at `http://127.0.0.1:<port>/chat/<key>`.

## Phasing (done)
1. Chat server + store + guard + tests (spec, but state in `specs/.chat/`, port from config, `root` in `/health`).
2. `nos chat` CLI + ability + hook + settings via setup.
3. spec-ui: header button, desktop drawer, mobile dialog, proxy, `.chat` ignore.
4. Couch mode: HTTPS, one-time pairing, per-device cookie, gate, audit.
5. Context chips + action shortcuts.
6. Own sessions (runner), tabs, long-lived process, subagent tracking, restart on dev start.
7. Details view from the Claude Code transcripts, subagent inspection and messaging.

## Verification
- `node --test` in `nos/cli` (store, server, tool, runner with a fake `claude`, transcript condenser/tail, devices).
- `npm test` + `npm run typecheck` in `ui/` (drawer render, tabs, agents list, details render, key match, gate, pairing, audit, LAN refusal via fake req like `promote.test.ts`).
- Manual, runner: `npm run dev` in ui → chat server restarted (banner) → "+" tab → message → activity line, reply streams in, presence thinking → ready; second message mid-turn is queued by Claude Code; Details shows the steps, a subagent opens from the chevron and its steps stream; Stop ends the run; after 10 min idle the process is gone and the next message resumes (`claude --resume <uuid>` from the tooltip works in a terminal); board does not reload on chat messages.
- Manual, relay: `"chat": { "runner": false }`, Claude Code in `moodo-poc/`, run chat ability → message reaches parked await <1 s, reply appears without reload; key equals `nos chat` key.
- Manual, phone: dialog full size, back gesture closes it, composer stays above keyboard; phone on same Wi-Fi opens pairing link → number matches → chat works; LAN request without cookie → 401; cross-origin POST → 403; revoke cuts the stream; `audit.log` holds the actions and details views.
