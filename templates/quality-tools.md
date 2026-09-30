# Quality tools

Project specific commands live in `specs/config.json`. The setup ability fills them. Never invent or guess a command.

```json
"quality-tools": {
  "test": "npm test",
  "lint": "npm run lint",
  "format-check": "npm run format:check",
  "typecheck": "npm run typecheck",
  "e2e": "npm run e2e",
  "additional": ["npm run knip"]
},
"project-commands": {
  "install": "npm install",
  "dev": "npm run dev",
  "deploy-test": "npm run deploy:test"
}
```

## Keys

| Node             | Key          | Meaning                                                           |
| ---------------- | ------------ | ----------------------------------------------------------------- |
| quality-tools    | test         | full test suite: unit and integration                             |
| quality-tools    | lint         | linter                                                            |
| quality-tools    | format-check | formatter check, never the write variant                          |
| quality-tools    | typecheck    | type checker                                                      |
| quality-tools    | e2e          | end-to-end tests in a real browser or app                         |
| quality-tools    | additional   | list of further checks, e.g. dead code, i18n, bundle size         |
| project-commands | install      | installs dependencies, e.g. in a fresh worktree                   |
| project-commands | dev          | starts the local dev server                                       |
| project-commands | deploy-test  | deploys to a test environment and prints a url                    |

`null` or missing key → tool not available.

## Quality check

1. `specs/config.json` or its `quality-tools` node missing → stop. Report blocked: "quality tools not configured, run setup"
2. Run in order: test, lint, format-check, typecheck, each `additional` entry. Skip null keys
3. e2e only when the Test Strategy of the target says e2e yes or lists an existing e2e test. e2e null then → report it
4. Name skipped keys as "not configured: <key>" in the Dev Log or report
