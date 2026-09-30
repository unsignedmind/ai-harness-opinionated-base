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

| Command         | Description                                                                 |
| --------------- | --------------------------------------------------------------------------- |
| `init`          | Create `specs/` and `specs/config.json` if missing                          |
| `create-domain` | Reserve a domain id and create `specs/domain-<id>-<slug>/idea.md`           |
| `create-plan`   | Save a `plan.json` in a domain and create its phase folders and step files  |
| `update-plan`   | Save an updated `plan.json` and create, move or delete phases and steps     |
| `set-status`    | Change the status of a plan, phase or step in `plan.json`                   |

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
nos create-domain --idea <file|-> --slug <slug> [--root <dir>]
```

1. Creates `specs/` and `specs/config.json` if they are missing. If `.claude/skills/nos/templates/config.json` exists, `config.json` is copied from it.
2. Takes the next domain id from `specs/config.json` and increments the counter.
3. Creates `specs/domain-<id>-<slug>/` and saves the idea in it as `idea.md`.

```sh
$ nos create-domain --idea idea.md --slug user-auth
{
  "action": "create-domain",
  "id": 1,
  "folder": "domain-1-user-auth",
  "path": "specs/domain-1-user-auth",
  "idea": "specs/domain-1-user-auth/idea.md"
}
```

### `create-plan`

```sh
nos create-plan --domain <domain-<id>-<slug>> --plan <file|-> [--root <dir>]
```

1. For each phase, takes the next phase id and creates `specs/<domain>/phases/phase-<id>-<slug>/`.
2. For each step, reserves a step id and creates an empty `step-<id>-<slug>.md` in its phase folder.
3. Sets each step's `spec-file` field and saves `plan.json` in the domain.

The plan is validated before anything is written. Each domain can have only one plan.

Example `plan.json` (`phases` and `steps` can be arrays or single objects):

```json
{
  "name": "User auth",
  "status": "open",
  "labels": [],
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

### `set-status`

```sh
nos set-status --domain <domain-<id>-<slug>> [--phase <id>] [--step <id>] --status <status> [--root <dir>]
```

| Arguments                 | Changes the status of                                     |
| ------------------------- | --------------------------------------------------------- |
| `--domain` only           | the plan                                                  |
| `--phase <id>`            | that phase                                                |
| `--step <id>`             | that step (`--phase` is optional, but must match if given) |

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

## Specs layout

```
specs/
├── config.json                 # "id-counters" (managed by nos), "quality-tools" and "project-commands" (setup ability)
└── domain-1-user-auth/
    ├── idea.md
    ├── plan.json
    └── phases/
        └── phase-1-data-model/
            └── step-1-user-table.md
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
| `src/status.js`  | `set-status` and `status.xml` parsing            |
| `src/slug.js`    | Slug validation                                  |
