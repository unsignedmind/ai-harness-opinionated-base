# Concept: local Claude Code chat inside nos spec-ui

Status: implemented (phases 1–5, plus own sessions and tabs). Deviations from the first draft are folded in below.

## Context
`requirements/Technical design local web chat for Claude Code.md` specs a loopback chat relay (server + CLI `await`/`reply` + skill + Stop hook). Goal: use it from the spec-ui so the user chats with the Claude Code session running **in the project repo** (`moodo-poc/`, where `specs/` lives), not in the nos skill folder (`.claude/skills/nos/`).

Key facts from codebase:
- nos lives copied in the project at `.claude/skills/nos/`. spec-ui dev server (vite, port 5180, `ui/vite.config.ts`) already resolves project root = `dirname(../../../../specs)`.
- `src/serve-specs.ts` = vite middleware (`/__specs`, `/__docs`, `POST /__promote` → spawns nos CLI with `--root <root>`). Pattern to reuse.
- Standalone mode (`index.html` via `file://`) has no server → chat not possible there.
- nos CLI (`cli/src/cli.js`, `COMMANDS` map, JSON out, `--root` default cwd) — natural home for chat commands.
- Project `.claude/settings.json` = `{"hooks":{}}` → place for Stop hook + permission rule.

## Core decision: session = project root
- Chat key = sha256(realpath(project root))[0..12] (spec rule). Claude Code runs with cwd = `moodo-poc/` → `nos chat open` uses cwd → same key.
- spec-ui computes the **same** key from its known root (shared `keyOf()` function), so UI and agent meet without IDs.
- Guard: CLI resolves root by walking up from cwd to dir containing `specs/` (or `--root`), so calling from `ui/` folder still targets project, never nos folder.

## Decisions
- CLI: `nos chat …` subcommand of the nos CLI (no separate `harness-chat` bin).
- UI: drawer on desktop, full-size dialog on mobile, opened from one header button.
- State: per project in `specs/.chat/`, not global.

## Per-project state
- State dir = `<project>/specs/.chat/` (env `NOS_CHAT_STATE_DIR` overrides, for tests). Files as in the spec: `sessions.json`, `server.json`, `server.log`, plus `token` (LAN pairing).
- `nos chat` creates `specs/.chat/.gitignore` containing `*` → never committed, no edit to the project `.gitignore` needed.
- **One server per project.** Port: `specs/config.json` → `"chat": { "port": 4611 }` (default 4611). `/health` also returns `root`. If the port is held by another project's server, `open` picks a free port and writes it to `server.json`. Vite proxy reads `server.json` on each request, so port changes need no vite restart.
- spec-ui watcher and `readSpecsFolder` (`src/folder.ts`) must **ignore `specs/.chat/`**, else every chat message fires `specs:changed` and reloads the board.
- Stop hook reads `<cwd>/specs/.chat/sessions.json` directly: no global lookup, and no `dir` match needed.

## Architecture
```
Browser (spec-ui :5180)  --same-origin /__chat/*-->  vite proxy  -->  chat server 127.0.0.1:4611
                                                                       ^
Claude Code (cwd = project) -- nos chat await/reply (loopback) --------+
Stop hook (project .claude/settings.json) -- drains queue -------------+
```
1. **Chat server** = spec as written, independent process (survives vite restarts, works without UI). Location: `.claude/skills/nos/cli/src/chat/` (`paths.js`, `sessions.js`, `server.js`, `guard.js`, `launch.js`, `ui.js`, `client.js`, `commands.js`, `hook.js`), ESM like the rest of the CLI, built-ins only.
2. **CLI**: expose as `nos chat <open|await|reply|typing|pending|end|stop|server>` subcommand in `cli/src/cli.js` instead of separate `harness-chat` bin. One permission rule, one tool. Output/next_step per spec.
3. **spec-ui integration** (dev mode only):
   - `src/chat-proxy.ts` (used by `serve-specs.ts`): same-origin routes, key fixed server-side, only the user's side of the API: `GET /__chat/state`, `POST /__chat/open` (runs `nos chat open --no-open`), `GET /__chat/events`, `POST /__chat/messages`, `POST /__chat/end`. Port read from `specs/.chat/server.json` per request. No EventSource CORS needed.
   - **Chat panel**: see *Chat UI* below.
   - Implementation in TS like other views: `src/chat.ts` (EventSource, send, presence), `src/views/chat.ts` (pure HTML render, `textContent`-safe insertion of messages, code-fence split). Hidden when `opts.canChat` false (standalone).
   - **Context-aware messages** (nos value-add): message carries current route (`domain/phase/step` from `parseRoute`) as prefix, e.g. `[context: specs/domain-3/phases/phase-1/step-2.md] …`. Toggleable chip in composer.
   - **Action shortcuts** on step/domain detail: "Ask Claude: specify / develop / review this step" → prefills composer with nos ability invocation. Reuses existing `[data-action]` delegation in `app.ts` → `onAction`.
   - Presence pill in header (listening / thinking / queued / not connected) even when drawer closed.
