# nos-cli

File manager and git driver CLI for the nos harness. `nos` manages the specs root of a project (`.specs/`, its own git repo): it hands out ids from a counter, creates domain and phase folders, and lays out empty spec files for each step of a plan. It is also the only resolver of nos paths (`nos roots`) and owns every git mechanic of a run: branch + worktree per plan or quick step, rebase, quality gate, ff-only merge, locks and the specs commits.

It uses no dependencies and needs Node.js 20 or newer.

## Installation

```sh
npm install     # no dependencies; nothing else to install
```

Invocation: `nos` = `node <home>/cli/bin/nos.js`, `<home>` = the nos folder with forward slashes (e.g. `D:/repo/.claude/skills/nos`); the orchestrator uses the `home` printed by `nos roots` verbatim, so permission rules match. Orchestrator, abilities, hooks and permissions always use this absolute form; they never rely on a linked `nos` (`npm link` still works for your own terminal). In this README `nos` stands for that call. Runs need git.

## Usage

```sh
nos <command> [options]
nos help <command>
nos <command> --help
```

| Command             | Description                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `init`              | Set up the nos layout: `nos.config.json`, `.specs/` (own git repo), `.gitignore` entries |
| `roots`             | Print the resolved roots: `home`, `work`, `main`, `specs`, `inWorktree`, `configured` |
| `create-domain`     | Reserve a domain id and create `<specs>/domain-<id>-<slug>/idea.md`         |
| `create-plan`       | Save a `plan.json` in a domain and create its phase folders and step files (`--hollow`: empty plan, promotes unplanned) |
| `update-plan`       | Save an updated `plan.json` and create, move or delete phases and steps     |
| `create-quick-step` | Add a quick step (one step outside any plan) to a domain                    |
| `set-status`        | Change the status of a plan, phase, step or quick step (`--run`: merged/discarded for a whole run) |
| `run start\|sync\|finish\|cleanup\|abandon` | Run lifecycle: branch + worktree, rebase onto main, gate + ff-only merge, removal |
| `specs commit`      | Commit `config.json` + one domain folder of the specs repo (`--run`, `--domain` or `--config`) |
| `specs find-step`   | Find the spec file of a step id in any domain                               |
| `gate`              | Run the quality tools of `nos.config.json` (`--e2e`: also e2e, under a slot lease) |
| `exec <name>`       | Run a project command: `install`, `dev` (holds a slot while it runs), `deploy-test` |
| `lock <action>`     | `take`, `release` or `status` of a lock in `<specs>/.locks`                 |

General rules:

