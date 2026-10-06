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
| `roots`             | Print the resolved roots: `home`, `work`, `main`, `specs`, `inWorktree`    |
| `create-domain`     | Reserve a domain id and create `<specs>/domain-<id>-<slug>/idea.md`         |
| `create-plan`       | Save a `plan.json` in a domain and create its phase folders and step files (`--hollow`: empty plan, promotes unplanned) |
| `update-plan`       | Save an updated `plan.json` and create, move or delete phases and steps     |
| `create-quick-step` | Add a quick step (one step outside any plan) to a domain                    |
| `set-status`        | Change the status of a plan, phase, step or quick step (`--run`: merged/discarded for a whole run) |
| `run start\|sync\|finish\|cleanup\|abandon` | Run lifecycle: branch + worktree, rebase onto main, gate + ff-only merge, removal |
| `gate`              | Run the quality tools of the checkout's `nos.config.json`, JSON per tool    |
| `exec`              | Run a project command (`install`, `dev`, `deploy-test`)                     |
| `specs commit`      | Commit the specs of one run or domain (or only `config.json`) in `.specs`   |
| `specs find-step`   | Find the spec file of a step id in any domain                              |
| `lock`              | Take, release or show a lock (`merge`, `ids`, `slot-<n>`)                   |

General rules:

