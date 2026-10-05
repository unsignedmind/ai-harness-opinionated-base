# nos-cli

File manager CLI for the nos harness. `nos` manages the `specs/` folder of a project: it hands out ids from a counter, creates domain and phase folders, and lays out empty spec files for each step of a plan.

It uses no dependencies and needs Node.js 20 or newer.

## Installation

```sh
npm install
npm link        # makes the `nos` command available globally
```

You can also run it without linking: `node bin/nos.js <command>`.

## Usage

```sh
nos <command> [options]
nos help <command>
nos <command> --help
```

| Command             | Description                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `init`              | Create `specs/` and `specs/config.json` if missing                          |
| `create-domain`     | Reserve a domain id and create `specs/domain-<id>-<slug>/idea.md`           |
| `create-plan`       | Save a `plan.json` in a domain and create its phase folders and step files (`--hollow`: empty plan, promotes unplanned) |
| `update-plan`       | Save an updated `plan.json` and create, move or delete phases and steps     |
| `create-quick-step` | Add a quick step (one step outside any plan) to a domain                    |
| `set-status`        | Change the status of a plan, phase, step or quick step                      |

General rules:

- `nos` never generates slugs. They must be lowercase kebab-case, e.g. `user-auth`.
- Pass `-` as a file argument to read that input from stdin.
- Every command accepts `--root <dir>`, the project root that contains `specs/` (default: current directory).
- Results are printed to stdout as JSON. Errors go to stderr.

### Exit codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | Success                         |
| `1`  | The operation failed            |
| `2`  | Usage error or missing input    |

### `init`

```sh
nos init [--root <dir>]
```

Creates `specs/` and `specs/config.json` if they are missing, like `create-domain` step 1. An existing `config.json` is never changed.

```sh
$ nos init
{
  "action": "init",
  "specs": "specs",
  "config": "specs/config.json",
  "createdConfig": true
}
```

### `create-domain`

```sh
nos create-domain --idea <file|-> --slug <slug> [--name <name>] [--labels <a,b>] [--root <dir>]
```

1. Creates `specs/` and `specs/config.json` if they are missing. If `.claude/skills/nos/templates/config.json` exists, `config.json` is copied from it.
2. Takes the next domain id from `specs/config.json` and increments the counter.
3. Creates `specs/domain-<id>-<slug>/` and saves the idea in it as `idea.md`.
4. Saves `domain.json` in it: `name` (`--name`, default: first `# ` heading of the idea without `Idea:`), `labels` (`--labels`, comma separated, lowercase kebab-case, default none) and `cross-cutting` (always `false` for now).

```sh
$ nos create-domain --idea idea.md --slug user-auth --labels auth,ui
{
  "action": "create-domain",
  "id": 1,
  "folder": "domain-1-user-auth",
  "path": "specs/domain-1-user-auth",
  "idea": "specs/domain-1-user-auth/idea.md",
  "domain": "specs/domain-1-user-auth/domain.json"
}
```

### `create-plan`

```sh
nos create-plan --domain <domain-<id>-<slug>> --plan <file|-> [--root <dir>]
nos create-plan --domain <domain-<id>-<slug>> --hollow [--root <dir>]
```

1. For each phase, takes the next phase id and creates `specs/<domain>/phases/phase-<id>-<slug>/`.
2. For each step, reserves a step id and creates an empty `step-<id>-<slug>.md` in its phase folder.
3. Sets each step's `spec-file` field and saves `plan.json` in the domain. A `labels` field is dropped: labels live in `domain.json`.

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
#   specs/domain-1-user-auth/plan.json
#   specs/domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md
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

Start from the current `specs/<domain>/plan.json`, edit it, and pass it back. `nos` compares it with the folders on disk:

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

The output lists `created`, `moved` and `deleted` phases and steps. See `nos help update-plan` for an example.

### `create-quick-step`

```sh
nos create-quick-step --domain <domain-<id>-<slug>> --step <file|-> [--root <dir>]
```

A quick step is a single step outside any plan, run by the orchestrator through the normal step cycle. The domain must exist (create it with `create-domain` first); it does not need a `plan.json`.

1. Reserves a step id from the shared `step` counter, so ids stay unique across plan and quick steps
2. Creates an empty `specs/<domain>/quick-steps/step-<id>-<slug>.md`
3. Appends the step to `specs/<domain>/quick-steps/quick-steps.json` with `spec-file` filled and `status` `open`

The step JSON needs `slug` (kebab-case) and `intent`. `description`, `human-validation-needed` (default `false`) and `review-needed` (default `true`) are optional; other fields are kept as-is.

```sh
$ echo '{"slug":"fix-login-typo","intent":"Fix the typo on the login button"}' | nos create-quick-step --domain domain-1-user-auth --step -
{
  "action": "create-quick-step",
  "domain": "domain-1-user-auth",
  "id": 7,
  "path": "specs/domain-1-user-auth/quick-steps/step-7-fix-login-typo.md",
  "quick-steps": "specs/domain-1-user-auth/quick-steps/quick-steps.json"
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

The status is checked against `.claude/skills/nos/templates/status.xml` in the project: `<plans>` for the plan, `<phases>` for phases, `<steps>` for steps. An invalid status fails with the list of valid ones, and `plan.json` is left untouched. Only the `status` field is changed. Phase and step ids are read from each step's `spec-file` path.

```sh
$ nos set-status --domain domain-1-user-auth --step 1 --status in-review
{
  "action": "set-status",
  "domain": "domain-1-user-auth",
  "plan": "specs/domain-1-user-auth/plan.json",
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
| `nos chat pair [--rotate]` | Pairing links for phones on the home network (spec-ui `dev-to-lan`) |
| `nos chat server [--port n]` | Run the server in the foreground |
| `nos chat hook` | Stop hook: hands queued messages to Claude Code |

- The project root is the nearest folder with `specs/` from the current directory (or `--root`).
- State: `specs/.chat/` (`sessions.json`, `server.json`, `server.log`, `token`, and a `.gitignore` of `*`).
- One server per project on 127.0.0.1, port `"chat": { "port" }` in `specs/config.json` (default 4611);
  a port held by another project's server gives a free port, recorded in `server.json`.
- `"chat"` in `specs/config.json`: `port`, `runner` (default true), `permissionMode` (default `auto`), `model`,
  `claude` (path of the executable).
- Env for tests: `NOS_CHAT_STATE_DIR`, `NOS_CHAT_PORT`, `NOS_CHAT_IDLE_MS` (`0`/`off` disables the 30 min idle exit).
- Design: `../ui/requirements/Technical design local web chat for Claude Code.md` and
  `../ui/requirements/Concept spec-ui chat integration.md`.

## Specs layout

```
specs/
├── config.json                 # "id-counters" (managed by nos), "quality-tools", "project-commands" and "spec-ui" (setup ability)
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
| `src/config.js`  | `specs/config.json` setup and id reservation     |
| `src/domain.js`  | `create-domain`                                  |
| `src/plan.js`    | `create-plan`                                    |
| `src/update-plan.js` | `update-plan`                                |
| `src/quick-step.js` | `create-quick-step`, `quick-steps.json` access |
| `src/status.js`  | `set-status` and `status.xml` parsing            |
| `src/slug.js`    | Slug validation                                  |
| `src/chat/`     | `nos chat`: session store, server, guard, page, client, Stop hook |
