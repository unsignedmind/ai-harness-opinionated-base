# nos-cli

File manager CLI for the nos harness. `nos` manages the specs root of a project (`.specs/`, its own git repo): it hands out ids from a counter, creates domain and phase folders, and lays out empty spec files for each step of a plan. It is also the only resolver of nos paths (`nos roots`).

It uses no dependencies and needs Node.js 20 or newer.

## Installation

```sh
npm install
npm link        # makes the `nos` command available globally
```

You can also run it without linking: `node bin/nos.js <command>`. Orchestrator and abilities always call it by absolute path: `node <home>/cli/bin/nos.js`.

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
| `set-status`        | Change the status of a plan, phase, step or quick step                      |
| `specs commit`      | Commit `config.json` + one domain folder of the specs repo (`--run`, `--domain` or `--config`) |
| `specs find-step`   | Find the spec file of a step id in any domain                               |
| `gate`              | Run the quality tools of `nos.config.json` (`--e2e`: also e2e, under a slot lease) |
| `exec <name>`       | Run a project command: `install`, `dev` (holds a slot while it runs), `deploy-test` |
| `lock <action>`     | `take`, `release` or `status` of a lock in `<specs>/.locks`                 |

General rules:

- `nos` never generates slugs. They must be lowercase kebab-case, e.g. `user-auth`.
- Pass `-` as a file argument to read that input from stdin.
- Every command accepts `--root <dir>`, the work root (see [Roots](#roots)).
- Every command except `init` and `roots` needs a project set up by `nos init`. Without `nos.config.json` it fails (exit 1) with "nos is not set up here: no nos.config.json found from <cwd> up. Run nos init from the project root". `create-domain` no longer creates `<specs>/config.json` itself.
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

For codes 3–7 stdout also gets `{ "action", "error", "exit", "details" }` (details: holder, file lists) and stderr one line. Codes and `NosError` live in `src/exit-codes.js`. `action` is the command's action name (`lock-take`, `gate`, `exec`, ...).

| Command | Exit codes |
| --- | --- |
| `specs commit` | 0, 1 (not its own repo, unknown run or domain, git failed), 2 (not exactly one of `--run`/`--domain`/`--config`, no `-m`) |
| `specs find-step` | 0, 1 not found, 2 bad id |
| `gate` | 0 pass, 1 a tool failed or timed out (JSON still printed), not set up or interrupted, 7 no slot for e2e |
| `exec` | the command's code (130 after SIGINT, 143 after SIGTERM), 1 not configured, 2 unknown name, 7 no slot (dev) |
| `lock take` / `lock release` | 0, 4 held by another token, 2 no token / bad name |
| any command reserving ids | 4 when lock `ids` stays held 10s (hint `nos lock release ids --break`) |

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

`kind: "plan"` has the phase id in `phase`.

### `gate`

```sh
nos gate [--e2e] [--root <dir>]
```

Runs the `quality-tools` of work's `nos.config.json` in the work root, in order: `test`, `lint`, `format-check`, `typecheck`, each `additional` entry (a command string, named `additional-<n>`, or `{ "name", "cmd" }`), then `e2e` (only with `--e2e`). Every tool runs, also after a failure. Each runs in a shell with `NOS_HOME`; only e2e runs under a slot lease with `NOS_SLOT=<n>`. Full output goes to `<specs>/.runs/logs/<run>/<tool>.log` (`<run>` = the run of this worktree, else `main`), the result carries the last 60 lines. No tool configured at all (e2e counts only with `--e2e`) → exit 1 "quality tools are not set up".

- Timeout: a tool running longer than `quality-tools.timeout` minutes (default 30) is killed with its process tree: `status: "fail"`, `timedOut: true`. `signal` is the signal that ended a tool (else `null`).
- Ctrl+C / SIGTERM: the running tool's tree is killed, the e2e lease released, exit 1 "gate interrupted".
- A slot lease of a dead process taken over for e2e adds `"reclaimed": { "slot", "holder" }` to the result.

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

### `lock`

```sh
nos lock take <name> --token <t> [--run <kind>-<id>] [--wait <sec>] [--root <dir>]
nos lock release <name> (--token <t> | --break) [--root <dir>]
nos lock status [<name>] [--root <dir>]
```

A lock is the folder `<specs>/.locks/<name>`, created by `mkdir` (atomic: exactly one taker wins), with `holder.json` `{ run, token, pid, command, taken }`. Names are lowercase letters, digits and dashes (`merge`, `ids`, `slot-<n>`). The same token re-takes its own lock (refreshes `taken`, `reentrant: true`). Another token → exit 4 with `{ lock, path, holder, ageSec, pidAlive, hint }`. A lock is never broken automatically; `--break` is the user's call. `--token` falls back to `NOS_RUN_TOKEN`. `pidAlive` is false for a lock taken by `nos lock take` once that process ended.

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

### Locks, slots and the run registry (internal)

- Lock `ids`: every id reservation (`create-domain`, `create-plan`, `update-plan`, `create-quick-step`) runs its read-modify-write of `<specs>/config.json` under it, waiting up to 10 s.
- Slots: leases on ports. `gate --e2e` and `exec dev` take the smallest free `slot-<n>` (n in 1..`worktrees.slots` of main's `nos.config.json`), polling every 2 s up to `worktrees.slotWait` seconds (fractions allowed), then exit 7 with the holders. A lease whose process is gone (holder `pid` not alive, e.g. killed hard) is reclaimed by the next taker; locks (`merge`, `ids`) and runs are never auto-broken [D-10].
- Run registry `<specs>/.runs/<kind>-<id>.json` (`src/runs.js`): `{ kind, id, domain, branch, worktree, base, mainBranch, token, started, seen, phase }`, `phase` one of `develop`, `integrate`, `gate`, `merge`, `merged`, `abandoned`. Written atomically (tmp + rename). Commands that take `--token` check it against the run file (`NOS_RUN_TOKEN` as fallback): missing → 1, another token → 4.

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

- The project root is the nearest folder with `specs/` from the current directory (or `--root`).
- State: `specs/.chat/` (`sessions.json`, `server.json`, `server.log`, `devices.json`, `audit.log`, `tls/`, and a
  `.gitignore` of `*`). `src/chat/devices.js` (with `devices.d.ts`) is shared with the spec-ui dev server.
- One server per project on 127.0.0.1, port `"chat": { "port" }` in `specs/config.json` (default 4611);
  a port held by another project's server gives a free port, recorded in `server.json`.
- `"chat"` in `specs/config.json`: `port`, `runner` (default true), `permissionMode` (default `auto`), `model`,
  `claude` (path of the executable).
- Env for tests: `NOS_CHAT_STATE_DIR`, `NOS_CHAT_PORT`, `NOS_CHAT_IDLE_MS` (`0`/`off` disables the 30 min idle exit).
- Design: `../ui/requirements/Technical design local web chat for Claude Code.md` and
  `../ui/requirements/Concept spec-ui chat integration.md`.

## Specs layout

```
<project>/
├── nos.config.json             # project config (tracked), see "Config split"
├── .gitignore                  # contains ".specs/" and ".claude/worktrees/"
└── .specs/                     # specs root, its own git repo (branch main)
    ├── .gitignore              # ".chat/", ".locks/", ".runs/"
    ├── config.json             # "id-counters" (managed by nos), "chat"
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

Migration note: a project with the old tracked `specs/` folder and `specs/...` spec-file values is not handled by the CLI; it is migrated once by hand (see `../ui/requirements/Concept specs repo and worktrees.md`, "Migration").

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
| `src/status.js`  | `set-status` and `status.xml` parsing            |
| `src/lock.js`    | mkdir locks in `<specs>/.locks` (`lock`, ids lock) |
| `src/runs.js`    | Run registry `<specs>/.runs`, run tokens         |
| `src/specs-git.js` | `specs commit`, `specs find-step`              |
| `src/slots.js`   | Slot leases (`withSlot`)                         |
| `src/gate.js`    | `gate`                                           |
| `src/exec.js`    | `exec`                                           |
| `src/proc.js`    | `killTree`, `pidAlive`, `sleepSync`              |
| `src/slug.js`    | Slug validation                                  |
| `src/chat/`     | `nos chat`: session store, server, guard, page, client, Stop hook |
