# Runs, worktrees and the specs repo

Written against nos main `64fca4b` (2026-10-07); moodo-poc migrated the same day. Code is the source of truth; where docs differ see [22](#22-known-gaps--notes). Decision codes (D-n): see the end of [21](#21-rejected-alternatives).

`nos` below always means the literal call `node <home>/cli/bin/nos.js …` (see [7](#7-process-model)).

---

## 1. In plain words

In short: every piece of work gets its own copy of the code; the plans live in one shared place next to the project.

- nos = a Claude Code skill. It plans features ("plans", or single "quick steps") and lets AI agents specify, build, review them.
- Old problem: specs lived in the project repo. Every branch had its own stale copy. Two pieces of work at once = conflicts.
- New idea: each plan or quick step = a **run** = own git branch + own folder (git worktree) under `<project>/.claude/worktrees/`.
- Specs moved out: own git repo next to the project, `../<project>.specs`. One copy, all runs read and write it live.
- Several runs in parallel: one Claude Code session (terminal or chat tab) per run.
- You pick "run plan X" → nos makes branch + worktree, session moves into it, agents work there, code commits land on the branch.
- Before each build step: branch is rebased onto main. Conflicts → a merge agent resolves them by reading both specs.
- Done → `nos run finish`: one merge at a time (lock), full test gate, fast-forward into main. Then worktree + branch deleted.
- nos never pushes code. You push.
- Ports for e2e tests / dev servers: borrowed per command ("slots"), so parallel runs do not collide.
- A **POC** is a third kind of run: a throwaway branch to brainstorm in code, steered turn by turn. No spec, no status, never merged. It ends with a requirements list in `<specs>/pocs/`, then branch + worktree are deleted.
- You see it in the spec-ui: run badges (running / stale / awaiting cleanup), ahead/behind main, dirty worktree.
- All git mechanics live in the CLI. The AI only calls commands and reacts to exit codes.

---

## 2. Glossary

In short: the words used everywhere below.

| Term | Meaning |
|---|---|
| **run** | One plan (`plan-<domain id>`), one quick step (`quick-<step id>`) or one POC (`poc-<slug>`) in its own branch (same name) and worktree. Run file `<specs>/.runs/<run>.json`. |
| **POC** | Proof of concept run: no domain, no target, no statuses, never merged. The ability `poc` builds what the user asks turn by turn, commits `poc: …`, keeps notes in `<specs>/.runs/poc-<slug>.md`. Ends with `<specs>/pocs/poc-<slug>-result.md` (requirements + technical hints), which seeds a quick step or an idea. See [10](#10-run-lifecycle). |
| **worktree** | A git linked worktree: second checkout of the same repo, own branch. Here: `<main>/.claude/worktrees/<run>`. |
| **main checkout** (`<main>`) | The project folder you cloned. Its branch (`mainBranch`, usually `main`) moves only by `nos run finish` (exceptions: setup, architect, migration). |
| **work root** (`<work>`) | The checkout the caller sits in: `<main>` or a run worktree. |
| **specs root** (`<specs>`) | Own git repo with all specs, default sibling `../<project>.specs`. Outside every checkout. |
| **home** (`<home>`, `NOS_HOME`) | The nos folder the CLI runs from, `<main>/.claude/skills/nos`. |
| **token** | 8 hex chars minted by `nos run start`. Identifies the holder of a run. Required by every mutating run command. |
| **slot** | A lease on a port set: lock `slot-<n>`, `n` in `1..worktrees.slots`. Held only while e2e or a dev server runs. Child gets `NOS_SLOT=n`. |
| **gate** | `nos gate`: runs the configured quality tools (test, lint, format-check, typecheck, additional, e2e) and reports JSON. |
| **orchestrator** | The Claude Code session running `SKILL.md` + `workflow.md`. Delegates, never implements. One per run. |
| **ability / subagent** | A role file in `abilities/` (specify, develop, integrate, …). Runs in a fresh subagent (Agent tool), except `chat`. Inherits the session's cwd. |
| **quick step vs plan** | Quick step: single step, no phases, in `quick-steps/quick-steps.json`; finish is automatic after `done`. Plan: phases → steps in `plan.json`; finish only after the user says YES. |
| **integrate** | The merge-agent ability. Resolves a stopped rebase by the intent of both specs, then runs the gate. |
| **park** | The orchestrator stops and asks the user (GO / mode switch / REJECT / PAUSE / ABANDON). |

---

## 3. Why

In short: tracked specs broke parallel work; Claude Code's worktree sandbox forced the specs outside the project.

Problems with tracked `<project>/specs/`:
- every worktree had its own stale copy; specs merge-conflicted between branches
- a subagent could Grep the stale copy by accident
- spec commits moved main's ref → raced with merges (see rejected alternatives)
- `specs/config.json` mixed planning state (id counters, chat) with project config (tools, commands)

Goal: plans and quick steps run in parallel, each in branch + worktree; spec state central, live for all.

Constraints:
- **Solo**: one user, no team sync. But several orchestrators at once (chat tabs, terminals).
- **Portable**: clone nos into `<project>/.claude/skills/nos/` → works, whether the project tracks `.claude/` or not. No junctions, no machine paths in tracked files.
- **Subagents inherit cwd**: no per-subagent cwd/env. So the session itself must sit in the worktree.
- **Claude Code worktree isolation** (verified live 2026-10-06, docs `worktrees.md` "How Claude Code enforces isolation"): after `EnterWorktree` the session and its subagents may not Write/Edit/NotebookEdit inside the main checkout (also via junctions); Bash with cwd in main, git redirected into main (`git -C <main>`, `GIT_DIR`, `cd <main> && git`) and commands whose git target cannot be read from the text (computed names like `$NOS …`) are refused. A sibling folder outside the repo stays writable. → specs root outside the checkout (D-11).
- **Auto mode classifier**: denies force pushes (`--force-with-lease` after a rebase) and shell writes to shared resources outside the cwd. → nos never pushes code (D-6/D-12); specs written only with Write/Edit.

---

## 4. Layout on disk

In short: project repo holds code + one config file; sibling repo holds specs; dot folders are local state.

```
<parent>/
├── <project>/                         project repo (main checkout)
│   ├── nos.config.json                TRACKED. project config + root marker for the resolver
│   ├── .gitignore                     TRACKED. contains ".claude/worktrees/" (or a broader rule, e.g. ".claude/*")
│   └── .claude/
│       ├── skills/nos/                NOS_HOME (tracked or ignored; moodo: nested repo, ignored)
│       ├── settings.local.json        NEVER tracked. permissions + additionalDirectories (abs paths)
│       └── worktrees/                 ignored
│           ├── quick-7/               run worktree, branch quick-7 (code only, no specs)
│           └── plan-3/                run worktree, branch plan-3
└── <project>.specs/                   specs root: OWN git repo, branch main, local unless specs.remote
    ├── .gitignore                     ".chat/", ".locks/", ".runs/"
    ├── .gitattributes                 "* text=auto eol=lf"
    ├── config.json                    TRACKED (specs repo): project back-pointer, id-counters, chat
    ├── domain-<id>-<slug>/            TRACKED: idea.md, domain.json, plan.json, phases/, quick-steps/
    ├── pocs/                          TRACKED: poc-<slug>-result.md (POC results, kept after the POC)
    ├── .runs/                         local: <run>.json registry, poc-<slug>.md (POC notes) + logs/<run|main>/<tool>.log
    ├── .locks/                        local: merge/, runs/, ids/, slot-<n>/, reclaim-slot-<n>/
    └── .chat/                         local: sessions.json, server.json, server.log, tls/ (own .gitignore "*")
```

Rule: dot = local state (ignored), no dot = history (committed).

| What | Where tracked |
|---|---|
| code, `nos.config.json`, `.gitignore` | project repo |
| specs, `config.json` | specs repo |
| run files, locks, logs, chat state | nowhere |
| machine paths (permissions, hook) | `.claude/settings.local.json`, never tracked |

Why outside: worktree isolation (sec. 3). Why not nested: project `git status/clean` never see it, no ignore entry. Name `<project>.specs`: clean break from tracked `specs/`.

`spec-file` fields in `plan.json` / `quick-steps.json` are relative to `<specs>` (e.g. `domain-1-auth/phases/phase-1-a/step-2-b.md`). A value with `specs/` or `.specs/` prefix or absolute → exit 1 "legacy spec-file … run the migration" (`roots.js specFileOf`). Step ids are parsed from these paths (`/phase-<id>-…/step-<id>-…md`, `/quick-steps/step-<id>-…md`).

moodo-poc: `D:/development/repos/moodo-poc` + `D:/development/repos/moodo-poc.specs` (back-pointer `"project": "../moodo-poc"`).

---

## 5. Config split

In short: project config is versioned with code (a branch may change its test command); planning state exists once.

### `nos.config.json` (project repo, template `templates/nos.config.json`)

| Key | Default | Read from | Meaning |
|---|---|---|---|
| `specs.dir` | `null` | **main** | specs root, relative to main or absolute. `null`/empty = `../<main folder name>.specs` (built only in `roots.js defaultSpecsDir`, resolved every call, follows a renamed folder) |
| `specs.remote` | `null` | **main** | opt-in backup remote of the specs repo; `nos init` adds it as `origin`, `nos specs commit` pushes |
| `worktrees.slots` | `1` | **main** | number of slots (positive int) |
| `worktrees.slotWait` | `600` | **main** | seconds to wait for a free slot (fractions allowed) |
| `quality-tools.test/lint/format-check/typecheck/e2e` | `null` | **work** | commands; `null` = not configured |
| `quality-tools.additional` | `[]` | **work** | strings (named `additional-<n>`) or `{name, cmd}` (`name` `^[a-z0-9][a-z0-9-]*$`) |
| `quality-tools.timeout` | `30` | **work** | minutes per tool before it is killed |
| `project-commands.install/dev/deploy-test` | `null` | **work** | `nos exec` targets; `install` also run by `nos run start` in a new worktree |
| `spec-ui.docs-folder` | `"docs"` | **work** (spec-ui: main) | docs shown in spec-ui |

Missing sections/keys are merged with these defaults per section (`project-config.js readProjectConfig`). D-1: `specs`, `worktrees` from main's copy (`specsConfig`, `worktreesConfig`); `quality-tools`, `project-commands`, `spec-ui` from the work root's copy (`qualityTools`, `projectCommands`, `docsFolder`). So `nos run finish` gates with the **branch's** tools but the **main's** slot count.

### `<specs>/config.json` (specs repo, template `templates/config.json`)

| Key | Written by | Meaning |
|---|---|---|
| `project` | `nos init` | back-pointer: main relative to the specs root (`../moodo-poc`) |
| `id-counters.{domain,phase,step}` | CLI only (under lock `ids`) | next ids; global across domains |
| `chat.runner` | setup | `false` = relay mode (terminal answers); default true |
| `chat.port` | setup | chat server port, default 4611 |
| `chat.permissionMode` | setup | default `auto` |
| `chat.model`, `chat.claude` | setup | model, path of `claude` binary |

---

## 6. Roots resolution

In short: the CLI is the only place that computes paths; from anywhere (main, worktree, nos folder, specs root) it finds the same project.

`resolveRoots` (`cli/src/roots.js`), shared by CLI, chat and spec-ui. `nos roots` prints `{action:"roots", home, work, main, specs, inWorktree, configured}` (absolute, forward slashes). Internally also `git`, `offset`, `via`, `warnings`.

| Root | Resolution |
|---|---|
| `home` | folder of the running CLI (`import.meta.url` → `../..`), real path |
| `work` | `--root` (via `root`), else `NOS_SPECS_ROOT` (via `env`), else walk up from cwd to first folder with `nos.config.json` (via `walk`), else cwd (via `cwd`) |
| `main` | top of git's main worktree (`git rev-parse --path-format=absolute --git-common-dir --show-toplevel`; common dir `<top>/.git` → parent; submodule → first entry of `git worktree list --porcelain`) + `offset`. No git: = work |
| `specs` | `main` + `specs.dir` of **main's** `nos.config.json`, default `../<main basename>.specs` |
| `inWorktree` | git top of work ≠ main top |
| `offset` | project folder inside its repo (`''` unless monorepo subfolder) |
| `configured` | `nos.config.json` exists in work or main |

Walk details (`walkToWorkRoot`):
- starts at the real cwd (symlinks/junctions resolved), climbs parents
- folder with `nos.config.json` → work
- folder whose `config.json` has a string `project` + `id-counters` (a specs root) → validated back-pointer:
  - target folder must have `nos.config.json`, and that project's specs root must be this folder (real paths, case-insensitive on Windows)
  - valid → work = that project; invalid → walk stops, not set up, stderr `nos: warning: back-pointer of <dir> points to <main>, <why>: run nos init there`
  - a copied/moved/foreign specs root is never followed
- `--root` / `NOS_SPECS_ROOT` naming a specs root get the same check
- walk first, git second: nested repos (nos itself, a specs root) never answer with themselves
- walk climbed out of a linked worktree (branch has no `nos.config.json` yet) → brought back: work = that worktree top + offset

Monorepo offset: project in a subfolder of its repo → main = mainTop/offset; worktree project dir = `<wt top>/<offset>` (`worktreeProjectDir`). `nos run start` prints it as `enter`.

Guards (stderr, result unchanged):
- **home guard** (every command): `<main>/.claude/skills/nos` exists and ≠ home → `running <home>, but the project's nos is …`; home under `<main>/.claude/worktrees/` → `running a nos copy inside a worktree`.
- **specs guard** (`roots`, `init` only): specs root inside main → `specs root inside the checkout … worktree sessions cannot write it`.

Not set up: every command except `init`, `roots` → exit 1 `nos is not set up here: no nos.config.json …`.

---

## 7. Process model

In short: one Claude Code session per run, sitting inside the run's worktree; everything it spawns lands there.

```
session (terminal or chat tab), launched in <main>
   │ nos run start  → token, worktree
   │ cd <main> (if needed); EnterWorktree path=<worktree>
   ▼
cwd = <main>/.claude/worktrees/<run>[/<offset>]
   ├─ subagents (specify, develop, …)  inherit cwd → code commits on branch <run>
   ├─ nos gate / nos exec               run in the worktree, read its nos.config.json
   └─ specs: Write/Edit to <specs>/…   (additionalDirectories / --add-dir)
   │ nos run finish → merged
   │ ExitWorktree action=keep           (back to <main>)
   ▼ nos run cleanup                    (removes worktree + branch)
```

- Session starts in main. Settings, skills, hooks come from the launch dir and stay for the whole session, also inside a worktree without `.claude/` (verified live).
- `EnterWorktree path=` into `.claude/worktrees/…` works without prompt (verified). Any other path → approval prompt no rule suppresses; chat can't answer → worktrees must live there. EnterWorktree from a cwd outside the repo also needs approval → orchestrator first `cd <main>`.
- `EnterWorktree` accepts only a folder git knows as worktree → enter the worktree top; with offset, then `cd <enter>`.
- `ExitWorktree action=keep`: never removes a worktree entered by path. Then `nos run cleanup` deletes it. Order matters: Windows cannot delete a folder a process sits in (cleanup refuses when cwd is inside: exit 1).
- Resumed session (`claude --resume`, restarted chat process) returns to its worktree (verified). Token is in its transcript.
- One run per session (rule). One run per domain (enforced, exit 6).
- Chat tabs: one headless Claude Code process per tab, spawned in **main**, run enters worktree like a terminal session.
- No env var exposes the session id to Bash → token, not session id, is the holder.

Rules that follow (in `workflow.md` `<rules>`, repeated in each ability's `coreRules`, since subagents read only their ability file):

| Rule | Why |
|---|---|
| Call nos as literal `node <home>/cli/bin/nos.js …`, forward slashes, `home` verbatim from `nos roots`. No variable, function, alias, linked `nos` | isolation refuses computed command names; identical string → permission rule matches |
| Never `cd <main> && git`, `git -C <main>`, `GIT_DIR` from a worktree session. Git against main only inside nos commands (`run finish/cleanup/abandon`) | isolation blocks git redirected into main; CLI subprocess is not checked (its command text is a plain `node …` call) |
| Never `cd` into `<specs>` or outside `<work>` (before a run: `<main>`). Read outside with Read/Grep/Glob + absolute path | Bash cwd persists; isolation refuses Bash with cwd outside the worktree |
| Write `<specs>` files only with Write/Edit, never shell (`sed -i`, redirection, heredoc, python, `node -e`) | auto mode refuses shell writes outside cwd ("Modify Shared Resources"); Write/Edit allowed via additionalDirectories / `--add-dir` |
| Shell literal: no `$(…)`, backticks, variables where git runs or files change; one plain git command per call | isolation cannot verify the git target otherwise. Need a value → print it in one call, use it literally in the next |
| Never push | D-6/D-12 |
| Subagents never run git against `<specs>` | orchestrator owns spec commits |

---

## 8. Run registry & token

In short: one JSON file per active run; the token in it decides who may act on the run.

`<specs>/.runs/<kind>-<id>.json` (`cli/src/runs.js`), written atomically (tmp + rename). Example (moodo, values illustrative):

```json
{ "kind": "quick", "id": 7, "domain": "domain-28-orb-menu", "branch": "quick-7",
  "worktree": "D:/development/repos/moodo-poc/.claude/worktrees/quick-7",
  "base": "<sha of main the branch builds on>", "mainBranch": "main",
  "token": "<8 hex>", "started": "<iso>", "seen": "<iso>",
  "phase": "develop" }
```

| Field | Meaning |
|---|---|
| `kind`, `id` | `plan` + domain id (D-2), `quick` + step id, or `poc` + slug (a string). Run id regex `^(plan\|quick)-[1-9]\d*$` or `^poc-<kebab slug>$` |
| `domain` | domain folder; `null` for a POC |
| `branch` | `<kind>-<id>` (reused if it exists) |
| `worktree` | absolute, forward slashes |
| `base` | main sha the branch builds on; updated by every clean sync |
| `mainBranch` | main's branch at first start (detached HEAD → exit 1) |
| `token` | holder, 8 hex (`randomBytes(4)`) |
| `started`, `seen` | ISO; `seen` updated by every token-bearing call |
| `phase` | `develop` → `integrate` → `gate` → `merge` → `merged`, or `abandoned` |

Phases: `develop` normal work; `integrate`/`gate`/`merge` only inside `run finish` (a crash leaves them); `merged`/`abandoned` = over, waiting for cleanup. `plan.json` / the quick step entry get only `"branch"` (display, stays as history).

Token:
- minted by `run start` (only command that prints it, top-level `token`). Never in other results, lock holder output, `/__runs` or chat `run`.
- `--token <t>`, fallback env `NOS_RUN_TOKEN`. Missing → exit 1 `--token required`; another → exit 4 with `{run, started, seen, ageSec}`.
- `sync/finish/cleanup/abandon` pick the run: `--run <kind>-<id>`, else the run whose worktree contains the cwd, else the run holding the token (so `cleanup` from main needs just the token).
- `run start` with the same token → resume (no new run). With `--take-over` → new token minted (user decision only, choice TAKEOVER). Also works on merged/abandoned runs (token only, so cleanup can run).
- Take-over and the merge lock: lock held by the old token → released if its pid is dead; pid alive (old finish still running) → exit 4 `details.lock "merge"`, `pidAlive: true`.
- Cooperative guard against double pick, not security (solo).

Lock `runs`: `run start` does check-and-create under `<specs>/.locks/runs` (waits up to 10 s, then exit 4 `details.lock "runs"`). Install runs after release.

---

## 9. CLI commands

In short: the orchestrator calls these and reacts to the exit code; every result is JSON with absolute forward-slash paths.

Errors: one line on stderr `nos: <message>`. Exit 3–7 and some exit 1 (`run finish` gate fail / main busy / dirty / other branch / ff refused twice, marked `report`) also print `{action, error, exit, details}` on stdout. Lock holders are always printed without token. Usage errors (exit 2) add `Run "nos help <cmd>" for usage.`

| Command | Input | Does | Output `action` | Exit |
|---|---|---|---|---|
| `nos init [--root]` | — | creates missing: `nos.config.json` (template), specs root, `config.json` (+ back-pointer), `<specs>/.gitignore`, project `.gitignore` entries, `git init -b main` + `.gitattributes` + commit `nos: init` (no HEAD yet), `origin` = `specs.remote`. Idempotent | `init` {main, specs, created, existing, gitignoreAdded, backPointer{project,written}, commit, remote} | 0, 1 (in worktree, not repo top, inside nos folder, git identity missing) |
| `nos roots [--root]` | — | prints roots, guards | `roots` | 0 |
| `nos run start --domain <d> (--plan \| --quick <id>) [--token] [--take-over]` | domain, target | validate target (plan with phases / quick step; not merged/discarded), held check, one-per-domain check, commit specs leftovers `<run>: leftovers`, `git -c core.longpaths=true worktree add` (reuse branch or `-b <run> <worktree> <mainBranch>`), run file, `branch` in target, `install` into `logs/<run>/install.log` when worktree was created | `run-start` {run, token, roots{home, work=enter, main, specs}, enter, install{code,log[,error]}\|null, leftovers{committed,sha,files}\|null, warnings?} | 0, 1, 2, 4, 6 |
| `nos run start --poc <slug> [--token] [--take-over]` | slug (kebab, ≤ 40 chars, else 2; not with `--domain/--plan/--quick`) | as above without target, domain check, leftovers and `branch`: held check, worktree add, run file (`domain: null`), install. New POC with an existing result `pocs/poc-<slug>-result.md` → 1 | `run-start`, same shape (`run.kind "poc"`, `run.id "<slug>"`) | 0, 1, 2, 4 |
| `nos run sync --token` | — | stopped rebase → 3; dirty (incl. untracked) → 5; not on branch → 1; `git -c core.editor=true rebase --no-autostash <mainBranch>` (`GIT_EDITOR=true`); conflict → 3 left open; ok → `base` updated | `run-sync` {run, base, ahead, behind, rebased} | 0, 1, 3, 4, 5 |
| `nos run finish --token` | — | merge protocol, sec. 11; a POC → 1 "never merged" | `run-finish` {run, merged, mainBranch, head, resumedFrom, gate, statuses, specs{committed,sha}} or {merged, already:true} | 0, 1, 3, 4, 5, 7 |
| `nos run cleanup --token` | — | phase merged/abandoned; not from inside worktree; worktree remove (merged: untracked → force, modified tracked → 5), `worktree prune`, `branch -D` (merged: only if in mainBranch), run file + notes (`.runs/<run>.md`) delete, own merge lock released. Parts already gone skipped | `run-cleanup` {run, removed{worktree,branch,runFile,notes?}} | 0, 1, 4, 5 |
| `nos run abandon --token` | — | refuses merged, and phase `merge` with branch already in main; not from inside worktree; `set-status --run discarded`, specs commit `<run>: discarded` (POC: neither, `statuses`/`specs` null), phase `abandoned`, then cleanup with `--force` / `-D` | `run-abandon` {run, removed, statuses, specs} | 0, 1, 4 |
| `nos gate [--e2e]` | — | sec. 14 | `gate` {pass, tools[], reclaimed?} | 0, 1, 7 |
| `nos exec <install\|dev\|deploy-test>` | name | runs the work root's command in a shell, stdio inherited, no JSON; `dev` under a slot lease | (raw) | command's code, 130/143 on SIGINT/SIGTERM, 1 not configured, 2 unknown name, 7 |
| `nos specs commit (--run <r> \| --domain <d> \| --config) -m <msg>` | exactly one target | sec. 15; `--run poc-<slug>`: only `pocs/poc-<slug>-result.md`, no run file needed; result neither on disk nor tracked → 1 | `specs-commit` {domain, poc?, committed, sha, pushed, files, warning?} | 0, 1, 2 |
| `nos poc results` | — | lists `<specs>/pocs/poc-<slug>-result.md` (front matter parsed: BOM, `# comment`, quotes ignored); `state` from one `git status -- pocs` in the specs repo | `poc-results` {results[{slug, run, title, processed, state (committed\|draft\|null), runExists, file}], warnings?} | 0, 2 |
| `nos poc processed <slug> --as <what>` | `no`, `dropped`, `quick <id>`, `idea <domain>` | sets `processed` in the result's front matter (line endings kept; none → prepended) | `poc-processed` {slug, run, file, previous, processed} | 0, 1 (no file), 2 |
| `nos specs find-step <id>` | step id | scans `domain-*/plan.json` + `quick-steps/quick-steps.json` | `find-step` {id, domain, kind, phase, step, slug, intent, status, specFile, warnings?} | 0, 1 not found, 2 bad id |
| `nos set-status --run <kind>-<id> merged\|discarded [--token]` | run, status | sec. 17; token required while the run file exists; `poc-*` → 1 (no statuses) | `set-status` {run, domain, status, file, changes} | 0, 1, 2, 4 |
| `nos set-status --domain <d> [--phase] [--step] --status <s>` | | normal status change; `merged`/`discarded` refused (1) | `set-status` | 0, 1, 2 |
| `nos lock take <name> --token [--run] [--wait <sec>]` | | mkdir lock, reentrant per token | `lock-take` {lock, path, holder, reentrant} | 0, 2, 4 |
| `nos lock release <name> (--token \| --break)` | | holder's token only, or `--break` (user's call) | `lock-release` {lock, path, released, broken, holder} | 0, 2, 4 |
| `nos lock status [<name>]` | | one lock or all (`{locks:[…]}`) | `lock-status` {lock, path, held, holder, ageSec, pidAlive} | 0, 2 |
| `nos chat …` | | separate entry (`bin/nos.js` → `chat/commands.js`), errors `{error}` exit 1 | — | 0, 1 |

`run start` exit 1 cases: no git, no plan.json, plan without phases, quick step unknown, target merged/discarded, run file of another domain, detached main, worktree path exists but is no worktree, `git worktree add` failed (Windows "Filename too long" hint: `core.longpaths`). Exit 4: run held by another token; take-over while old finish runs; lock `runs` held 10 s. Ids-reserving commands (`create-domain`, `create-plan`, `update-plan`, `create-quick-step`): exit 4 when lock `ids` held 10 s.

### Exit codes and orchestrator reaction (`workflow.md <exitCodes>`)

| Code | Name (`exit-codes.js`) | Meaning | Orchestrator does |
|---|---|---|---|
| 0 | OK | ok | continue |
| 1 | FAILED | failed | park, report. From `run finish` → cycle finish step2: gate fail → FIX (develop resume, commit `step-<id>: gate fix`, specs commit, repeat) / PAUSE / ABANDON; main busy / dirty / other branch / ff refused twice → park, GO repeats after user fixed main. From `run cleanup` "a process … still uses <wt>" → user stops it, repeat |
| 2 | USAGE | bad call | fix the call, never guess |
| 3 | CONFLICT | rebase conflict (sync, finish) | ability integrate → pass: `nos specs commit --run <run> -m "<run>: integrate"`, repeat command; blocked → DECIDE (rerun integrate with decision) / PAUSE / ABANDON |
| 4 | HELD | run held (no `details.lock`) | report holder + age → TAKEOVER (`run start … --take-over`, POC: `run start --poc <slug> --take-over`; keep new token, repeat) / STOP |
| 4 | | `--take-over`, `details.lock merge`, `pidAlive true` | wait 60 s, repeat, max 10×, then park |
| 4 | | `details.lock ids` or `runs` | wait 60 s, repeat; twice more → park (`--break` is the user's) |
| 4 | | from `run finish`, `details.lock merge` | wait 60 s (Monitor or sleep), repeat finish, max 10×, then park |
| 5 | DIRTY | dirty worktree | tracked modified + untracked files named in current step's Task List / Dev Log → `git add -- <files>`, `git commit -m "step-<id>: leftovers"` (phase: `phase-<id>: leftovers`), repeat. Anything else → park "add to .gitignore or delete". Never `git add -A`. From `run cleanup` → park, user reverts/deletes, GO repeats |
| 6 | DOMAIN_RUNNING | another run in the domain | plan start: SWITCH / STOP; quick start: WAIT / STOP |
| 7 | SLOT_TIMEOUT | no slot within `slotWait` | park "other runs hold every slot" (develop: report blocked) |

---

## 10. Run lifecycle

In short: start → enter → work (sync before every develop) → done → finish → leave → cleanup. Or abandon. Crashes resume by phase.

```
           nos run start ──(4/6)──► ask user
                 │ token
     cd <main>; EnterWorktree path=<wt>; nos roots; read run file
                 │
                 ▼
  ┌───────── cycle "step" (per step) ───────────────────────────┐
  │ specify + spec-review ─► specs commit "step-<id>: specify,   │
  │                                         spec-review"         │
  │ nos run sync ─(3)─► integrate ─► specs commit "<run>: integrate"
  │ develop (code commit "step-<id>: …") ─► specs commit         │
  │ review-pessimistic, review-fixing ─► specs commit each       │
  │ status done                                                  │
  └──────────────────────────────────────────────────────────────┘
                 │ quick: automatic │ plan: user YES
                 ▼
          nos run finish ──(1/3/4/5/7)──► react, repeat
                 │ phase merged, statuses merged
     ExitWorktree action=keep; nos run cleanup; nos roots
                 ▼
             back in main, next run

  any park ─► PAUSE: plan → on-hold, specs commit "<run>: pause", ExitWorktree keep. Run stays.
           └► ABANDON (confirm): ExitWorktree keep, nos run abandon, nos roots.
```

Details (`workflow.md` option "run" step2, cycles "step"/"finish"):
1. **Start**: `nos run start --domain <d> --plan|--quick <id>` (+ `--token` if the session holds one). `install` failure or `warnings` (e.g. worktree not ignored) → report, continue.
2. **Enter**: cwd not main → `cd <main>` (own call). `EnterWorktree path=<run.worktree>`. Denied → `cd <main>`, retry once → denied again → park with run id + token. Never continue outside. `enter` ≠ worktree (offset) → `cd <enter>`, pass as work.
3. **Roots + run file**: `nos roots` → home, work, specs; read `mainBranch`, `base`.
4. **Rebase check** (phase develop): `nos run sync`. 3 → integrate, sync again. 5 → continue, commit nothing (an interrupted ability finishes its own work).
5. **Steps**: as before, in the worktree. Before every develop (`cycle step` step3, not when resuming at `in-progress`): `nos run sync`. Conflicts surface early, per step, small.
6. **Done**: code only on the branch.
7. **Finish**: `nos run finish --token`. Quick step: automatic after done. Plan: question "Integrate it into main now?" YES/NO (NO: run stays, RUN offers it again).
8. **Leave + cleanup**: `ExitWorktree action=keep`, `nos run cleanup --token`, `nos roots`.

Pause/resume: run, worktree, branch stay. RUN/QUICK list shows "running" + phase + age, "cleanup pending" for merged/abandoned phases. Statuses are never reset on resume; a resumed session inside its worktree skips `run start`, always runs roots + run file + rebase check.

Crash recovery (option run step2):

| Situation | Detected by | Action |
|---|---|---|
| cleanup pending | status merged/discarded, phase merged/abandoned | ExitWorktree keep if inside, `nos run cleanup` (no token → TAKEOVER first) |
| finish crashed | status merged, phase merge | `nos run finish` (resumes) |
| finish crashed before ff | phase integrate/gate/merge, lock held by own token | finish reruns under its own lock (reentrant) |
| abandon crashed | status discarded, phase not abandoned | `nos run abandon` |
| cleanup half done | parts missing | rerun cleanup, gone parts skipped |
| worktree folder deleted by hand | sync/finish exit 1 "worktree … missing" | `run start --token` recreates it (prunes, re-adds, reinstalls) |
| uncommitted specs of a dead session | `run start` | commits them `<run>: leftovers` |
| stopped rebase | sync exit 3 `rebaseInProgress` | integrate first |
| session without token | exit 4 | TAKEOVER (user) |
| stale lock / run file | exit 4 with age / spec-ui "stale" | never auto-broken; user: `--take-over` or `nos lock release <name> --break` |

### POC lifecycle (`workflow.md` option "poc")

```
  POC menu ─► NEW: name → slug ─► nos run start --poc <slug> (token)
     cd <main>; EnterWorktree; nos roots; orchestrator guardrails
                 │
  ┌──── turns (ability "poc", one live subagent) ────────────────┐
  │ user message ─► subagent: code, commit "poc: <what>",        │
  │                 one notes line in .runs/poc-<slug>.md          │
  │ options: DEPLOY (nos exec deploy-test) │ END │ CONTINUE/free text │
  └──────────────────────────────────────────────────────────────┘
                 │ END
  subagent writes <specs>/pocs/poc-<slug>-result.md ─► APPROVE / CHANGE (loop)
                 │ APPROVE: nos specs commit --run poc-<slug> -m "poc-<slug>: result"
                 ▼
  QUICK │ IDEA │ LATER │ DROP
   QUICK/IDEA: ExitWorktree keep → option quick (step2) / idea with the result as input → quick step / domain created
   QUICK/IDEA/DROP: nos poc processed <slug> --as "quick <id>"|"idea <domain>"|dropped,
                    nos specs commit --run poc-<slug> -m "poc-<slug>: processed", nos run abandon --token
                    (worktree, branch, run file, notes deleted; result kept)
   LATER: ExitWorktree keep; run + worktree stay; IDEA and QUICK offer the result (USE <slug> / NO)
```

- No mode question, no statuses, no specs commits after turns, never `run finish` (exit 1). `run sync` works but is not called by the workflow.
- Any number of POCs at once, next to any plan or quick run (no domain).
- Draft vs committed: `nos poc results` reports `state` (`draft` = not committed yet, `committed` = approved). Resume (option "poc" step7, also a session starting inside a POC worktree via `<start>`): committed + `processed: no` → hand-over; draft → APPROVE/CHANGE; processed or phase abandoned → only the abandon/cleanup part; no result → the turn loop with a new `poc` subagent told "resume" plus the next message (it reads its notes). Same when SendMessage fails mid-POC. No token → TAKEOVER (`run start --poc <slug> --take-over`). IDEA/QUICK offer only committed, unprocessed results.
- Turn and result questions also offer PAUSE (ExitWorktree keep, run stays) and ABANDON (confirmed: the DROP path; no result file → only `run abandon`). A one-word `pause`/`abandon`/`drop` counts as the choice; any other free text is the next turn (or the change).
- Guardrail proposals are never applied inside a POC worktree (its branch dies): the orchestrator leaves it first and asks them on main.
- Before `run abandon` the orchestrator stops a dev server the `poc` subagent started; at `end` the subagent stops its own processes.
- A result whose run file is gone (cleaned up by hand) is still offered and processed; there is just nothing to abandon (`specs commit --run poc-<slug>` needs no run file).

---

## 11. Merge protocol

In short: merges happen one at a time under a lock; each re-checks main, rebases, runs the full gate, then fast-forwards. Developing stays parallel.

Why a lock: git protects the ref, not the workflow. Two finishes seconds apart → second is no ff, must rebase and re-gate. Gate is slow → serialize the whole integrate phase.

`finishRun` (`cli/src/run.js`):

```
orchestrator (in worktree)        nos run finish                        main checkout / specs
──────────────────────────        ─────────────────────────────────    ─────────────────────
nos run finish --token ─────────► resolveRun (token, seen)
                                  phase merged? → {already:true}, exit 0
                                  target status done (or merged+phase merge)? else exit 1
                                  set-status --run merged (dry run) → violations exit 1
                                  takeLock merge (no wait) ── held by other token → exit 4
                                  ┌ loop (attempt 1..2), unless phase merge && branch in main
                                  │ phase integrate
                                  │ main on mainBranch?      ───────► else 1 (report)
                                  │ main busy? MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
                                  │   rebase-merge/, rebase-apply/ ─► 1 (report, details.busy)
                                  │ main dirty on paths branch touches
                                  │   (diff main...branch, --no-renames) ► 1 (report, files)
                                  │ sync: rebase in progress → 3, dirty → 5, conflict → 3
                                  │ phase gate (base updated)
                                  │ runGate(worktree roots, e2e if branch config has e2e)
                                  │   fail → 1 (report, details.gate); no slot → 7
                                  │ phase merge
                                  │ git merge --ff-only <branch>  ───► main moves
                                  │   refused: attempt 1 → loop; attempt 2 → 1 (report)
                                  └
                                  set-status --run merged ────────────► plan.json / quick-steps.json
                                  specs commit "<run>: merged" ───────► specs repo
                                  phase merged
                                  release merge lock (finally)
◄──────── exit 0 JSON ────────────
ExitWorktree keep; nos run cleanup
```

- Any failure before the ff: lock released, phase back to `develop` (run parked), error reported.
- Failure after the ff (branch in main): phase stays `merge`; rerun completes statuses + commit.
- A hard crash (process killed): lock + phase stay; same token re-takes the lock (reentrant) and resumes. `resumedFrom` = phase found at start.
- Ff refused cannot normally happen under the lock (only a manual main commit); one retry with sync + gate, then exit 1.
- Statuses flip for the whole branch, so spec-only steps without code commit flip too.
- Dirty worktrees are refused, never autostashed (stash hides state from integrate, pops into silent conflicts).
- First done, first merged; others pick up main at their next sync.
- D-5: finish gate includes e2e when `quality-tools.e2e` is set in the branch's config.
- Git in main runs as subprocess with cwd = main top (`spawnSync('git', …, {cwd})`), env without `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`.

---

## 12. Integrate ability

In short: when a rebase stops on conflicts, this agent reads the specs of both sides and resolves by intent; contradiction → asks you.

`abilities/integrate.md`. Only ability that continues a rebase. Input: home, work, specs, the run file (kind, id, domain, branch, base, mainBranch). Optional: conflict list from the nos output (else `git diff --name-only --diff-filter=U`), the user's decision which intent wins.

Workflow:
1. Rebase check, two plain calls: `git rev-parse --absolute-git-dir` → then `ls -d <path>/rebase-merge <path>/rebase-apply` (path typed literally). Neither → "no rebase in progress", done. Not `REBASE_HEAD` (git leaves it after a finished rebase).
2. Their side: `git log <base>..<mainBranch> --format=%s` → prefixes. `step-<id>:` → `nos specs find-step <id>` → spec file. `phase-<id>:` → phase in `<specs>/domain-*/plan.json` (Grep with path `<specs>`). `architect:` / `setup:` → no spec, message + diff are the intent.
3. Own side: `git log -1 --format=%s REBASE_HEAD` → same prefix handling. Read Description, ACs, Dev Log of both.
4. Resolve each file by both intents. User decision given → wins. Contradicting specs, no decision → stop, rebase left open, report blocked citing both spec files and ACs.
5. `git add` resolved files, `git -c core.editor=true rebase --continue`. Next stop → step 3 again.
6. `nos gate` (`--e2e` if an involved Test Strategy names e2e). Merge-caused fail → fix (failing test first where behavior changes), commit code only `<prefix> merge fix` (prefix of the step whose code the fix changes, else of the last replayed commit). Not fixable → blocked.
7. Dev Log of own step, under `### What I did`: one entry per conflict marked `(merge)`: file, both intents, resolution, other step id.
8. Verdict pass / blocked.

Forbidden: `rebase --abort/--skip`, reset, stash, touching main, merge, push, changing a test to pass. Only place where two specs are read together.

Orchestrator: pass → specs commit `<run>: integrate`, repeat the sync/finish. Blocked → DECIDE / PAUSE / ABANDON.

---

## 13. Slots & ports

In short: a slot is a numbered port set borrowed only while e2e or a dev server runs; the project shifts its ports by `NOS_SLOT`.

`cli/src/slots.js withSlot`:
- Lock `slot-<n>`, n in `1..worktrees.slots` (main's config, default 1). Smallest free wins.
- Holder `{run, token (random), pid, command: "gate e2e" | "exec dev", taken}`.
- None free → poll every 2 s up to `slotWait` s (default 600) → exit 7, details `{slots, slotWait, holders}` (gate adds `tools`, `pass` so far).
- Released when the command settles (also on throw / Ctrl+C).
- D-4: in `nos gate --e2e` the lease wraps **only the e2e tool**, not the whole gate. `nos exec dev` holds it until the server exits.
- D-10: lease whose holder pid is dead (killed hard) → reclaimed by the next taker. Guard lock `reclaim-slot-<n>` makes check-and-remove exclusive; a dead reclaimer's guard is removed for the next try. Reported as `reclaimed {slot, holder}` (gate JSON; exec: stderr). Only slot leases; merge/ids/runs locks and run files never.
- Child env: `NOS_SLOT=<n>` (inherited `NOS_SLOT` removed first), `NOS_HOME=<home>`.
- Develops never wait on slots; only e2e and dev servers queue. `slots: 1` serializes e2e instead of refusing.
- Setup: proposes `slots: 3` when e2e configured, else 1; verifies by starting `nos exec dev` once per slot in parallel and requesting each url.

Project side (moodo):
- `vite.config.ts` `slotPorts()`: `NOS_SLOT` set → dev `5173 + slot`, preview `4173 + slot`, `strictPort: true`; unset → 5173/4173 non-strict. Non-integer → throws.
- `playwright.config.ts`: preview port `4173 + slot` (unset = 0), `webServer` `npm run preview -- --port <port> --strictPort`, `baseURL` same port, `reuseExistingServer` only for slot 0 and not CI.
- With `slots: 3`: nos slots 1..3 → dev 5174–5176, preview 4174–4176. Human `npm run …` without `NOS_SLOT` keeps 5173/4173.

---

## 14. Quality gate

In short: one command runs all configured checks in a fixed order, always all of them, logs everything, returns JSON.

`cli/src/gate.js runGate`:
- Tools from the **work root's** `quality-tools`, order: `test`, `lint`, `format-check`, `typecheck`, each `additional`, then `e2e` (only with `--e2e`, or in `run finish` when configured).
- Every tool runs even after a failure. Each in a shell, cwd = work root, env + `NOS_HOME` (+ `NOS_SLOT` for e2e).
- Log: `<specs>/.runs/logs/<run>/<tool>.log` (`<run>` = given run, else run of this worktree, else `main`). stdout + stderr interleaved.
- Result tail: last 60 lines.
- Timeout: `quality-tools.timeout` minutes (default 30) per tool → process tree killed (`taskkill /T /F` on Windows, process group elsewhere), `status fail`, `timedOut: true`.
- Ctrl+C / SIGTERM: kills running tool tree, releases lease, exit 1 `gate interrupted by <signal>`.
- No command configured at all (e2e counts only with `--e2e`) → exit 1 "quality tools are not set up … Run setup" (no JSON).

```json
{ "action": "gate", "pass": false,
  "tools": [
    { "name": "test", "cmd": "npm test", "status": "fail", "exit": 1, "signal": null, "timedOut": false,
      "tail": "<last 60 lines>", "log": "D:/…/moodo-poc.specs/.runs/logs/quick-7/test.log" },
    { "name": "e2e", "cmd": null, "status": "not-configured", "exit": null, "signal": null,
      "timedOut": false, "tail": "", "log": null } ],
  "reclaimed": { "slot": 2, "holder": { … } } }
```

`status`: `pass` / `fail` / `not-configured`. `pass` = no tool failed. Exit 0 pass, 1 a tool failed (JSON still printed), 7 no slot.

Why a gate instead of running tools directly: only nos reads the right `nos.config.json` (branch's), takes the slot and sets `NOS_SLOT`, keeps logs out of the worktree, enforces timeouts. Rule for abilities: project commands only via `nos gate` / `nos exec`; exception: a single unit/integration test file directly with the test runner (no ports).

`--e2e` by abilities: when the step's Test Strategy says e2e yes or lists an existing e2e test (develop, reviewers, integrate). Setup gates without `--e2e`.

---

## 15. Specs repo & commits

In short: only the orchestrator commits specs, through one CLI command scoped to one domain; agents commit only code, with a step prefix; nothing is pushed except an optional specs backup.

`nos specs commit` (`cli/src/specs-git.js commitSpecs`):
- Target, exactly one: `--run <r>` (domain of the run file), `--domain <d>` (D-3, outside runs), `--config` (config.json only). `--run poc-<slug>`: only `pocs/poc-<slug>-result.md` (no `config.json`, no run file needed).
- Asserts the specs root is the top of its own repo (git never reaches the project repo) → else exit 1 "Run nos init".
- `git add -- config.json [<domain>]` (adds, changes, deletions inside them; never `-A`), `git diff --cached --name-only`, then `git commit -q -m <m> --only -- <paths>` only when something is staged (`--only`: files another writer staged stay out).
- Every git call: `-c commit.gpgsign=false -c core.hooksPath=` (no hooks, no signing), env `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`.
- Lock contention (`index.lock`, `HEAD.lock`, ref locks) → retry 5×, 200 ms apart.
- `specs.remote` set → `git push -q -u origin HEAD` after a commit, or when HEAD is ahead of / has no upstream. Fail or > 60 s → `warning` (stderr + result), commit stays. The only push nos ever makes (D-6/D-12).
- Exact scoping works because one domain has at most one run. `config.json` always rides along (id counters, chat).

Who commits what:

| Who | Repo | Message |
|---|---|---|
| orchestrator, after each ability in a run | specs | `step-<id>: <ability>`, phase abilities `phase-<id>: <ability>`, specify + spec-review as one `step-<id>: specify, spec-review` |
| orchestrator, integrate / pause / gate fix | specs | `<run>: integrate`, `<run>: pause`, `step-<id>: gate fix` |
| orchestrator, POC | specs | `--run poc-<slug>`: `poc-<slug>: result`, `poc-<slug>: processed` (only the result file) |
| orchestrator, outside runs | specs | `--domain`: `idea: <domain>`, `plan: <domain>`, `plan: revise <domain>`, `quick-step: step-<id>` (skipped when the domain has a run file; that run's next commit picks it up); `--config`: `setup: chat`, `setup: back-pointer` |
| CLI | specs | `nos: init`, `<run>: leftovers` (run start), `<run>: merged` (finish), `<run>: discarded` (abandon) |
| develop | project (worktree) | `step-<id>: <what>`, `step-<id>: gate fix` |
| review-fixing | project (worktree) | `step-<id>: <what>` / `phase-<id>: <what>` |
| integrate | project (worktree) | rebase continue, `<prefix> merge fix` |
| orchestrator on exit 5 | project (worktree) | `step-<id>: leftovers` / `phase-<id>: leftovers` |
| poc | project (POC worktree) | `poc: <what>`, never merged, deleted with the branch |
| architect | project (cwd) | `architect: <what>`; from main → directly on main (D-7 exception) |
| setup | project (main) | `setup: <what changed>`, only `nos.config.json` + `.gitignore` (D-7 exception) |

Rules: never `--domain` for a domain with a run file (would commit that run's edits). Subagents never commit specs; code commits never include spec files. Status changes ride in the next specs commit.

Code ↔ spec link: by subject prefix (`step-<id>: `, `phase-<id>: `, `architect: `, `setup: `, colon included, exact match: `step-3` ≠ `step-30`), not SHA. SHAs change on rebase, prefixes survive. review-pessimistic finds its changes via `git log <mainBranch>..HEAD` + prefix; review-fixing's "### Fixes" cites the prefix, never a sha.

---

## 16. Concurrency & locking summary

In short: mkdir-based locks under `<specs>/.locks`; runs are one file each; nothing is ever broken automatically except dead slot leases.

Lock mechanics (`cli/src/lock.js`): `mkdir <specs>/.locks/<name>` (atomic, one winner) + `holder.json {run, token, pid, command, taken}` written atomically. Same token → reentrant (refreshes pid, taken; re-reads to detect a concurrent break). Missing `holder.json` = taker mid-write → others wait ≥ 1 s grace. Windows EPERM/EACCES during a release → treated as held, retried. Name regex `^[a-z0-9][a-z0-9-]*$`.

| Lock | Taken by | Wait | Holder token | On contention |
|---|---|---|---|---|
| `merge` | `run finish` (whole protocol) | none | run token | exit 4; orchestrator waits 60 s ×10 |
| `runs` | `run start` (check + create) | 10 s | random | exit 4 |
| `ids` | every id reservation (`reserveIds`) | 10 s | random | exit 4, hint `nos lock release ids --break` |
| `slot-<n>` | `gate --e2e` (e2e only), `exec dev` | `slotWait` | random | exit 7 |
| `reclaim-slot-<n>` | slot reclaim guard | none | random | skip |

Never auto-broken: `merge`, `runs`, `ids`, run files. User: `nos lock release <name> --break`, `nos run start --take-over`. Auto: dead slot lease (D-10), take-over releases the merge lock of the old token if its pid is dead.

Races handled:
- two starts of one target/domain → lock `runs` + domain scan (exit 6)
- two id reservations → lock `ids`
- two finishes → lock `merge`; second waits, rebases onto new main, re-gates
- spec commits vs merges → different repos, never the same ref
- two spec commits → git lock retry, `--only`, domain-scoped paths
- run file writers → one file per run, token check, atomic writes
- spec-ui readers → atomic JSON writes (`writeJsonFile`)
- a lock broken and retaken mid-command → release ignores a lock no longer ours

---

## 17. Statuses

In short: two new end statuses, set only by the CLI for a whole run.

`templates/status.xml`: plans and steps gain `merged` (branch is on main, only `nos run finish`) and `discarded` (run abandoned, only `nos run abandon`). Phases: none (a merged plan shows via the plan). Plan `done` = all phases done on the branch, not yet merged.

`nos set-status --run <kind>-<id> merged|discarded` (`status.js setRunStatus`), one write per file:

| Run | Status | Transition |
|---|---|---|
| plan | merged | plan `done → merged`, every step `done → merged`; phases unchanged |
| plan | discarded | plan and every step not merged → `discarded`; already-merged steps stay merged |
| quick | merged | quick step `done → merged` |
| quick | discarded | quick step (anything except merged) → `discarded` |

Targets already at the status stay (idempotent for crash reruns). Any violation (e.g. a step not done for merged) → exit 1 `{violations}`, nothing written. Finish runs it as dry run before taking the lock. Domain comes from the run file, else the `domain-<id>-*` folder / the quick-steps scan. Token required while the run file exists. Only callers: finish, abandon. Workflow forbids the orchestrator to call it; normal `set-status` refuses both statuses (exit 1). `run start` refuses targets that are merged/discarded.

---

## 18. Chat integration

In short: the local chat (spec-ui / phone) runs one Claude Code session per tab, started in main; a tab learns its run from its own `nos run` output.

- One chat server per project (default port 4611, `chat.port`), started from home. All worktrees share main's chat: `chatRoots` resolves to `roots.main`, requires `<main>/nos.config.json`.
- State dir `<specs>/.chat/` (`NOS_CHAT_STATE_DIR` for tests), own `.gitignore` `*`: `sessions.json`, `server.json`, `server.log`, `tls/`.
- Session key: sha256 of the real main path (+ NUL + tab name `t-<8 hex>`), first 12 hex.
- Runner mode (default): per tab `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompts none --permission-mode <auto> (--session-id|--resume) <uuid> [--name "nos chat: <title>"] [--model] --add-dir <specs> --append-system-prompt <note>`, cwd = **main**. `--add-dir <specs>` lets the tab read/write specs regardless of `settings.local.json`.
- Env stripped: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_*` session vars, and `NOS_SPECS_ROOT` (would beat the walk from the worktree), `NOS_RUN_TOKEN` (would hand over another session's run).
- Run detection (D-8): only the tab's own top-level (no `parent_tool_use_id`) Bash/PowerShell calls matching `\bnos(\.js)?\b … run (start|cleanup|abandon)`; their non-error tool_result is parsed (`runOf`): `run-start` → `{kind, id, domain, branch, worktree}` (never the token); `run-cleanup` / `run-abandon` → `null`; error reports ignored; last one wins. Stored as `run` in `sessions.json`, shown as tab tag `quick-7` ("run quick-7 on branch quick-7").
- Restart: tab resumed with `--resume` → Claude Code puts it back in its worktree; token in transcript.
- `nos chat start`: keeps a running server only if version and code fingerprint match (sha256 of package version + every `cli/src/**/*.js`, sorted paths, LF-normalized, 16 hex); otherwise restarts → local nos edits reach the chat without a version bump. spec-ui calls `nos chat start --root <main>` once per dev-server process.
- Relay mode (`chat.runner: false`): a terminal session answers via `nos chat await/reply`; Stop hook `node <home>/cli/bin/nos.js chat hook` (in `settings.local.json`) resolves from the hook's `cwd` (may be a worktree) to main's chat. Runner mode: hook does nothing; moodo uses runner mode, no hook.
- Chat prompts built by the spec-ui use `specsAbs` (absolute specs root), because the tab may sit in a worktree where a relative path does not lead to the specs.

---

## 19. spec-ui

In short: the browser viewer reads the sibling specs root on the host, shows runs live, never merges.

Dev server (`ui/`, `npm run dev`, port 5180; `ui/vite.config.ts` → `serve-specs.ts`):
- Roots via `chatRoots` from the `ui` folder (walk lands on the project; `NOS_SPECS_ROOT` overrides). Not set up → server still starts; locally every data route answers 503 with the reason ("run nos init"), other devices 401.
- Specs read with node fs by absolute path (outside the checkout, vite fs limits irrelevant), watched by absolute path.
- `GET /__specs` → `{specsRel, specsAbs, files}`: `files` keyed relative to the specs root (domain files only, never `.chat/.runs/.locks/.git`); `specsRel` = specs relative to main for display (`../moodo-poc.specs`), absolute only when no relative path exists; `specsAbs` absolute forward slashes.
- `GET /__docs` → docs folder from **main's** `nos.config.json` `spec-ui.docs-folder`.
- `GET /__runs` → one entry per run file: `{kind, id, domain, branch, phase, seen, ageSec, worktree, ahead, behind, dirty, error?}`, never the token. ahead/behind: `git rev-list --left-right --count --end-of-options <mainBranch>...<branch> --` in main (branch names validated). dirty: `git status --porcelain` in the worktree after `rev-parse --show-toplevel` confirms it is that worktree. Async git, 3 s timeout each, all runs in parallel, one shared scan + 2 s cache. Errors → nulls + `error`, never 500.
- `POST /__promote?domain=<folder>` → `nos create-plan --domain <folder> --hollow --root <main>`.
- Events: watcher ignores `.git`, `.chat`, `.locks`, `.runs/logs`. `.runs/*.json` → `runs:changed`; other specs files → `specs:changed`; docs → `docs:changed`. 100 ms burst debounce.
- Client (`main.ts`): fetches `/__specs`, `/__docs`, `/__runs`; while any run is active, polls `/__runs` every 15 s (ahead/behind/dirty change without file events); re-renders only when `runsKey` (all fields but `ageSec`) changed.

Run display (`runs.ts`, `views/parts.ts`, `views/explore.ts`, `model.ts`):
- Plan run joined to its domain (kind plan, domain or id = domain id); quick run to its step (kind quick, id = step number, same domain). Plan steps share the plan's run, dot shown once on the domain.
- Runs joined to nothing (POC runs: kind poc, slug id, domain null) → `model.otherRuns`, one run badge each in the header next to the counts (`#status`), gone with the run file. POC results (`pocs/`) are not shown (not in `/__specs`, which serves domain files only).
- States: `running` (pulsing dot), `stale` (active, not seen for > 2 h, greyed), `cleanup` (phase merged/abandoned: "awaiting cleanup (nos run cleanup)").
- Badge: dot, run id, phase, `↑ahead ↓behind`, `● dirty`, `⚠` git error. Detail rows: Run, Main (ahead/behind, uncommitted changes), Seen, Worktree, Git error. `Branch` badge from `plan.json`/quick step `branch` (stays after cleanup).
- No merge button: finishing needs a session to run the gate.
- Board statuses include `merged`, `discarded`.

Standalone viewer (`ui/index.html`, `bundle/viewer.js`, File System Access): pick the specs folder itself (has `domain-*`, or named `*.specs`, or `config.json` with `id-counters`) → docs unavailable. Pick the project folder → `specs.dir` inside it is followed; outside (default `../<name>.specs`) → error "pick the specs folder <name>/ instead". Picked specs folder gets `rel` from its back-pointer (`../moodo-poc.specs`).

`npm run dev-to-lan` (mode `lan`): HTTPS with cert in `<specs>/.chat/tls`, pairing link + QR (10 min, single use, device approved on the PC), certificate fingerprint shown. All requests and the HMR websocket go through `access.ts` (this machine or a paired device).

---

## 20. Setup & migration

In short: `nos init` lays out a fresh project; the setup ability fills config and settings; old tracked `specs/` is migrated once by hand.

### `nos init` (fresh layout)
Refused in a worktree; without config and `--root`/env: refused in a repo subfolder and inside the nos folder. Creates only what is missing:
1. `nos.config.json` from the template (`specs.dir: null`)
2. specs root (default sibling), `config.json` from template + back-pointer `project` (missing or stale → rewritten, `backPointer.written: true`; uncommitted when the specs repo has history → `nos specs commit --config`)
3. `<specs>/.gitignore` `.chat/`, `.locks/`, `.runs/`
4. project `.gitignore`: `.claude/worktrees/` (plus `<specs.dir>/` only if inside the project), unless a repo `.gitignore` already ignores it (`git check-ignore` on a probe path; e.g. `.claude/*` counts), in the file's line ending
5. `git init -b main` in the specs root; no HEAD → `.gitattributes` `* text=auto eol=lf`, add `.gitattributes .gitignore config.json`, commit `nos: init` (missing identity → hint)
6. `specs.remote` set → `git remote add origin`; different existing origin → `mismatch`, never changed
Commits nothing in the project.

### Setup ability (`abilities/setup.md`, idempotent)
1. `nos roots`. Fresh → `nos init --root <main>`. Configured → (specs missing + remote → `git clone <remote> <specs>`), `nos init` anyway. Always merge `permissions.additionalDirectories: ["<specs>"]` into `.claude/settings.local.json`.
2–4. Detect tooling, propose table (install lockfile-exact: `npm ci`, `pnpm install --frozen-lockfile`, …; slots 3 with e2e else 1; slotWait 600), write confirmed nodes.
5. `nos gate` (no e2e) in main.
6. Slot check via `nos exec dev` per slot in parallel.
7. Chat: allow `Bash(node <home>/cli/bin/nos.js)` and `Bash(node <home>/cli/bin/nos.js *)` in `settings.local.json` (ensure it is ignored); relay → `chat.runner: false` + Stop hook. Lists old relative nos entries in `settings.json` for manual removal.
8. Optional `specs.remote`.
9. Commit `nos.config.json` + `.gitignore` on main `setup: <what>` (D-7). Never `settings.json`, never push.

moodo `settings.local.json`:
```json
{ "permissions": {
    "allow": ["Bash(node D:/development/repos/moodo-poc/.claude/skills/nos/cli/bin/nos.js)",
              "Bash(node D:/development/repos/moodo-poc/.claude/skills/nos/cli/bin/nos.js *)"],
    "additionalDirectories": ["D:/development/repos/moodo-poc.specs"] } }
```

### Migration of a project with tracked `specs/` (summary; full runbook in `ui/requirements/Concept specs repo and worktrees.md`)
No migration logic in the CLI: legacy `spec-file` values fail with "run the migration". Steps, working tree clean (P = project, S = `../<project>.specs`, T = scratch outside):
0. Stop chat server with the **old** CLI (`nos chat stop`), stop spec-ui, update nos. Preconditions: clean status, only `specs/.chat/` ignored under specs, record specs commit count and `main:specs` tree.
1. `git clone --bare --no-local --single-branch -b main P T/specs-split.git`; `git filter-branch --prune-empty --subdirectory-filter specs -- main` (not `git subtree split`: leaks project history). Check count + tree, no `package.json`/`src`.
2. `git init -b main S`, write `S/.gitattributes` **before** `git -C S pull --ff-only T/specs-split.git main` (else CRLF with `core.autocrlf=true`). Check `ls-files --eol`.
3. Move `specs/.chat` → `S/.chat`, write `S/.gitignore`.
4.+5. One node script: `S/config.json` keeps `id-counters` (+ `chat`) + back-pointer; `nos.config.json` from template (`install` → `npm ci`), prettier from the project.
6. JSON-safe script drops `specs/` prefix of every `spec-file`, fixes stale cross-domain paths (moodo: 12); every spec-file must resolve.
7. `git rm -r -q --cached specs`, delete folder, `nos init --root P`, commit `nos: move specs to own repo`.
8. `git -C S add -A && commit "nos: config split"`, delete T.
9. `settings.local.json` script (permissions + additionalDirectories); remove old nos entries from `settings.json` (delete if empty). Restart sessions.
10. Verify `nos roots` from P, P/src, home, S, S/.chat, S/<domain> → identical, no stderr; ui `tests/real-specs.test.ts`; spec-ui; chat; `nos gate` (logs in `S/.runs/logs/main/`).

moodo-poc was migrated 2026-10-07: commit `7ce9c76 nos: move specs to own repo` on main, preceded by `19e6d9c nos: dev and e2e ports from NOS_SLOT`, `33b1965 e2e: capture under e2e/captures, not specs/`, `18c5ba5 build: bundle ceiling 700,000 B`. `nos.config.json`: slots 3, slotWait 600, additional `npm run knip`, `npm run i18n:check`, install `npm ci`. `.gitignore` `.claude/*` already covers `.claude/worktrees/`.

---

## 21. Rejected alternatives

In short: what was weighed and why it lost.

| Alternative | Why rejected |
|---|---|
| Specs tracked on main, orchestrator commits on main | every spec commit moves main's ref → beats a finish mid-gate, ff fails; fixing needs spec commits under the merge lock (blocks specs for a whole gate). Stale copies in worktrees |
| Specs inside the checkout (`.specs`, ignored) | worktree isolation blocks writes into main from worktree sessions and subagents, junctions too (live run 2026-10-06, D-11) |
| Junction / symlink `specs` → specs root | machine paths, OS-specific; a junction into main is refused by isolation anyway |
| Pushing run branches from develop/review-fixing/architect | auto mode denies `--force-with-lease` after rebase; push is the user's call (D-12) |
| Slot per run, allocated at start | refuses a second run although develops need no ports; slot = lease at gate/dev time |
| Session id as holder | no env var exposes it to Bash; chat could inject, terminal cannot. Token works everywhere |
| Autostash on sync | hides state from integrate; stash pop conflicts are silent |
| `--settings <main>/.claude/settings.json` on spawn | redundant: settings not reloaded on cwd change; worktree without `.claude/` reads through |
| Scoped commits so two runs share a domain | needs current step in run file, still leaks `plan.json` edits; one run per domain is one check |
| Shell variable `$NOS` / alias for the CLI | isolation refuses computed command names; literal string also matches permission rules |
| Merge button in spec-ui | finish needs a session to run the gate (open item, orchestrator only for now) |

### Decision codes used in this doc

In short: the design calls made while building it, referenced above as D-n.

| Code | Decision |
|---|---|
| D-1 | `specs.dir` and `worktrees` are read from main's `nos.config.json`; quality tools and project commands from the worktree's copy (a branch may change its test command) |
| D-2 | Plan run id = domain id (`plan-<domain id>`); `nos run start --plan` is a flag, not `--plan <id>` |
| D-3 | `nos specs commit --domain <d>` (and `--config`) for spec writes outside a run |
| D-4 | `nos gate --e2e` leases a slot only around the e2e tool, not the whole gate |
| D-5 | The gate inside `nos run finish` always includes e2e when it is configured |
| D-6 | `nos run finish` never pushes main (extended by D-12) |
| D-7 | architect and setup commit directly on main when run from main (listed exception to "main moves only by ff"); a concurrent finish handles the moved ref via "ff refused → sync once more" |
| D-8 | The chat learns a tab's run from the results of that tab's own `nos run start` / `cleanup` / `abandon` shell calls; no extra CLI call |
| D-10 | A slot lease whose holder process is dead is reclaimed by the next taker; merge/ids/runs locks and run files are never auto-broken |
| D-11 | Specs root outside the project checkout (default `../<project>.specs`, `project` back-pointer in its `config.json`), because Claude Code worktree isolation blocks writes into the main checkout |
| D-12 | nos never pushes code (no branch pushes from develop, review-fixing, architect); only the opt-in `specs.remote` backup push of the specs repo remains |

(D-9 was a process decision for building this feature, not part of the architecture.)

---

## 22. Known gaps / notes

In short: what is untested, unfinished, or where docs and code disagree.

Untested / unfinished:
- Plan runs not live-tested in AUTO mode yet (quick runs were, incl. parallel runs and the conflict → integrate path, in a sandbox clone; plan runs only via the CLI scenario tests).
- Logs never pruned: `<specs>/.runs/logs/<run>/` survives `run cleanup`; gate from main logs to `logs/main/`. An empty `.claude/worktrees/` stays. Ignored, harmless.
- Specs only on this disk unless `specs.remote`; not visible in PRs/CI.
- Chat run detection misses `nos run start` in a background shell call (`run_in_background`) and runs started by subagents; a tab's `run` stays set after `finish` until `cleanup`/`abandon` output is seen, or until its run file is gone (the chat server clears a tab's `run` whose `<specs>/.runs/<run>.json` no longer exists whenever it lists the tabs, e.g. a run another tab abandoned).
- `nos lock take` by hand records the short-lived CLI pid → `pidAlive: false` is normal; such a lock is never reclaimed (only slot leases are).
- Worktrees under `.claude/worktrees/` that are no nos run (made by hand or by other tools) are ignored by nos and spec-ui.
- "One run per session" is a workflow rule only; the CLI cannot see sessions.
- `config.json` is part of every specs commit: an id-counter bump by another domain lands in whichever specs commit comes next.
- Spec-ui `stale` threshold (2 h) is display only; CLI has no staleness rule.

Doc vs code (code wins):
- `ui/requirements/Concept specs repo and worktrees.md` header still says "Status: concept, not implemented".
- Concept CLI table: `nos gate --e2e` "takes a slot lease for the duration" → code: lease only around the e2e tool (D-4). Same in its "Slots" section ("for the duration of the command").
- Concept run file example lacks `mainBranch`; its `phase` list lacks `merged`, `abandoned`.
- Concept: `nos roots` prints `{home, work, main, specs, inWorktree}` → code also prints `configured` (and `action`).
- Concept merge protocol: no "main on mainBranch" check; "Refused ff → back to sync" → code retries once, then exit 1 "refused twice".
- Concept: retry "on `index.lock`" → code retries any git `*.lock` (index, HEAD, refs), 5× 200 ms.
- Concept "`nos run start` commits or reports leftovers" → code always commits them (`<run>: leftovers`), never only reports.
- `cli/README.md` "Process model": "The specs stay central in `<main>/<specs>`" → specs root is the sibling `../<project>.specs`, not under main.
- `ui/src/model.ts` `DEFAULT_SPECS_REL = '.specs'`: display fallback from the old inside-checkout design; real default is `../<project>.specs` (only used when `/__specs` sends no `specsRel`).
- Standalone viewer (`folder.ts locateSpecs`): a picked project folder with `specs.dir: null` and an inner `.specs/` folder uses that inner folder; the CLI would use `../<name>.specs`. Legacy compatibility, can show a different specs root than the CLI.
- README "nos CLI commands used" lists `run start` as a user of `nos exec`: it calls the exec code internally (`execCommand` install, logged), not the `nos exec` command.