4. **Skill**: add ability `abilities/chat.md` (spec's SKILL text adapted to `nos chat`), listed in nos `SKILL.md`. `workflow.md` step "start spec-ui" also mentions chat.
5. **Setup**: nos `setup` ability writes into project `.claude/settings.json`: permission `Bash(node .claude/skills/nos/cli/bin/nos.js chat *)` (+ `nos chat *` if linked) and Stop hook `node .claude/skills/nos/cli/bin/nos.js chat hook` (relative to project root = cwd of Claude Code).

## Own sessions (runner, default) and tabs
The chat does not depend on a terminal session: the chat server answers every chat tab with its own headless
Claude Code session (`cli/src/chat/runner.js`).
- One tab = one chat session in the store (own key, own transcript) = one Claude Code session (`claudeSession` uuid).
- Per batch of queued messages: `claude -p --output-format stream-json --verbose --permission-prompts none
  --permission-mode auto --session-id <uuid>` (first run, plus `--name "nos chat: <title>"`) or `--resume <uuid>`,
  cwd = project root, prompt on stdin, `--append-system-prompt` with chat rules (short replies, no prompts possible).
  Env vars of a calling Claude Code session are dropped. Unmodified Claude Code with the user's own login.
- One run at a time per tab; messages sent meanwhile go into the next run. `tool_use` events become the activity line,
  `result` the reply; errors become a "⚠ …" reply. Stop kills the process tree (`taskkill /T` on Windows).
- Tab title = first message (40 chars); "✎ Rename" in the bar opens a full-width name field (phone-sized
  targets). Every tab has its own ✕ (asks only when it has messages or is running). A closed chat is never revived:
  "+" after the last tab was closed opens a fresh one. Opening the chat with no tab open starts one. Tooltip shows `claude --resume <uuid>`.
- Phone keyboard: the full-size dialog follows `visualViewport` (height and offsetTop), the page behind is locked
  (`html.chat-modal`), and `interactive-widget=resizes-content` in the viewport meta for Android.
- Presence in runner mode: thinking (run active), queued, ready.
- Project-wide event stream `/events-all`: `sessions` (tabs), `chat-sync`, `presence`, `activity`, `ended`, each
  with the key. Server API: `POST /api/sessions/new`, `POST /api/session/<key>/stop`, `.../title`.
- Config `"chat"` in `specs/config.json`: `runner` (default true), `permissionMode` (default `auto`), `model`, `claude`.
- `runner: false` = relay as before (terminal session with `await`/`reply`, Stop hook); in runner mode `/api/await`
  answers `runner` so a terminal session cannot take the messages.
- Risk accepted by the user: anyone holding a paired device can make Claude Code act in the project in auto mode.
- CLI version 0.2.0, so a running 0.1.0 server is replaced on the next `nos chat open`.

## LAN use (couch mode) + security
Goal: instruct agents from phone/tablet on home network via `npm run dev-to-lan` network URL. Anyone on the LAN who reaches the port could otherwise drive Claude Code (= shell on the machine), so LAN access is gated by a pairing token instead of a localhost restriction.
- Chat server itself stays on 127.0.0.1 with spec guard unchanged. **LAN entry point = vite proxy** (already LAN-bound via `--host`); proxy rewrites Host/Origin to loopback before forwarding.
- **Pairing token**: random 32-byte token created on first `nos chat open`, stored in state dir (`token` file, mode 600). `dev-to-lan` startup / `nos chat open` print network URL `http://<lan-ip>:5180/?pair=<token>`, plus QR code in terminal optional later.
- `GET /?pair=<token>` → vite middleware validates (constant-time compare), sets cookie `nos_chat=<token>; HttpOnly; SameSite=Strict; Max-Age=30d`, redirects to `/` (token gone from URL bar).
- Every `/__chat/*` request: loopback socket address AND loopback Host → allowed without cookie (Host alone is spoofable from the LAN); otherwise requires valid cookie, else 401 → drawer shows "Open the pairing link from the terminal".
- CSRF: mutating `/__chat/*` POSTs require `Origin` host == request `Host` (same-origin), else 403.
- `nos chat token --rotate` invalidates paired devices.
- Plain HTTP on LAN → token + messages readable by someone sniffing home Wi-Fi. Acceptable for home network; documented in Limits. (Later option: vite `server.https` with self-signed cert.)
- No Claude token/credential reads (spec rule).
- Permission prompts still only in terminal (spec limit) → on couch, page shows "thinking" forever. Recommend pre-allowing the tools nos abilities need in project settings; documented.

## Chat UI (desktop drawer, mobile dialog)
One component, `<dialog id="chat">` in `dev.html`. Layout and modality depend on screen width.
- **Header button** `#chat-toggle` in `.right`: chat icon + presence dot (green = listening, pulsing = thinking/typing, amber = queued, grey = not connected, red = server offline/unpaired). Badge with count of unread agent replies when panel closed. Always visible, so presence is readable while browsing.
- **Desktop (> 860px)**: `dialog.show()` (non-modal). Fixed right drawer, ~420px, resizable by drag handle (width in localStorage). `#main` gets `margin-right` so board stays usable next to it. Open/closed state persisted in localStorage (try/catch).
- **Phone/tablet (≤ 860px, same breakpoint as the existing layout)**: `dialog.showModal()`. Full size (`inset:0`, `100dvh`). Own top bar: back arrow "specs", presence label, End-chat in overflow menu. Composer pinned to bottom, `env(safe-area-inset-bottom)`, textarea font 16px (no iOS zoom). `visualViewport` resize keeps the composer above the keyboard. Enter = newline on touch devices, explicit Send button (desktop: Enter sends, Shift+Enter newline).
- **Back button**: opening on mobile does `history.pushState({chat:true}, '', location.hash)`; `popstate` closes the dialog, so the Android/iOS back gesture closes chat instead of leaving the page. Esc closes on desktop.
- **Breakpoint change** (rotate, resize) while open: close and reopen in the right mode, keeping the draft.
- Same-origin `EventSource('/__chat/events/<key>')` stays connected while closed (for presence + unread badge); reconnects by itself.
- Message log: user right, Claude left; text via `textContent` + `pre-wrap`; code fences as `<pre>`; stick-to-bottom within 40px; `role="status"` on activity bubble; reduced-motion respected.
- Context chip above the composer ("📎 step 1.2.3", tap to remove) and action shortcuts as described above. On mobile, step detail gets an "Ask Claude" button that opens the dialog prefilled.

## Files
- CLI: `cli/src/chat/*.js`, `cli/bin/nos.js` (async `chat` branch), `cli/src/cli.js` (usage, `nos help chat`), `cli/test/chat/{store,server,tool}.test.js`, `cli/README.md`
- skill: `abilities/chat.md`, `SKILL.md`, `workflow.md` (CHAT menu entry, chat rules), `abilities/setup.md` (step7: permissions + Stop hook)
- spec-ui: `src/chat-proxy.ts`, `src/chat.ts`, `src/views/chat.ts`, `src/serve-specs.ts` (routes, pairing print, `.chat` ignored by the watcher), `src/main.ts`, `src/app.ts` + `src/views/explore.ts` (`canChat`, "Ask Claude"), `dev.html` (header button), `styles.css`, `tests/chat.test.ts`, `tests/chat-proxy.test.ts`, `bundle/viewer.js` (rebuilt)
- `readSpecsFolder` already reads only `domain-*` folders, so `specs/.chat/` needed no change there.
- The chat server's own page (`cli/src/chat/ui.js`) stays as fallback at `http://127.0.0.1:<port>/chat/<key>`.

## Phasing
1. Chat server + store + guard + tests (spec, but state in `specs/.chat/`, port from config, `root` in `/health`).
2. `nos chat` CLI + ability + hook + settings via setup.
3. spec-ui: header button, desktop drawer, mobile dialog, proxy, `.chat` ignore.
4. LAN pairing token + cookie gate.
5. Context chips + action shortcuts.

## Verification
- `node --test` in `nos/chat` and `nos/cli` (spec test matrix).
- `npm test` + `npm run typecheck` in `ui/` (drawer render, key match, LAN refusal via fake req like `promote.test.ts`).
- Manual: Claude Code in `moodo-poc/`, run chat ability → `npm run dev` in ui → open drawer → message reaches parked await <1 s, reply appears without reload; key equals `nos chat` key; board does not reload on chat messages; phone: dialog full size, back gesture closes it, composer stays above keyboard; phone on same Wi-Fi opens pairing link → chat works; LAN request without cookie → 401; cross-origin POST → 403.