- `nos` never generates slugs. They must be lowercase kebab-case, e.g. `user-auth`.
- Pass `-` as a file argument to read that input from stdin.
- Every command accepts `--root <dir>`, the work root (see [Roots](#roots)).
- Results are printed to stdout as JSON. Every path in a result is absolute with forward slashes (`D:/repo/.specs/...`). Errors go to stderr.
- `spec-file` fields in `plan.json` / `quick-steps.json` are relative to the specs root, e.g. `domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md`. A value with the old `specs/` prefix fails with "legacy spec-file … run the migration" (exit 1).
- Templates (`config.json`, `nos.config.json`, `status.xml`) are read from `<home>/templates/` of the running nos, never from a copy in the project.
- Every command except `roots`, `help` and `init` refuses to run without a `nos.config.json` ("run nos init").

### Roots

The CLI resolves four folders once per invocation (`src/roots.js`, shared with chat and spec-ui via `roots.d.ts`):

| Root    | Resolution |
| ------- | ---------- |
| `home`  | The nos folder of the running CLI (`NOS_HOME`) |
| `work`  | `--root` (as given), else `NOS_SPECS_ROOT`, else the nearest folder with `nos.config.json` walking up from the current directory, else the current directory. The checkout you sit in: main or a git worktree |
| `main`  | `git -C <work> rev-parse --git-common-dir` → its parent. Not a git repo: `work` |
| `specs` | `main` + `specs.dir` of main's `nos.config.json` (default `.specs`) |

`inWorktree` is true when `work` is a linked worktree of `main`. Walking up to `nos.config.json` first makes nested repos harmless: from `<main>/.claude/skills/nos` or `<main>/.specs` the roots are the project's.

Home guard: when `<main>/.claude/skills/nos` exists and is not this nos, or this nos lies under `.claude/worktrees/`, every command prints one warning line on stderr (the result is unchanged).

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

For codes 3–7 stdout also gets `{ "action", "error", "exit", "details" }` (details: holder, file lists) and stderr one line. Codes and `NosError` live in `src/exit-codes.js`.

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

- **Token = holder.** `run start` mints it. Every mutating run command needs `--token <t>` (fallback env `NOS_RUN_TOKEN`). Missing → exit 1 "--token required", another token → exit 4. Every token call updates `seen`. Cooperative guard for solo use, not a security boundary.
- **Locks:** `<specs>/.locks/<name>/holder.json`, created by `mkdir` (atomic). Holder `{run, token, pid, command, taken}`. Reentrant for the same token, so a crashed `finish` resumes. Never broken automatically; `--break` is the user's call. Names: `merge` (finish), `ids` (id counters, CLI internal), `slot-<n>` (gate e2e, exec dev).

### `run start`

```sh
nos run start --domain <domain> (--plan | --quick <stepId>) [--token <t>] [--take-over]
```

1. Needs git. Validates the target: a plan with at least one phase and status not merged/discarded, or an existing quick step.
2. Run file exists: same token → idempotent resume (recreates a missing worktree). Other token → exit 4 with holder and age. `--take-over` → new token.
3. Another run in the same domain → exit 6.
4. Uncommitted specs of this domain (leftovers of a crashed session) → committed as `<run>: leftovers`, reported.
5. Branch `<kind>-<id>` (reused, or created from the current main branch), `git worktree add <main>/.claude/worktrees/<kind>-<id>`, run file with `base` and `phase: develop`, `branch` written into `plan.json` / the quick step entry.
6. `project-commands.install` in the worktree. A failure is reported; the run stays.

```json
{ "action": "run-start", "run": "quick-7", "token": "1a2b3c4d",
  "roots": { "home": "D:/repo/.claude/skills/nos", "work": "D:/repo/.claude/worktrees/quick-7", "main": "D:/repo", "specs": "D:/repo/.specs" },
  "enter": "D:/repo/.claude/worktrees/quick-7" }
```

### `run sync`

```sh
nos run sync --token <t>
```

Rebases the run branch onto the main branch, in the worktree. Rebase already in progress → 3 with the unmerged files. Dirty worktree → 5 with the files (never autostashed). Conflict → 3 with the conflict list, the rebase is left open for the `integrate` ability. Clean → updates `base` and prints `{ahead, behind, base}`.

### `run finish`

```sh
nos run finish --token <t>
```

Precondition: the plan or quick step has status `done` (else 1). Then, under lock `merge`, recorded in the run file's `phase`:

1. `phase=integrate`.
2. Main busy (`MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`) → release, 1.
3. Main dirty on the paths the branch touches → release, 1 with the list.
4. Sync → 3 or 5 → release, same code.
5. `phase=gate`: the full gate, e2e included when configured. Fail → release, 1, gate JSON in `details`.
6. `phase=merge`: `git -C <main> merge --ff-only <branch>`. Refused → back to 4 once, then 1.
7. `set-status --run <run> merged`, `specs commit "<run>: merged"`, `phase=merged`, release.

A crash resumes: the same token re-takes its own lock and continues at the recorded phase. Main is never pushed.

### `run cleanup`

```sh
nos run cleanup --token <t>
```

Run from main, never from inside the worktree (refused: "ExitWorktree keep first"). Needs `phase` `merged` or `abandoned`. Removes the worktree, deletes the branch (`-d` merged, `-D` abandoned) and the run file. The `branch` field stays in the specs as history. A Windows lock error hints at a running dev server. Prints `{"action": "run-cleanup", …}`.

### `run abandon`

```sh
nos run abandon --token <t>
```

`set-status --run <run> discarded`, `specs commit`, `phase=abandoned`, then the cleanup. Cleanup can be retried. Prints `{"action": "run-abandon", …}`.

### `set-status --run`

```sh
nos set-status --run <kind>-<id> merged|discarded
```

Flips a whole run in one write per file. Plan merged: plan `done → merged`, steps `done → merged`, phases unchanged. Plan discarded: plan and every step not merged → `discarded`. Quick: the step `done → merged`, or any status except merged → `discarded`. A violation → 1. Plain `set-status --status merged|discarded` is refused: only `run finish` and `run abandon` call it.

### `gate`

```sh
nos gate [--e2e]
```

Runs the `quality-tools` of the work root's `nos.config.json` in the work root: test, lint, format-check, typecheck, each `additional` entry, then e2e with `--e2e`. Every tool runs, also after a failure. Env: `NOS_HOME`, and `NOS_SLOT` for e2e, which runs under a slot lease. Full logs in `<specs>/.runs/logs/<run|main>/<tool>.log`.

```json
{ "action": "gate", "pass": false,
  "tools": [{ "name": "test", "cmd": "npm test", "status": "fail", "exit": 1, "tail": "<last 60 lines>", "log": "D:/repo/.specs/.runs/logs/quick-7/test.log" }] }
```

`status`: `pass`, `fail`, `not-configured`. Exit 1 on any fail or when `quality-tools` is missing ("not set up"), 7 when no slot is free within `slotWait`.

### `exec`

```sh
nos exec <install|dev|deploy-test>
```

Runs the work root's `project-commands` entry with stdio inherited; the exit code is the command's. `dev` holds a slot lease (`NOS_SLOT`) until the server exits and forwards Ctrl+C. A `null` command → 1, an unknown name → 2, no slot within `slotWait` → 7.

### Slots

A slot is a lease on a set of ports: `<specs>/.locks/slot-<n>`, `n` in `1..worktrees.slots`. `gate --e2e` and `exec dev` take the smallest free one, poll every 2s up to `worktrees.slotWait` seconds, then exit 7. The project derives ports from `NOS_SLOT` (e.g. dev `5173 + NOS_SLOT`).

### `specs commit`

```sh
nos specs commit (--run <kind>-<id> | --domain <domain> | --config) -m "<message>"
```

`git -C <specs> add config.json <domain dir>` and a commit when anything is staged. Never `add -A`: exact because one run owns its domain. Retries a held `index.lock` (5×). Pushes when `specs.remote` is set (a failed push is a warning). `--domain` is for idea, plan and quick step creation outside a run. `--config` commits only `config.json` (e.g. setup's chat node). Prints `{committed, sha, pushed}`.

Caveat: `--domain` for a domain that a run of another session owns also commits that run's spec edits. Never do it; check `<specs>/.runs` first.

Messages: `step-<id>: <ability>`, `phase-<id>: <ability>`, `<run>: <what>` inside a run, `<ability>: <domain>` or `<ability>: <what>` outside.

### `specs find-step`

```sh
nos specs find-step <id>
```

Scans every `domain-*/plan.json` and `quick-steps.json`. Prints `{domain, kind, phase, step, specFile}` (`specFile` absolute). Not found → 1. Used by the `integrate` ability to read the specs behind the `step-<id>:` commits already on main.

### `lock`

```sh
nos lock take|release|status <name> --token <t> [--break]
```

Manual access to the locks above. `release` needs the holder's token, or `--break` (the user's decision, e.g. a stale holder after a crash). A held lock → 4 with `{holder, ageSec, pidAlive}`.

### `init`

```sh
nos init [--root <dir>]
```

Sets up the nos layout of a project. Idempotent: only missing parts are created. Refused inside a git worktree.

1. Creates `nos.config.json` from `<home>/templates/nos.config.json` if missing.
2. Creates `.specs/` with `config.json` (id-counters, from `<home>/templates/config.json`) and `.gitignore` (`.chat/`, `.locks/`, `.runs/`).
3. Git project: appends `.specs/` and `.claude/worktrees/` to the project `.gitignore`, only the missing ones.
4. Git available: `git init -b main` in `.specs`, first commit `nos: init` (`.gitignore`, `config.json`), and `git remote add origin <specs.remote>` when `specs.remote` is set and `.specs` has no `origin`.

It commits nothing in the project (the setup ability does that). Existing files are never changed, except appended `.gitignore` entries.

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
  "inWorktree": true
}
```

### `create-domain`

```sh
nos create-domain --idea <file|-> --slug <slug> [--name <name>] [--labels <a,b>] [--root <dir>]
```

1. Creates `<specs>/` and `<specs>/config.json` if they are missing (copied from `<home>/templates/config.json`). `nos init` sets up the full layout.
2. Takes the next domain id from `<specs>/config.json` and increments the counter.
3. Creates `<specs>/domain-<id>-<slug>/` and saves the idea in it as `idea.md`.
4. Saves `domain.json` in it: `name` (`--name`, default: first `# ` heading of the idea without `Idea:`), `labels` (`--labels`, comma separated, lowercase kebab-case, default none) and `cross-cutting` (always `false` for now).

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
`--session-id`/`--resume`, `--permission-mode auto`, `--permission-prompts none`, run in the project root).
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

