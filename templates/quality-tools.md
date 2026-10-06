# Quality tools

Project specific commands live in `nos.config.json` at the project root. It is tracked and versioned with the code: a branch may change its test command, and `nos` reads the file of the checkout it runs in (main or a run's worktree). The setup ability fills it. Never invent or guess a command.

`nos` = `node <home>/cli/bin/nos.js`, `<home>` = the nos folder (given, or the `home` from `nos roots`).

```json
"worktrees": {
  "slots": 1,
  "slotWait": 600
},
"quality-tools": {
  "test": "npm test",
  "lint": "npm run lint",
  "format-check": "npm run format:check",
  "typecheck": "npm run typecheck",
  "e2e": "npm run e2e",
  "additional": ["npm run knip"]
},
"project-commands": {
  "install": "npm ci",
  "dev": "npm run dev",
  "deploy-test": "npm run deploy:test"
},
"spec-ui": {
  "docs-folder": "docs"
}
```

## Keys

| Node             | Key          | Meaning                                                            |
| ---------------- | ------------ | ------------------------------------------------------------------ |
| quality-tools    | test         | full test suite: unit and integration                              |
| quality-tools    | lint         | linter                                                             |
| quality-tools    | format-check | formatter check, never the write variant                           |
| quality-tools    | typecheck    | type checker                                                       |
| quality-tools    | e2e          | end-to-end tests in a real browser or app                          |
| quality-tools    | additional   | list of further checks, e.g. dead code, i18n, bundle size: a command string (named additional-<n>) or { "name", "cmd" } |
| quality-tools    | timeout      | minutes one tool may run before `nos gate` kills it (status fail, "timedOut": true), default 30 |
| project-commands | install      | installs dependencies, e.g. in a fresh worktree; with a lockfile the variant that never rewrites it (`npm ci`), so the worktree stays clean |
| project-commands | dev          | starts the local dev server                                        |
| project-commands | deploy-test  | deploys to a test environment and prints a url                     |
| spec-ui          | docs-folder  | docs folder shown in the spec UI (Docs), relative to the repo root |
| worktrees        | slots        | parallel e2e runs and dev servers (port sets), default 1           |
| worktrees        | slotWait     | seconds to wait for a free slot, default 600                       |

`null` or missing key → tool not available. `worktrees` and `specs` are read from main's `nos.config.json`, the other nodes from the checkout's.

## Rule

Run project commands only through `nos gate` and `nos exec`. Never run a configured command (or `npm test`, `npm run dev`, …) directly: only `nos` reads the right `nos.config.json`, takes a slot for e2e and dev servers, sets `NOS_SLOT` and keeps the logs.

Exception while developing: a single unit or integration test file may run directly with the project's test runner (e.g. `npx vitest run src/cart/total.test.ts`), because it opens no ports. e2e, dev servers and the full configured commands only via `nos gate` / `nos exec`.

## Quality check: `nos gate [--e2e]`

1. Run `nos gate` in the checkout you work in (your cwd, `<work>`). It runs test, lint, format-check, typecheck and each `additional` entry, in order, all of them even after a failure.
2. Add `--e2e` only when the Test Strategy of the target says e2e yes or lists an existing e2e test. e2e null then → its status is `not-configured`, report it.
3. Output:
   ```json
   { "action": "gate", "pass": false,
     "tools": [{ "name": "test", "cmd": "npm test", "status": "fail", "exit": 1, "timedOut": false, "tail": "<last 60 lines>", "log": "<abs path>" },
               { "name": "e2e", "cmd": null, "status": "not-configured" }] }
   ```
   `status` is `pass`, `fail` or `not-configured`. Read `tail` first, the full output is in `log` (`<specs>/.runs/logs/<run|main>/<tool>.log`).
4. Exit codes: `0` all pass. `1` a tool failed, or `quality-tools` is not set up → stop, report blocked: "quality tools not configured, run setup". `7` no slot free within `slotWait` (e2e only) → report blocked: "no slot".
5. Name tools with status `not-configured` as "not configured: <key>" in the Dev Log or report.

## Project commands: `nos exec <install|dev|deploy-test>`

- Runs the checkout's `project-commands` entry with the output inherited. The exit code is the command's. A `null` command → exit 1.
- `install`: dependencies, e.g. in a fresh worktree (`nos run start` runs it).
- `dev`: takes a slot and holds it until the server exits. Stop the server when done, so the slot is free again.
- `deploy-test`: deploys to a test environment.

## Slots and `NOS_SLOT`

- A slot is a lease on a set of ports, not a run attribute. `nos gate --e2e` (only around the e2e tool) and `nos exec dev` take the smallest free slot `n` in `1..slots` and set `NOS_SLOT=n` in the command's environment. None free → wait up to `slotWait` seconds, then exit 7.
- The project derives ports and base url from `NOS_SLOT`, e.g. dev port `5173 + NOS_SLOT`, preview/e2e port `4173 + NOS_SLOT`. Unset (a plain `npm run …` by a human) → the project's defaults.
- Every tool also gets `NOS_HOME` (the nos folder).