- `nos` never generates slugs. They must be lowercase kebab-case, e.g. `user-auth`.
- Pass `-` as a file argument to read that input from stdin.
- Every command accepts `--root <dir>`, the work root (see [Roots](#roots)).
- Every command except `init`, `roots` and `help` needs a project set up by `nos init`. Without `nos.config.json` it fails (exit 1) with "nos is not set up here: no nos.config.json found from <cwd> up. Run nos init from the project root". `create-domain` no longer creates `<specs>/config.json` itself.
- Results are printed to stdout as JSON. Every path in a result is absolute with forward slashes (`D:/repo/.specs/...`). Errors go to stderr.
- `spec-file` fields in `plan.json` / `quick-steps.json` are relative to the specs root, e.g. `domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md`. A value with the old `specs/` prefix fails with "legacy spec-file … run the migration" (exit 1).
- Templates (`config.json`, `nos.config.json`, `status.xml`) are read from `<home>/templates/` of the running nos, never from a copy in the project.

### Roots

The CLI resolves four folders once per invocation (`src/roots.js`, shared with chat and spec-ui via `roots.d.ts`):

| Root    | Resolution |
| ------- | ---------- |
| `home`  | The nos folder of the running CLI (`NOS_HOME`) |
| `work`  | `--root` (as given), else `NOS_SPECS_ROOT`, else the nearest folder with `nos.config.json` walking up from the current directory, else the current directory. The checkout you sit in: main or a git worktree. A walk that climbed out of a linked worktree (its branch has no `nos.config.json` yet) is brought back: work = that worktree's top + the project offset |
| `main`  | Top of git's main worktree (parent of `--git-common-dir`; for a submodule the first entry of `git worktree list`) + the project offset. Not a git repo: `work` |
| `specs` | `main` + `specs.dir` of main's `nos.config.json` (default `.specs`) |

`inWorktree` is true when `work` is a linked worktree of `main`. `offset` is the project folder inside its repo (`''` unless the project is a subfolder of a monorepo); `worktreeProjectDir(roots, wtTop)` gives `<wtTop>/<offset>`. `configured` is true when `work` or `main` has `nos.config.json`. Git children never inherit `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` (hooks set them). Walking up to `nos.config.json` first makes nested repos harmless: from `<main>/.claude/skills/nos` or `<main>/.specs` the roots are the project's.

Home guard: when `<main>/.claude/skills/nos` exists and is not this nos, or this nos lies under `<main>/.claude/worktrees/`, every command prints one warning line on stderr (the result is unchanged).

### Config split

| File | Repo | Content |
| --- | --- | --- |
| `nos.config.json` | project (tracked) | `specs: {dir, remote}`, `worktrees: {slots, slotWait}`, `quality-tools`, `project-commands`, `spec-ui.docs-folder` |
| `<specs>/config.json` | `.specs` | `id-counters`, `chat` |

`src/project-config.js` reads `nos.config.json` with defaults merged: `specs` and `worktrees` from main's file, `quality-tools`, `project-commands` and `spec-ui` from work's file (a branch may change its test command).

### Exit codes

| Code | Meaning                                        |
| ---- | ---------------------------------------------- |
| `0`  | Success                                        |
| `1`  | The operation failed                           |
| `2`  | Usage error or missing input                   |
| `3`  | Conflict (rebase/merge)                        |
| `4`  | Held by another holder (lock or run token)     |
| `5`  | Dirty worktree                                 |
| `6`  | Another run is active in the domain            |
| `7`  | Timeout waiting for a slot                     |

For codes 3–7 stdout also gets `{ "action", "error", "exit", "details" }` (details: holder, file lists) and stderr one line. So does a 1 of `run finish` whose details the orchestrator needs (gate fail, main busy, main dirty, main on another branch, ff refused twice). Codes and `NosError` live in `src/exit-codes.js`. `action` is the command's action name (`lock-take`, `gate`, `exec`, ...).

| Command | Exit codes |
| --- | --- |
| `run start` | 0, 1 (no git, target invalid/merged/discarded, detached main, git failed), 2, 4 run held by another token, 6 another run in the domain |
| `run sync` | 0, 1 (no token, worktree missing, git failed), 3 rebase conflict / in progress, 4 another token, 5 dirty worktree |
| `run finish` | 0, 1 (not done, gate fail, main busy/dirty/on another branch, ff refused twice, no token), 3, 4 (another token, or merge lock held), 5, 7 no slot for e2e |
| `run cleanup` / `run abandon` | 0, 1 (inside the worktree, wrong phase, worktree in use, git failed), 4 another token |
| `set-status --run` | 0, 1 violation / unknown run, 2 bad run id or status |
| `specs commit` | 0, 1 (not its own repo, unknown run or domain, git failed), 2 (not exactly one of `--run`/`--domain`/`--config`, no `-m`) |
| `specs find-step` | 0, 1 not found, 2 bad id |
| `gate` | 0 pass, 1 a tool failed or timed out (JSON still printed), not set up or interrupted, 7 no slot for e2e |
| `exec` | the command's code (130 after SIGINT, 143 after SIGTERM), 1 not configured, 2 unknown name, 7 no slot (dev) |
| `lock take` / `lock release` | 0, 4 held by another token, 2 no token / bad name |
| any command reserving ids | 4 when lock `ids` stays held 10s (hint `nos lock release ids --break`) |

How the orchestrator reacts (`workflow.md`): 3 → ability `integrate`, then the same command again (contradicting specs → the user decides which intent wins). 4 from `run start` → report holder and age, the user decides (`--take-over` or stop); 4 from `run finish` (merge lock) → wait 60s and retry, up to 10×. 6 → report the other run, the user decides. 5 → commit the step's own leftover files (`git add -- <files>`, never `-A`) with the current step prefix, or park. 1 from `run finish` with a gate fail → `FIX` reruns develop. 7 and other 1 → park and report.

### Process model

- A session (terminal or chat tab) starts in main. Picking a plan or quick step starts a **run**: `nos run start` creates branch `<kind>-<id>` and the worktree `<main>/.claude/worktrees/<kind>-<id>`, and prints a run token. The session then enters the worktree (`EnterWorktree path=<enter>`); subagents, tests and code commits land there.
- Run ids: `plan-<domain id>` (one plan per domain) and `quick-<step id>`. One run per domain, one run per session.
- The specs stay central in `<main>/.specs`, shared by all worktrees. Only the orchestrator commits them (`nos specs commit`), subagents never run git against `.specs`.
- Code commits carry a subject prefix with a colon: `step-<id>: `, `phase-<id>: `, `architect: `, `setup: `. Code and specs are linked by that prefix, never by a sha (shas change on rebase).
- Main moves only by `nos run finish` (ff-only, under the merge lock). Exceptions: setup and architect commit directly when run on main.
- Run merged → the session leaves the worktree (`ExitWorktree`, keep), then `nos run cleanup` removes worktree and branch. Windows cannot delete a folder a process sits in, hence the order.

### Run registry, token and locks

`<specs>/.runs/<kind>-<id>.json`, one file per run (ignored by the `.specs` repo):

```json
{ "kind": "quick", "id": 7, "domain": "domain-2-auth", "branch": "quick-7",
  "worktree": "D:/repo/.claude/worktrees/quick-7", "base": "<main sha the branch builds on>", "mainBranch": "main",
  "token": "<8 hex>", "started": "<iso>", "seen": "<iso>",
  "phase": "develop | integrate | gate | merge | merged | abandoned" }
```

- **Token = holder.** `run start` mints it. Every mutating run command needs `--token <t>` (fallback env `NOS_RUN_TOKEN`). Missing → exit 1 "--token required", another token → exit 4. Every token call updates `seen`. `sync`, `finish`, `cleanup` and `abandon` act on `--run <kind>-<id>` when given, else on the run whose worktree the current directory is in, else on the run holding the token (so `cleanup` from main needs only the token). Cooperative guard for solo use, not a security boundary. `src/runs.js` writes run files atomically (tmp + rename).
- **Locks:** `<specs>/.locks/<name>/holder.json`, created by `mkdir` (atomic). Holder `{run, token, pid, command, taken}`. Reentrant for the same token, so a crashed `finish` resumes. Locks (`merge`, `ids`) and runs are never broken automatically; `--break` is the user's call. Only a slot lease whose process is gone is reclaimed (see [Slots](#slots)) [D-10]. Names: `merge` (finish), `ids` (id counters, CLI internal), `slot-<n>` (gate e2e, exec dev). Lock `ids`: every id reservation (`create-domain`, `create-plan`, `update-plan`, `create-quick-step`) runs its read-modify-write of `<specs>/config.json` under it, waiting up to 10 s (then exit 4, hint `nos lock release ids --break`).

### `run start`

```sh
nos run start --domain <domain> (--plan | --quick <stepId>) [--token <t>] [--take-over]
```

1. Needs git. Validates the target: a plan with at least one phase and status not merged/discarded, or an existing quick step of the domain that is not merged/discarded. `--plan` runs `plan-<domain id>`.
2. Run file exists: same token (or `NOS_RUN_TOKEN`) → idempotent resume (recreates a missing worktree; no install when the worktree was there). No token or another token → exit 4 with `{ run, domain, phase, started, seen, ageSec }`. `--take-over` → new token; a merge lock the old token left (crashed finish) is released.
3. Run file in phase `merged` or `abandoned`: only the token is handled (same token → returned, `--take-over` → new token), no git work and no target check, so a session without the token reaches `run cleanup`.
4. Another run in the same domain → exit 6 with `{ run, domain, phase, branch, worktree, started, seen, ageSec }`.
5. Uncommitted specs of this domain (leftovers of a crashed session) → committed as `<run>: leftovers`, reported in `leftovers`.
6. Branch `<kind>-<id>` (reused, or created from the branch main has checked out; detached → 1), `git -C <main> worktree add <main>/.claude/worktrees/<kind>-<id>`, run file with `base` (main's tip, or the merge base for a reused branch) and `phase: develop`, `branch` written into `plan.json` / the quick step entry.
7. `project-commands.install` of the worktree's `nos.config.json`, run in the worktree, only when the worktree was created now. Output to `<specs>/.runs/logs/<run>/install.log`, never stdout. A failure is reported in `install` (`code`, `log`), the run stays. Not configured → `install: null`.

`enter` (and `roots.work`) is the folder to enter: the worktree plus the project's offset in its repo (monorepo: `<worktree>/<offset>`). The result never has an `error` key (the chat detects a run by `"action": "run-start"`).

```json
{ "action": "run-start",
  "run": { "kind": "quick", "id": 7, "domain": "domain-2-auth", "branch": "quick-7",
           "worktree": "D:/repo/.claude/worktrees/quick-7", "base": "<sha>", "mainBranch": "main",
           "phase": "develop", "started": "<iso>", "seen": "<iso>" },
  "token": "1a2b3c4d",
  "roots": { "home": "D:/repo/.claude/skills/nos", "work": "D:/repo/.claude/worktrees/quick-7", "main": "D:/repo", "specs": "D:/repo/.specs" },
  "enter": "D:/repo/.claude/worktrees/quick-7",
  "install": { "code": 0, "log": "D:/repo/.specs/.runs/logs/quick-7/install.log" },
  "leftovers": null }
```

`leftovers` when something was committed: `{ "committed": true, "sha", "files": [<abs>] }`.

### `run sync`

```sh
nos run sync --token <t> [--run <kind>-<id>]
```

Rebases the run branch onto the main branch, in the worktree (`git -c core.editor=true rebase --no-autostash <mainBranch>`, `GIT_EDITOR=true`).

- Rebase already in progress (a `rebase-merge` / `rebase-apply` folder in the worktree's git dir) → 3 with the unmerged files. `REBASE_HEAD` alone does not count: git leaves it behind after a finished rebase.
- Dirty worktree (`status --porcelain --untracked-files=all`) → 5 with the files (never autostashed).
- Conflict → 3, the rebase is left open for the `integrate` ability.
- Worktree not on its branch → 1. Worktree missing → 1 ("nos run start --token <t> recreates it").
- Clean → updates `base` and `seen`.

File lists in `details`: `files` (relative to the worktree's top) and `paths` (absolute). 3 also has `rebaseInProgress: true`, `worktree`, `branch`, `mainBranch`.

```json
{ "action": "run-sync", "run": { "kind": "quick", "id": 7, "...": "..." }, "base": "<main sha>", "ahead": 2, "behind": 0, "rebased": true }
```

### `run finish`

```sh
nos run finish --token <t> [--run <kind>-<id>]
```

Precondition: the plan or quick step has status `done` (else 1, no lock taken); the `merged` transition is checked before main moves. Then, under lock `merge` (`{ run, token, command: "run finish" }`; held by another token → 4 with `{ lock, path, holder, ageSec, pidAlive, hint }`), recorded in the run file's `phase`:

1. `phase=integrate`.
2. Main's checkout is on `mainBranch` (else 1 "main checkout is on <x>, expected <mainBranch>"). Main busy (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, one `rev-parse -q --verify` each, or a `rebase-merge` / `rebase-apply` folder in main's git dir) → 1 with `details.busy`.
3. Main dirty on the paths the branch touches (`git diff --name-only --no-renames <mainBranch>...<branch>`, intersected with main's `status --porcelain --untracked-files=all`) → 1 with `details.files` / `paths`. Main is untouched by every refusal.
4. Sync as `run sync` → 3 or 5.
5. `phase=gate`: the full gate in the worktree, e2e included when `quality-tools.e2e` is configured. Fail → 1, `details.gate` = the gate result.
6. `phase=merge`: `git -C <main> merge --ff-only <branch>` (main's working tree moves along). Refused (main moved, e.g. an architect commit) → steps 1–6 once more, then 1.
7. `set-status --run <run> merged`, `specs commit "<run>: merged"`, `phase=merged`, release.

Every failure releases the lock and parks the run in `phase=develop` (a failure after the merge keeps `phase=merge`). A crash keeps lock and phase: the same token re-takes its own lock and continues; `phase=merge` with the branch already in main skips to step 7. A finished run (`phase=merged`) returns `{ "action": "run-finish", "run", "merged": true, "already": true }`. Main is never pushed.

```json
{ "action": "run-finish", "run": { "...": "...", "phase": "merged" }, "merged": true, "mainBranch": "main",
  "head": "<main sha = branch tip>", "resumedFrom": null, "gate": { "action": "gate", "pass": true, "tools": [] },
  "statuses": { "action": "set-status", "...": "..." }, "specs": { "committed": true, "sha": "<sha>" } }
```

`resumedFrom`: the phase a resumed finish found (`integrate`, `gate`, `merge`), else null. `gate` is null when step 7 was all that was left.

### `run cleanup`

```sh
nos run cleanup --token <t> [--run <kind>-<id>]
```

Run from main, never from inside the worktree (refused with 1: "ExitWorktree (keep) first"). Needs `phase` `merged` or `abandoned`. `git -C <main> worktree remove [--force] <wt>` (`--force` only for abandoned), `git worktree prune`, `git branch -d` (merged) / `-D` (abandoned), run file deleted; a merge lock of this run's token is released. The `branch` field stays in the specs as history. Each part that is already gone is skipped, so a cleanup that failed half way is simply rerun. A folder still in use (Windows: "Permission denied", "Device or resource busy") → 1 "a process (dev server, terminal, editor) still uses <wt>; stop it and rerun nos run cleanup".

```json
{ "action": "run-cleanup", "run": { "kind": "quick", "id": 7, "...": "..." }, "removed": { "worktree": true, "branch": true, "runFile": true } }
```

### `run abandon`

```sh
nos run abandon --token <t> [--run <kind>-<id>]
```

Any phase except `merged`, not from inside the worktree. `set-status --run <run> discarded`, `specs commit "<run>: discarded"`, `phase=abandoned` (written before the cleanup), then the cleanup (`--force`, `-D`). A failed cleanup is retried with `nos run cleanup`. A rerun on an abandoned run only does the cleanup (`statuses` and `specs` null).

```json
{ "action": "run-abandon", "run": { "...": "...", "phase": "abandoned" }, "removed": { "worktree": true, "branch": true, "runFile": true },
  "statuses": { "action": "set-status", "...": "..." }, "specs": { "committed": true, "sha": "<sha>" } }
```

### `set-status --run`

```sh
nos set-status --run <kind>-<id> merged|discarded
```

Flips a whole run in one write per file. The domain comes from the run file (else the `domain-<id>-*` folder of a plan run, or the domain whose quick steps hold the step). Plan merged: plan `done → merged`, steps `done → merged`, phases unchanged. Plan discarded: plan and every step not merged → `discarded` (merged steps stay). Quick: the step `done → merged`, or any status except merged → `discarded`. Targets already at the status stay (a rerun changes nothing). A violation → 1 with `details.violations`, nothing written. Plain `set-status --status merged|discarded` is refused (1, hint to `--run`): only `run finish` and `run abandon` call it.

```json
{ "action": "set-status", "run": "quick-7", "domain": "domain-2-auth", "status": "merged",
  "file": "D:/repo/.specs/domain-2-auth/quick-steps/quick-steps.json",
  "changes": [{ "target": "step", "id": 7, "slug": "fix-login-typo", "previous": "done", "status": "merged" }] }
```

### `gate`

```sh
nos gate [--e2e] [--root <dir>]
```

Runs the `quality-tools` of work's `nos.config.json` in the work root, in order: `test`, `lint`, `format-check`, `typecheck`, each `additional` entry (a command string, named `additional-<n>`, or `{ "name", "cmd" }`), then `e2e` (only with `--e2e`). Every tool runs, also after a failure. Each runs in a shell with `NOS_HOME`; only e2e runs under a slot lease with `NOS_SLOT=<n>`. Full output goes to `<specs>/.runs/logs/<run>/<tool>.log` (`<run>` = the run of this worktree, else `main`), the result carries the last 60 lines. No tool configured at all (e2e counts only with `--e2e`) → exit 1 "quality tools are not set up".

- Timeout: a tool running longer than `quality-tools.timeout` minutes (default 30) is killed with its process tree: `status: "fail"`, `timedOut: true`. `signal` is the signal that ended a tool (else `null`).
- Ctrl+C / SIGTERM: the running tool's tree is killed, the e2e lease released, exit 1 "gate interrupted".
- A slot lease of a dead process taken over for e2e adds `"reclaimed": { "slot", "holder" }` to the result.

`status`: `pass`, `fail`, `not-configured`.

```sh
$ nos gate
{
  "action": "gate",
  "pass": false,
  "tools": [
    { "name": "test", "cmd": "npm test", "status": "fail", "exit": 1, "signal": null, "timedOut": false,
      "tail": "<last 60 lines>", "log": "D:/repo/.specs/.runs/logs/quick-7/test.log" },
    { "name": "lint", "cmd": null, "status": "not-configured", "exit": null, "signal": null, "timedOut": false,
      "tail": "", "log": null }
  ]
}
```

### `exec`

```sh
nos exec <install|dev|deploy-test> [--root <dir>]
```

Runs a `project-commands` entry of work's `nos.config.json` in a shell in the work root, stdio inherited (no JSON), `NOS_HOME` set. The exit code is the command's. `dev` takes a slot lease (`NOS_SLOT=<n>`) and holds it until the server exits; SIGINT/SIGTERM stop the server's process tree (`taskkill /T /F` on Windows, the process group elsewhere, `src/proc.js`), then the lease is released and the exit code is 130 (SIGINT) / 143 (SIGTERM). A `null` command → exit 1, an unknown name → 2, no slot within `slotWait` → 7. A dev lease taken over from a dead process is reported on stderr.

`execCommand(roots, name, { stdio: 'log' })` (for `run start`'s install) writes the output to `<specs>/.runs/logs/<run>/<name>.log` and resolves with `{ code, log }`.

### Slots

A slot is a lease on a set of ports: the lock `<specs>/.locks/slot-<n>` (`src/slots.js`). `gate --e2e` and `exec dev` take the smallest free `slot-<n>` (n in 1..`worktrees.slots` of main's `nos.config.json`), polling every 2 s up to `worktrees.slotWait` seconds (fractions allowed), then exit 7 with the holders. A lease whose process is gone (holder `pid` not alive, e.g. killed hard) is reclaimed by the next taker [D-10]. The project derives ports from `NOS_SLOT` (e.g. dev `5173 + NOS_SLOT`).

### `specs commit`

```sh
nos specs commit (--run <kind>-<id> | --domain <domain> | --config) -m <message> [--root <dir>]
```

Commits the specs repo, scoped to `config.json` + one domain folder: `git -C <specs> add -- config.json <domain>` (adds, changes and deletions inside them; never `add -A`), then `commit --only` those paths, so files another writer staged stay out. Commits only when something is staged.

- `--run <kind>-<id>`: the domain of that run file. `--domain <d>`: a domain outside any run (idea, plan or quick step creation). `--config`: `config.json` only (`domain: null`). Exactly one of the three.
- A `*.lock` of another writer (`index.lock`, `HEAD.lock`, ref locks): retried 5 times, 200 ms apart.
- No hooks and no signing in the specs repo (`-c core.hooksPath= -c commit.gpgsign=false`). git never prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`).
- `specs.remote` set: `git push -u origin HEAD` after a commit, and also without a new commit when `HEAD` is ahead of its upstream (an earlier push failed) or has none. A failed push or one running over 60 s is a warning (stderr + `warning`), the commit stays.
- Refused when `<specs>` is not the top of its own git repo (a `git -C` would reach the project repo).

Caveat: `--domain` for a domain that a run of another session owns also commits that run's spec edits. Never do it; check `<specs>/.runs` first.

Messages: `step-<id>: <ability>`, `phase-<id>: <ability>`, `<run>: <what>` inside a run, `<ability>: <domain>` or `<ability>: <what>` outside.

```sh
$ nos specs commit --run quick-7 -m "step-7: develop"
{
  "action": "specs-commit",
  "domain": "domain-2-auth",
  "committed": true,
  "sha": "<sha, null when nothing was staged>",
  "pushed": false,
  "files": ["D:/repo/.specs/domain-2-auth/quick-steps/quick-steps.json"]
}
```

### `specs find-step`

```sh
nos specs find-step <id> [--root <dir>]
```

Scans `<specs>/domain-*/plan.json` and `quick-steps/quick-steps.json`. Exit 1 when the id is in neither. An unreadable file is skipped with an entry in `warnings` (present only then; on exit 1 in `details.warnings`).

```sh
$ nos specs find-step 7
{
  "action": "find-step",
  "id": 7,
  "domain": "domain-2-auth",
  "kind": "quick",
  "phase": null,
  "step": 7,
  "slug": "fix-login-typo",
  "intent": "Fix the typo on the login button",
  "status": "open",
  "specFile": "D:/repo/.specs/domain-2-auth/quick-steps/step-7-fix-login-typo.md"
}
```

`kind: "plan"` has the phase id in `phase`. Used by the `integrate` ability to read the specs behind the `step-<id>:` commits already on main.

### `lock`

```sh
nos lock take <name> --token <t> [--run <kind>-<id>] [--wait <sec>] [--root <dir>]
nos lock release <name> (--token <t> | --break) [--root <dir>]
nos lock status [<name>] [--root <dir>]
```

A lock is the folder `<specs>/.locks/<name>`, created by `mkdir` (atomic: exactly one taker wins), with `holder.json` `{ run, token, pid, command, taken }`. Names are lowercase letters, digits and dashes (`merge`, `ids`, `slot-<n>`). The same token re-takes its own lock (refreshes `taken`, `reentrant: true`). Another token → exit 4 with `{ lock, path, holder, ageSec, pidAlive, hint }`. A lock is never broken automatically (only a dead slot lease is reclaimed, see [Slots](#slots)); `--break` is the user's call. `--token` falls back to `NOS_RUN_TOKEN`. `pidAlive` is false for a lock taken by `nos lock take` once that process ended.

```sh
$ nos lock take merge --token 1a2b3c4d --run quick-7
{ "action": "lock-take", "lock": "merge", "path": "D:/repo/.specs/.locks/merge",
  "holder": { "run": "quick-7", "token": "1a2b3c4d", "pid": 4242, "command": "lock take", "taken": "<iso>" },
  "reentrant": false }
$ nos lock release merge --token 1a2b3c4d
{ "action": "lock-release", "lock": "merge", "path": "...", "released": true, "broken": false, "holder": { ... } }
$ nos lock status merge
{ "action": "lock-status", "lock": "merge", "path": "...", "held": false, "holder": null, "ageSec": null, "pidAlive": false }
```

`nos lock status` without a name lists every lock: `{ "action": "lock-status", "locks": [...] }`.

### `init`

```sh
nos init [--root <dir>]
```

Sets up the nos layout of a project. Idempotent: only missing parts are created. Refused inside a git worktree.

1. Creates `nos.config.json` from `<home>/templates/nos.config.json` if missing.
2. Creates `.specs/` with `config.json` (id-counters, from `<home>/templates/config.json`) and `.gitignore` (`.chat/`, `.locks/`, `.runs/`).
3. Git project: appends `.specs/` and `.claude/worktrees/` to the project `.gitignore`, unless a `.gitignore` of the repo already ignores them (`git check-ignore`, so `.claude/*` counts; global excludes and `.git/info/exclude` do not). Appended in the file's line ending (CRLF stays CRLF).
4. Git available: `git init -b main` in `.specs`, first commit `nos: init` (`.gitignore`, `config.json`), and `git remote add origin <specs.remote>` when `specs.remote` is set and `.specs` has no `origin`. An `origin` with another URL is left and reported as `{url, existing, added: false, mismatch: true}`. A commit failing for a missing git identity says to set `user.name` / `user.email`.

Without `nos.config.json` and without `--root` / `NOS_SPECS_ROOT` it runs only from the project root: refused in a subfolder of a git repo and inside the nos folder (e.g. `<project>/.claude/skills/nos`). It commits nothing in the project (the setup ability does that). Existing files are never changed, except appended `.gitignore` entries.

```sh
$ nos init
{
  "action": "init",
  "main": "D:/repo",
  "specs": "D:/repo/.specs",
  "created": ["D:/repo/nos.config.json", "D:/repo/.specs", "D:/repo/.specs/config.json", "D:/repo/.specs/.gitignore", "D:/repo/.specs/.git"],
  "existing": [],
  "gitignoreAdded": [".specs/", ".claude/worktrees/"],
  "commit": "<sha of the first .specs commit, null when it existed>",
  "remote": null
}
```

### `roots`

```sh
nos roots [--root <dir>]
```

```sh
$ nos roots
{
  "action": "roots",
  "home": "D:/repo/.claude/skills/nos",
  "work": "D:/repo/.claude/worktrees/quick-7",
  "main": "D:/repo",
  "specs": "D:/repo/.specs",
  "inWorktree": true,
  "configured": true
}
```

### `create-domain`

```sh
nos create-domain --idea <file|-> --slug <slug> [--name <name>] [--labels <a,b>] [--root <dir>]
```

Needs `<specs>/config.json` from `nos init`.

1. Takes the next domain id from `<specs>/config.json` and increments the counter.
2. Creates `<specs>/domain-<id>-<slug>/` and saves the idea in it as `idea.md`.
3. Saves `domain.json` in it: `name` (`--name`, default: first `# ` heading of the idea without `Idea:`), `labels` (`--labels`, comma separated, lowercase kebab-case, default none) and `cross-cutting` (always `false` for now).

```sh
$ nos create-domain --idea idea.md --slug user-auth --labels auth,ui
{
  "action": "create-domain",
  "id": 1,
  "folder": "domain-1-user-auth",
  "path": "D:/repo/.specs/domain-1-user-auth",
  "idea": "D:/repo/.specs/domain-1-user-auth/idea.md",
  "domain": "D:/repo/.specs/domain-1-user-auth/domain.json"
}
```

### `create-plan`

```sh
nos create-plan --domain <domain-<id>-<slug>> --plan <file|-> [--root <dir>]
nos create-plan --domain <domain-<id>-<slug>> --hollow [--root <dir>]
```

1. For each phase, takes the next phase id and creates `<specs>/<domain>/phases/phase-<id>-<slug>/`.
2. For each step, reserves a step id and creates an empty `step-<id>-<slug>.md` in its phase folder.
3. Sets each step's `spec-file` field (relative to the specs root: `<domain>/phases/phase-<id>-<slug>/step-<id>-<slug>.md`) and saves `plan.json` in the domain. A `labels` field is dropped: labels live in `domain.json`.

The plan is validated before anything is written. Each domain can have only one plan; only a hollow plan (see below) may be replaced.

Example `plan.json` (`phases` and `steps` can be arrays or single objects):

```json
{
  "name": "User auth",
  "status": "open",
  "phases": [{
    "slug": "data-model",
    "name": "Data model",
    "status": "open",
    "intent": "",
    "description": "",
    "steps": [{
      "slug": "user-table",
      "intent": "Create the user table",
      "status": "open",
      "description": "",
      "spec-file": ""
    }]
  }]
}
```

Every phase and step needs a `slug`. All other fields are kept unchanged.

```sh
$ nos create-plan --domain domain-1-user-auth --plan plan.json
# creates:
#   <specs>/domain-1-user-auth/plan.json
#   <specs>/domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md
# spec-file: "domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md"
```

#### Hollow plan (`--hollow`)

```sh
nos create-plan --domain <domain-<id>-<slug>> --hollow [--root <dir>]
```

Promotes a domain without planning it (the Spec UI's "Manual promote" button runs this). It saves only

```json
{ "name": "<domain.json name>", "status": "open", "phases": [] }
```

and creates no folders. The name falls back to the first `# ` heading of `idea.md` (without `Idea:`). The status is the first `<plans>` status of `status.xml` (`open` without the file). `--plan` is not allowed with `--hollow`, and an existing `plan.json` is refused.

A hollow plan (no phases and no `phase-*` folders) does not count as "planned": a later `create-plan --plan …` replaces it with the real plan. The orchestrator's RUN option skips plans without phases; its PLAN option still offers the domain.

### `update-plan`

```sh
nos update-plan --domain <domain-<id>-<slug>> --plan <file|-> [--dry-run] [--force] [--root <dir>]
```

Start from the current `<specs>/<domain>/plan.json`, edit it, and pass it back. `nos` compares it with the folders on disk:

| In the updated plan                                | Result                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| Step with an unchanged `spec-file`                 | Kept                                                          |
| Step with an empty `spec-file`                     | New id, new empty step file                                   |
| Kept step moved to another phase or given a new slug | File moved/renamed; id and content are kept                 |
| Phase whose `slug` matches a `phase-<id>-<slug>` folder | Kept                                                     |
| Phase with a new slug                              | New id, new folder (renaming a phase slug replaces the phase) |
| Step or phase no longer in the plan                | Step file / phase folder deleted                              |

- The plan is validated before anything is written.
- Deleting a step file with content, or a phase folder that contains other files, is refused unless you pass `--force`.
- `--dry-run` prints the changes, including the ids that would be assigned, without writing anything.
- Ids of deleted phases and steps are never reused.
- Fields `update-plan` does not manage survive an update that leaves them out: top-level fields (`status`, `review-needed`, ...), and the fields of kept phases (by slug) and kept steps (by spec-file), e.g. `status`. A field given in the update wins, except `branch`: it is written by `run start` only, the current value always stays.

The output lists `created`, `moved` and `deleted` phases and steps with absolute paths (`path`, `from`, `to`); created and moved steps also carry their new `specFile` (relative). See `nos help update-plan` for an example.

### `create-quick-step`

```sh
nos create-quick-step --domain <domain-<id>-<slug>> --step <file|-> [--root <dir>]
```

A quick step is a single step outside any plan, run by the orchestrator through the normal step cycle. The domain must exist (create it with `create-domain` first); it does not need a `plan.json`.

1. Reserves a step id from the shared `step` counter, so ids stay unique across plan and quick steps
2. Creates an empty `<specs>/<domain>/quick-steps/step-<id>-<slug>.md`
3. Appends the step to `<specs>/<domain>/quick-steps/quick-steps.json` with `spec-file` (`<domain>/quick-steps/step-<id>-<slug>.md`) filled and `status` `open`

The step JSON needs `slug` (kebab-case) and `intent`. `description`, `human-validation-needed` (default `false`) and `review-needed` (default `true`) are optional; other fields are kept as-is.

```sh
$ echo '{"slug":"fix-login-typo","intent":"Fix the typo on the login button"}' | nos create-quick-step --domain domain-1-user-auth --step -
{
  "action": "create-quick-step",
  "domain": "domain-1-user-auth",
  "id": 7,
  "path": "D:/repo/.specs/domain-1-user-auth/quick-steps/step-7-fix-login-typo.md",
  "quick-steps": "D:/repo/.specs/domain-1-user-auth/quick-steps/quick-steps.json"
}
```

### `set-status`

```sh
nos set-status --domain <domain-<id>-<slug>> [--phase <id>] [--step <id>] --status <status> [--root <dir>]
```

| Arguments                 | Changes the status of                                     |
| ------------------------- | --------------------------------------------------------- |
| `--domain` only           | the plan                                                  |
| `--phase <id>`            | that phase                                                |
| `--step <id>`             | that step (`--phase` is optional, but must match if given) |

Without `--phase`, a step id that is not in `plan.json` is looked up in `quick-steps/quick-steps.json` of the domain; this also works for a domain without `plan.json`. The result then has `"plan"` pointing to `quick-steps.json` and `"quick": true`.

The status is checked against `<home>/templates/status.xml` of the running nos: `<plans>` for the plan, `<phases>` for phases, `<steps>` for steps. An invalid status fails with the list of valid ones, and `plan.json` is left untouched. Only the `status` field is changed. Phase and step ids are read from each step's `spec-file` path.

```sh
$ nos set-status --domain domain-1-user-auth --step 1 --status in-review
{
  "action": "set-status",
  "domain": "domain-1-user-auth",
  "plan": "D:/repo/.specs/domain-1-user-auth/plan.json",
  "target": "step",
  "id": 1,
  "slug": "user-table",
  "previous": "implemented",
  "status": "in-review"
}
```

### `chat`

Local chat of the project in the spec-ui (or the chat page). By default the chat server answers every
chat tab with its own headless Claude Code session (`src/chat/runner.js`: `claude -p --output-format stream-json`,
`--session-id`/`--resume`, `--permission-mode auto`, `--permission-prompts none`, started in the main checkout).
`"chat": { "runner": false }` switches to relay: a terminal session answers with `await` / `reply`.
Async, so `bin/nos.js` hands it to `src/chat/commands.js`. Full help: `nos chat --help`.

| Command | What it does |
| --- | --- |
| `nos chat` | Server address, version and sessions |
| `nos chat open [--name n] [--no-open] [--reopen]` | Start the server if needed, open or resume the chat |
| `nos chat await [--timeout-ms n]` | Block until the user writes or ends the chat; adds `next_step` |
| `nos chat reply [--text t]` | Send a reply; stdin when `--text` is absent |
| `nos chat typing [--state thinking\|typing\|idle]` | Presence shown in the page |
| `nos chat pending` | Sessions with undelivered messages, read from disk |
| `nos chat end` / `nos chat stop` | End the chat as the agent / shut the server down |
| `nos chat pair` | One-time pairing link for a phone (10 min, single use; approve the device on the PC) |
| `nos chat devices [--approve id] [--deny id] [--revoke id] [--revoke-all]` | Paired devices |
| `nos chat server [--port n]` | Run the server in the foreground |
| `nos chat hook` | Stop hook (relay mode only): hands queued messages to Claude Code |

- Roots come from the resolver (`src/chat/paths.js` `chatRoots`: `--root`, `NOS_SPECS_ROOT`, else the walk from the
  current directory). The chat always works with **main**: from a worktree of the project (also the Stop hook's `cwd`)
  every command reaches the chat of the main checkout, same state dir, same session key (sha256 of main's real path).
  Without `nos.config.json` in main every command fails with "nos is not set up in <main> …: run nos init" (the hook
  prints nothing). `status` and the server log print main with forward slashes.
- State: `<specs>/.chat/` (`sessions.json`, `server.json`, `server.log`, `devices.json`, `audit.log`, `tls/`, and a
  `.gitignore` of `*`; `.specs/.gitignore` of `nos init` ignores `.chat/` too). `src/chat/devices.js` and
  `src/chat/paths.js` (with `devices.d.ts` / `paths.d.ts`) are shared with the spec-ui dev server.
- One server per project on 127.0.0.1, port `"chat": { "port" }` in `<specs>/config.json` (default 4611);
  a port held by another project's server gives a free port, recorded in `server.json` (`root` = main).
- `"chat"` in `<specs>/config.json`: `port`, `runner` (default true), `permissionMode` (default `auto`), `model`,
  `claude` (path of the executable).
- A tab's session never inherits `NOS_SPECS_ROOT` or `NOS_RUN_TOKEN` (nor the variables of the Claude Code session
  that started the server).
- The run of a tab: when the result of the session's own shell call (Bash/PowerShell, not a subagent's) of
  `nos run start` holds its JSON (`"action": "run-start"`), the tab records `run: { kind, id, domain, branch, worktree }`
  (never the token) in `sessions.json`; the results of `nos run cleanup` / `nos run abandon` clear it. Other tools
  (Read, grep, cat), error reports (`{ action, error, … }`) and failed calls are ignored. Not covered: a `nos run`
  call in a background shell (its output arrives through another tool). `run` is in `GET /api/sessions`
  (`sessions`, `tabs`), `GET /api/session/<key>` and the `sessions` events.
- Permissions and the relay Stop hook live in the project's `.claude/settings.local.json` with the absolute
  `node <home>/cli/bin/nos.js chat …` (written by the setup ability).
- Env for tests: `NOS_CHAT_STATE_DIR`, `NOS_CHAT_PORT`, `NOS_CHAT_IDLE_MS` (`0`/`off` disables the 30 min idle exit).
- Design: `../ui/requirements/Technical design local web chat for Claude Code.md` and
  `../ui/requirements/Concept spec-ui chat integration.md`.

## Specs layout

```
<project>/
├── nos.config.json             # project config (tracked), see "Config split"
├── .gitignore                  # contains ".specs/" and ".claude/worktrees/"
├── .claude/
│   ├── skills/nos/             # NOS_HOME (tracked or ignored)
│   ├── settings.local.json     # permissions + hook with absolute nos paths (never tracked)
│   └── worktrees/quick-7/      # one git worktree per run, branch quick-7 / plan-<domain id>
└── .specs/                     # specs root, its own git repo (branch main)
    ├── .gitignore              # ".chat/", ".locks/", ".runs/"
    ├── config.json             # "id-counters" (managed by nos), "chat"
    ├── .runs/                  # run registry (quick-7.json), gate logs (logs/)
    ├── .locks/                 # merge, ids, slot-<n>
    ├── .chat/                  # chat state
    └── domain-1-user-auth/
        ├── idea.md
        ├── domain.json
        ├── plan.json
        ├── phases/
        │   └── phase-1-data-model/
        │       └── step-1-user-table.md
        └── quick-steps/
            ├── quick-steps.json
            └── step-7-fix-login-typo.md
```

### Migrating a project with tracked `specs/`

A project with the old tracked `specs/` folder and `specs/...` spec-file values is not handled by the CLI (a legacy spec-file fails with "run the migration"). Migrate it once by hand, working tree clean, with the steps 1–10 in `../ui/requirements/Concept specs repo and worktrees.md`, section "Migration of this project": history split into `.specs`, config split into `nos.config.json` and `.specs/config.json`, spec-file prefix dropped, `specs/` untracked, `settings.local.json` with absolute paths, verify with `nos roots`.

Ids are global across the project. Phase and step counters are shared by all domains.

## Development

```sh
npm test            # run the test suite (node:test)
npm run test:watch  # rerun the tests on every change
```

| Path             | Contents                                         |
| ---------------- | ------------------------------------------------ |
| `bin/nos.js`     | Executable entry point                           |
| `src/cli.js`     | Argument parsing, help text, JSON output         |
| `src/roots.js`   | Roots resolver, home guard, `SPECS_DIR`, spec-file checks (`roots.d.ts` for TypeScript) |
| `src/exit-codes.js` | Exit codes and `NosError`                     |
| `src/git.js`     | `git(args, {cwd})`, `gitOut`, `gitAvailable`     |
| `src/project-config.js` | `nos.config.json` reader with defaults    |
| `src/init.js`    | `init`                                           |
| `src/config.js`  | `<specs>/config.json` setup, id reservation, template paths |
| `src/domain.js`  | `create-domain`                                  |
| `src/plan.js`    | `create-plan`                                    |
| `src/update-plan.js` | `update-plan`                                |
| `src/quick-step.js` | `create-quick-step`, `quick-steps.json` access |
| `src/status.js`  | `set-status` (also `--run`) and `status.xml` parsing |
| `src/run.js`     | `run start\|sync\|finish\|cleanup\|abandon`     |
| `src/runs.js`    | Run registry `<specs>/.runs`, run tokens         |
| `src/lock.js`    | mkdir locks in `<specs>/.locks` (`lock`, ids lock) |
| `src/slots.js`   | Slot leases (`withSlot`), `NOS_SLOT`             |
| `src/gate.js`    | `gate`                                           |
| `src/exec.js`    | `exec`                                           |
| `src/specs-git.js` | `specs commit`, `specs find-step`              |
| `src/proc.js`    | `killTree` (Windows `taskkill /T /F`, else the process group), `pidAlive`, `sleepSync` |
| `src/slug.js`    | Slug validation                                  |
| `src/chat/`     | `nos chat`: session store, server, guard, page, client, Stop hook |