- The project is resolved like every command (`nos roots`): main, also when called from a run's worktree.
- State: `<specs>/.chat/` (`sessions.json`, `server.json`, `server.log`, `devices.json`, `audit.log`, `tls/`), ignored
  by the `.specs` repo. `src/chat/devices.js` (with `devices.d.ts`) is shared with the spec-ui dev server.
- One server per project on 127.0.0.1, port `"chat": { "port" }` in `<specs>/config.json` (default 4611);
  a port held by another project's server gives a free port, recorded in `server.json`.
- `"chat"` in `<specs>/config.json`: `port`, `runner` (default true), `permissionMode` (default `auto`), `model`,
  `claude` (path of the executable).
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
| `src/runs.js`    | Run registry, tokens                             |
| `src/lock.js`    | `mkdir` locks, `lock` command                    |
| `src/slots.js`   | Slot leases, `NOS_SLOT`                          |
| `src/gate.js`    | `gate`                                           |
| `src/exec.js`    | `exec`                                           |
| `src/specs-git.js` | `specs commit`, `specs find-step`              |
| `src/proc.js`    | Process tree kill (Windows `taskkill /T /F`)     |
| `src/slug.js`    | Slug validation                                  |
| `src/chat/`     | `nos chat`: session store, server, guard, page, client, Stop hook |
