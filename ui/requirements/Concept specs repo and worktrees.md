# Concept: specs in own repo, plans in branches and worktrees

Status: concept, not implemented. Reviewed 2026-10-06 against the code and the Claude Code docs, design revised: nos runs from its own folder, git mechanics move into the CLI, one session per run with cwd = worktree. Review gaps folded in: run token as holder, slots as port leases, CLI as the only path resolver, one run per domain, absolute invocation everywhere. Revised again 2026-10-06 after a live run (D-11, D-12): specs root outside the checkout (`../<project>.specs`, Claude Code worktree isolation), nos never pushes code, the CLI is invoked only as the literal `node <home>/cli/bin/nos.js`. See "Rejected alternatives" for what was weighed and dropped.

## Context
Goal: plans and quick steps run in their own branch + git worktree, in parallel, while the spec state stays in one central place that all worktrees read and write.

Today:
- `specs/` is tracked in the project repo → every worktree has its own stale copy, specs merge-conflict between branches.
- `develop` commits code and spec file together (`abilities/develop.md` step6). `review-fixing` step7/8 and `architect` commit too.
- CLI root = `--root` or cwd (`cli/src/cli.js`), chat walks up to the dir containing `specs/` (`cli/src/chat/paths.js` `findRoot`, also `hook.js`). spec-ui resolves `specs/` relative to its own file (`ui/vite.config.ts`).
- `specs/config.json` mixes planning state (id-counters, chat) with project config (quality-tools, project-commands, spec-ui docs-folder).
- `spec-file` fields in `plan.json` / `quick-steps.json` are project-root relative with `specs/` prefix (`plan.js`, `quick-step.js`, `update-plan.js`). `quick-step.js` parses the id from `/quick-steps/step-<id>-`.
- Parallel orchestrators already exist: the chat runs one Claude Code process per tab, spawned in the project root with `--permission-prompts none` (`runner.js`).
- In this project `.claude/*` is gitignored and untracked. nos is a nested git repo with its own origin. A worktree of the project has no `.claude/`: no nos, no `settings.json`, no hook.

Constraints:
- Solo use, no team sync. But several orchestrators (chat tabs, terminals) at once.
- nos must stay portable: clone the nos repo into `<project>/.claude/skills/nos/` and it works, whether the project tracks `.claude/` or ignores it.
- Subagents (Agent tool) inherit the cwd of their session. There is no cwd or env parameter per subagent.
- Claude Code (verified in docs 2026-10-06): `EnterWorktree path=` enters an existing worktree if `git worktree list` knows it. Worktree → worktree only under `.claude/worktrees/`. A path outside `.claude/worktrees/` triggers an approval prompt no permission rule suppresses; the chat cannot answer prompts. Settings and skills are loaded from the launch dir and not reloaded on cwd change; a worktree without `.claude/` reads through to the launch dir. A resumed session restores its worktree. No env var exposes the session id to Bash.
- Claude Code worktree isolation (docs `worktrees.md` "How Claude Code enforces isolation", live run 2026-10-06): after `EnterWorktree` the session and its subagents may not Write/Edit/NotebookEdit any path inside the main checkout, also through junctions; Bash with cwd in the main checkout, git redirected into it (`git -C <main>`, `GIT_DIR`, `cd <main> && git`) and commands whose git target cannot be verified from the text (computed command names, e.g. `$NOS …`) are refused too. A sibling folder outside the repo stays writable (verified).

## Three ideas
1. **nos runs from its own folder.** `NOS_HOME` = the nos folder. CLI, spec-ui, chat server, abilities: always from there, always invoked by absolute path. A copy of nos inside a worktree is never executed.
2. **Git mechanics live in the CLI.** Worktree, rebase, gate, merge, lock, spec commits: `nos run …`, `nos gate`, `nos specs commit`. The orchestrator calls commands and reacts to exit codes. No ability types `git rebase`. The CLI is also the only place that builds paths.
3. **One session per run, cwd = its worktree.** The orchestrator session moves into the run's worktree. Subagents, tests and commits land there without instructions. Main is touched only by the CLI via `git -C <main>` (a session in a worktree cannot do that itself: isolation).

## Layout
```
<project>/                      project repo, main worktree. main moves by ff merges (exceptions: setup, migration)
  nos.config.json               tracked: project config, see config split. Root marker for the resolver. specs.dir "../<project>.specs"
  .gitignore                    contains ".claude/worktrees/"
  .claude/skills/nos/           NOS_HOME (tracked or ignored, does not matter)
  .claude/settings.local.json   written by setup: permissions (incl. additionalDirectories = the specs root) and hook, absolute paths. Never tracked
  .claude/worktrees/<kind>-<id>/  project worktree, branch plan-<id> or quick-<id>; no specs, maybe no .claude
<project>.specs/                the specs root <specs>, next to the checkout: own git repo, branch main, local (solo)
  .gitignore                    ".chat/", ".locks/", ".runs/"  (dot = local state, no dot = history)
  .gitattributes                "* text=auto eol=lf": LF working copies on every OS (project's attributes do not reach in)
  config.json                   planning state only: project (back-pointer "../<project>"), id-counters, chat
  domain-*/ ...
  .runs/<kind>-<id>.json        run registry, one file per running plan or quick step
  .chat/                        chat state, tls
  .locks/                       merge, ids, slot-<n>
```
- `<specs>` lies outside the checkout → never in a worktree → no stale copies. Spec changes never merge-conflict with code. One spec state over all branches, live in spec-ui. Spec commits never move the project's main ref, so they never race a merge.
- Outside, not inside: worktree isolation refuses writes into the main checkout from a worktree session and its subagents (junctions too). A sibling folder is writable from every run worktree. `nos roots` / `nos init` warn when a configured specs root lies inside the checkout.
- Not nested: the project's `git clean` / `git status` never see it, no gitignore entry needed.
- Name `<project>.specs`: clean break from the tracked `specs/`, so setup can tell the layouts apart. Outside the cwd → `Read`/`Grep`/`Glob` need the specs root as path; abilities always get it passed. Setup adds it to `permissions.additionalDirectories` in `settings.local.json`: default-mode sessions read and write it without prompts (auto mode needs none).
- Worktrees under `.claude/worktrees/`: required, not convenient. Any other path costs an approval prompt per entry, which the chat cannot answer, and blocks worktree → worktree switches. Setup adds the gitignore entry for projects that track `.claude/`.

## Config split
| File | Repo | Content | Why |
|---|---|---|---|
| `nos.config.json` | project | `specs: {dir, remote}`, `worktrees: {slots, slotWait}`, quality-tools, project-commands, spec-ui docs-folder | versioned with code; a branch may change its test command |
| `<specs>/config.json` | specs | project (back-pointer), id-counters, chat | planning state, one copy for all branches |

## Roots (no junction/symlink)
Junctions are machine/OS-specific and hold absolute paths → conflict with portability. The resolver lives once, in `cli/src`, shared by CLI, chat and spec-ui:
1. `NOS_HOME`: from `import.meta.url` of the running CLI.
2. **Work root**: `--root` flag, else `NOS_SPECS_ROOT` env, else walk up from cwd to the first `nos.config.json`. That is the checkout the caller sits in, main or worktree.
3. **Main root**: `git -C <work> rev-parse --path-format=absolute --git-common-dir` → parent. Not a git repo: work root.
4. **Specs root**: main root + `specs.dir` (relative to main or absolute; default `../<main folder name>.specs`, built once in `roots.js` `defaultSpecsDir`). Why outside: worktree isolation, see Layout.

Order matters: walking to `nos.config.json` first is what makes nested repos harmless. From inside nos, `--git-common-dir` would answer with the nested repo (verified); the walk lands on the project before git is asked. From inside the specs root (outside the project) the walk meets `<specs>/config.json` with `project` + `id-counters` first: work = main = that folder, verified to hold `nos.config.json` (else not set up). `nos init` writes the back-pointer.

Rules:
- **The CLI is the only resolver.** `nos roots` prints `{home, work, main, specs, inWorktree}`. Every CLI result prints absolute paths. `spec-file` fields are stored relative to the specs root, no `specs/` prefix. Migration rewrites existing entries, keeps `/quick-steps/step-<id>-` intact.
- The orchestrator runs `nos roots` once per run and passes `home`, `work`, `specs` to every subagent. Abilities use given paths and never construct one. An ability started without them runs `nos roots` itself.
- Absolute, literal invocation: orchestrator and abilities type out `node <home>/cli/bin/nos.js …` in every call, never through a shell variable, function or alias (isolation refuses computed command names). Guard: the CLI compares its own home with `<main>/.claude/skills/nos`; different → warning on stderr (a worktree copy is running).
- No machine paths in tracked files. Setup writes permissions and hook into `.claude/settings.local.json` with absolute paths and never touches `settings.json`. Holds for tracked and ignored `.claude/` alike.
- Chat: `findRoot` (commands, hook) replaced by the resolver. State dir `<specs>/.chat`, key = main path.
- Chat server (4611) and spec-ui (5180): one per project, started from `NOS_HOME`, no slot.

## Process model
- A chat tab or terminal session starts in main. No worktree per session. Settings and skills come from main for the whole session, also inside the worktree; nothing extra is passed on spawn.
- A worktree exists per **run**: plan 3 → `plan-3`, quick step 7 → `quick-7`. One run per domain at a time.
- Picking a run: `nos run start` (returns the run token), then the session enters the worktree (`EnterWorktree path=<wt>`). Chat: same, inside the tab's session; `sessions.json` stores the run. A restarted chat process resumes the session and lands in the worktree again.
- Run merged: session leaves the worktree (`ExitWorktree keep`, it never removes a worktree entered by path), then `nos run cleanup` deletes worktree and branch. Deleting the folder a process sits in fails on Windows, so this order. The same tab then starts the next run from main.
- Second session picks a running run → the run file names the holder → refuse. Stale holder → never auto-taken, the user decides (`nos run start --take-over`).

## Run registry: `<specs>/.runs/<kind>-<id>.json`
```json
{ "kind": "plan", "id": 3, "domain": "domain-2-auth", "branch": "plan-3",
  "worktree": "<abs>", "base": "<main sha the branch builds on>",
  "token": "<8 hex>", "started": "<iso>", "seen": "<iso>",
  "phase": "develop | integrate | gate | merge" }
```
- One file per writer: two orchestrators never write the same JSON. "What runs" = directory scan. `plan.json` and the quick step entry get only `branch` for display.
- **Token = holder.** `nos run start` mints it, stores it, returns it. Every mutating run command and the locks require `--token`, env `NOS_RUN_TOKEN` as fallback. Lock holder = run id + token; the same token re-takes its own lock, so a crashed `finish` resumes without deadlock. `--take-over` re-mints. Every token-bearing call updates `seen`; `nos run start` reports holder age on refusal. Cooperative guard against a double pick, not a security boundary: solo use.
- The token lives in the session's context (CLI output). A resumed chat session has it in its transcript. A fresh terminal session that wants the run takes it over on purpose.

## CLI owns git
| Command | Does | Exit |
|---|---|---|
| `nos roots` | the four roots | |
| `nos run start --domain <d> --plan <id>` or `--quick <id>` | precheck: domain not in `.runs/`, run file absent or same token. Worktree add + branch, run file with token, `project-commands.install`. Prints token and roots | 4 held by another token, 6 domain already running |
| `nos run sync --token` | worktree clean check, then rebase branch onto main in the worktree. Clean → update `base` | 5 dirty worktree (file list), 3 conflict, rebase left open, conflict list printed |
| `nos gate [--e2e]` | quality tools of the worktree's `nos.config.json`. Per tool pass/fail JSON. `--e2e` takes a slot lease for the duration, `NOS_SLOT` set | 1 fail, 7 no slot within `slotWait` |
| `nos exec <project-command>` | install / dev / deploy-test. dev holds a slot lease while it runs | 7 no slot within `slotWait` |
| `nos run finish --token` | lock → main-busy precheck → main-clean precheck → sync → gate → `git -C <main> merge --ff-only` → `set-status --run merged` → unlock. Phase recorded in the run file, a crash resumes at the phase under its own lock. Refused ff (cannot happen under the lock) → back to sync | 3 conflict, 5 dirty, 1 gate fail or main dirty or main busy, lock released, run parked |
| `nos run cleanup --token` | from main: worktree remove, branch delete, run file delete | |
| `nos run abandon --token` | `set-status --run discarded`, cleanup, specs stay as history | |
| `nos specs commit --run <kind>-<id> -m "step-<id>: <what>"` | `git -C <specs> add config.json <domain dir>` + commit, retry on `index.lock`, push when `specs.remote` set. Never `add -A`. Exact because one run owns a domain | |
| `nos specs find-step <id>` | spec file of a step id, any domain | |
| `nos set-status --run <kind>-<id> merged\|discarded` | flips plan, phases, steps or the quick step of a branch in one write | |
| `nos lock take\|release\|status merge --token` | `mkdir`-based (atomic), holder file = run id, token, timestamp. Reentrant per token. Never auto-broken. `--break` is the user's call | |

Exit codes: 0 ok, 1 failed, 2 usage, 3 rebase conflict, 4 run held by another holder, 5 dirty worktree, 6 domain already running, 7 slot wait timeout. 3 from sync or finish → orchestrator runs ability "integrate", then repeats the same command. 5 → orchestrator commits with the current step prefix or parks.

## Unit of work: branch + worktree, plans and quick steps alike

### Lifecycle
1. Start: `nos run start`, enter the worktree.
2. Steps: specify / review / develop run as today, in the worktree, specs written centrally.
3. **Sync before every develop step**: `nos run sync`. Conflict → ability "integrate" first, then develop. Conflicts surface early, per step, small.
4. Step done: status `done`, code on the branch only.
5. Integrate at the end: plan → user decides (orchestrator asks), quick step → automatic after `done` (review or not). `nos run finish`.
6. Merged: leave worktree, `nos run cleanup`.
7. Abandon: `nos run abandon`.

### Merge protocol (ff-only under a lock, inside `nos run finish`)
Git protects the ref, not the workflow: two merges seconds apart → the second is no fast-forward and must rebase and rerun the gate. The gate is the slow part, so the whole integrate phase serializes:
1. Take `<specs>/.locks/merge`. Held by another token → park, report the holder. Own token → continue (resume).
2. Main busy precheck: `git -C <main> rev-parse -q --verify` of MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD (one call each), or a `rebase-merge` / `rebase-apply` folder in main's git dir (not REBASE_HEAD: git leaves it behind after a finished rebase), any hit → release, park, report "main busy".
3. Main clean precheck: `git -C <main> status --porcelain` on the paths the branch touches. Dirty → release, park, report.
4. Worktree clean check, then rebase branch onto main. Conflict → release, ability "integrate", repeat finish.
5. Gate in the worktree. Fail → release, park, report.
6. `merge --ff-only`. `set-status --run merged`.
7. Release lock.
Develops stay parallel, only merges serialize. First done, first merged. Others pick up main at their next sync. Dirty worktrees are refused, never autostashed: a stash hides state from the integrate ability and pops into conflicts silently.

### Ability "integrate" (the merge agent)
Input: the run file, the worktree with the stopped rebase. `git log <base>..main --format=%s` → `step-<id>` prefixes → `nos specs find-step` → the spec files of the work already merged.
1. Read own step spec and the specs of the conflicting commits.
2. Resolve each conflict with the intent of both sides. Both specs want contradictory things → stop, park, report both specs cited.
3. `git rebase --continue`, then `nos gate`.
4. Note the resolution in the Dev Log marked (merge).
Only place where two specs are read together.

### Slots: a lease on ports, not a run attribute
Parallel develops collide on ports, not on git. A slot is only needed while a server runs, so it is taken when needed and released after:
- `nos gate --e2e` and `nos exec dev` take the smallest free `<specs>/.locks/slot-<n>`, n in 1..`worktrees.slots` (default 1), for the duration of the command, `NOS_SLOT=n` in the child env. `exec dev` holds it until the server exits.
- None free → wait up to `worktrees.slotWait` seconds (default 600), then exit 7. Develops never block on slots; only e2e runs and dev servers queue. Default slots 1 serializes e2e instead of refusing the second run.
- Abilities run project commands only through `nos gate` / `nos exec`, never directly.
- Project specific: `project-commands` and e2e config derive port and base url from `NOS_SLOT`. In this project: `playwright.config.ts` (preview 4173 + slot, baseURL) and `vite.config.ts` (5173 + slot). Setup runs `nos exec dev` once per slot to verify. Setup proposes 3 slots when e2e is configured.

### Concurrent writers on `<specs>`
- `reserveIds`: read-modify-write → lock `<specs>/.locks/ids` around it (CLI internal).
- Commits: `nos specs commit`, retry on `index.lock`, domain-scoped add. Exact because a domain has at most one run.
- Run registry: one file per run, token check on every mutating command.
- Parallelism through separate sessions, one run per session, one run per domain. `workflow.md` stays single-run; coordination lives in `<specs>/.runs` and locks.

## Commits (orchestrator owns `<specs>`)
- Subagents write spec files and never run `git -C <specs>`. Only the orchestrator commits `<specs>`, via `nos specs commit`. A rule, not a technical barrier.
- `develop`, `review-fixing`, `architect` commit **code or docs only**, in the worktree (their cwd), prefix `step-<id>` / `phase-<id>` / `architect`. Never a push: nos never pushes code, the user pushes (D-12; auto mode also denies `--force-with-lease` after a rebase). Only `nos specs commit` pushes the specs repo, opt-in via `specs.remote`. `review-fixing` references the prefix, not a sha. Orchestrated runs always commit (standalone review-fixing leaves fixes uncommitted, but never runs inside a run).
- Orchestrator: `nos specs commit` after each ability returns.
- Link code ↔ spec by the `step-<id>` prefix, not by SHA. SHAs do not survive rebase; the prefix does. `review-pessimistic` keeps its prefix scope. Statuses `merged` are set by `finish` for the whole branch, so spec-only steps without a code commit flip too.

## Statuses
`templates/status.xml`: plan, quick step and step get `merged` (branch is on main) and `discarded` (abandoned, not merged). Transitions: `done → merged`; any status except `merged → discarded`. Plan `done` = all phases done on the branch, not yet merged. Phases: no new status, a merged plan shows via the plan. `nos set-status --run` applies the transition to every target of the branch in one write; `finish` and `abandon` are its only callers.

## Setup skill (idempotent, any project)
No migration logic in nos. Two states:
1. Fresh: `nos init` creates `nos.config.json` from template with `specs.dir "../<project>.specs"`, `git init -b main` in the sibling `<specs>`, writes `<specs>/.gitignore` (`.chat/`, `.locks/`, `.runs/`), `<specs>/.gitattributes` (`* text=auto eol=lf`) and `<specs>/config.json` (id-counters, back-pointer `project`), the project `.gitignore` entry `.claude/worktrees/` (plus `<specs.dir>/` only for a specs root inside the project), then quality tools + project commands + slots + slot verification.
2. New layout exists: check only, fill a missing config, offer a remote.
3. Optional remote (backup only): `nos.config.json` → `specs.remote`. Fresh clone setup runs `git clone <remote> <specs>`; `<specs>/.chat` is recreated by `ensureStateDir`.
Settings: `permissions.additionalDirectories` = the absolute specs root, permissions and hook entries for the chat go to `.claude/settings.local.json`, pointing at `node <NOS_HOME>/cli/bin/nos.js`. `settings.json` is never written. Setup commits `nos.config.json` and `.gitignore` directly on main (listed exception).
Old layout (`specs/` tracked) is not detected and not handled. Only this project has it, see below.

## Migration of this project (one-off, last step, by hand)
Separate plan step, no code. Runs once on moodo-poc after every other step is merged. Rehearsed 2026-10-06 on a sandbox copy (with `.specs` inside; target moved to the sibling folder afterwards, D-11). Git Bash, working tree clean, `P` = project, `H` = NOS_HOME, `S` = `$P/../moodo-poc.specs` (the specs root, next to the checkout), `T` = scratch dir outside the project:
Preconditions: chat server and spec-ui stopped; `git status --short` empty; `git status --short --ignored specs` lists only `specs/.chat/` (move anything else out); record `git log --oneline -- specs | wc -l` and `git rev-parse main:specs`.

1. split: `git clone --bare --no-local --single-branch -b main $P $T/specs-split.git`, in it `git filter-branch --prune-empty --subdirectory-filter specs -- main`. Not `git subtree split`: it leaks project history (full project trees as parents) when `specs/` was deleted and re-added. Check: commit count and `main^{tree}` = baseline, no commit has `package.json`. Bare, because a non-bare clone of moodo fails its checkout on Windows
2. `git init -b main $S`, write `$S/.gitattributes` (`* text=auto eol=lf`; moodo: plus `slop-to-clean-arch-migration/** -text`) **before** `git -C $S pull --ff-only $T/specs-split.git main`. The project's `.gitattributes` does not reach into the specs repo; with `core.autocrlf=true` the working copies would come out CRLF. Check `git -C $S ls-files --eol`
3. move `specs/.chat` (incl. tls, sessions) to `$S/.chat`, write `$S/.gitignore` (`.chat/`, `.locks/`, `.runs/`)
4. `$S/config.json`: keep `id-counters` (+ `chat` if present), drop the rest; add the back-pointer `"project": "../moodo-poc"` (or let step 7's `nos init` add it). Steps 4 and 5 are one node script
5. `nos.config.json` from the template: `specs.dir "../moodo-poc.specs"`, `worktrees {slots, slotWait}`, `quality-tools` (template `timeout` kept), `project-commands`, `spec-ui.docs-folder` from the old config. Project formats JSON with prettier → `npx prettier --write nos.config.json` (else `format-check` fails on it)
6. drop the `specs/` prefix of every `spec-file` in `plan.json` / `quick-steps.json` with a JSON-safe node script (not sed): keeps indentation and EOL, reports stale paths (left as they are, fixed separately). Check: no `"spec-file": "specs/` left, the diff touches only spec-file lines
7. project: `git rm -r -q --cached specs`, delete folder, `nos init --root $P` (idempotent: appends only the missing `.claude/worktrees/` entry, via `git check-ignore`, no `.specs/` entry since `$S` lies outside; writes a missing back-pointer into `$S/config.json`; no specs commit since `$S` has a HEAD), `git add .gitignore nos.config.json`, commit `nos: move specs to own repo`
8. `git -C $S add -A && git -C $S commit -m "nos: config split"` (`.gitattributes`, `.gitignore`, config with back-pointer, rewritten plans; `.runs/`, `.locks/`, `.chat/` ignored), delete `$T/specs-split.git`
9. `.claude/settings.local.json`: `Bash(node <H>/cli/bin/nos.js)` and `… *` with absolute paths, `permissions.additionalDirectories: ["<abs $S, forward slashes>"]`; no hook (runner mode). Remove the nos entries (relative permissions, Stop hook) from `settings.json`
10. verify: `nos roots` from `$P`, `$H`, `$S`, `$S/<a domain>`, `src` print the same specs root (no "inside the checkout" warning); spec-ui shows all domains, `/__runs` empty; chat lists the migrated sessions; `nos gate`
Cutover gotcha: the plan that implements this change is itself tracked in `specs/` and runs the old way on main. Its last step is this migration. Mark the step done after the migration with the new CLI on the migrated `$S`, not before.

## Portability
- All paths relative to specs root, work root or `NOS_HOME`. Only hardcoded thing: the CLI's specs default `../<main folder name>.specs` (`defaultSpecsDir`).
- The specs root sits next to the project folder: both move together, `specs.dir` and the back-pointer are relative. A project moved alone → not set up until `specs.dir` or the folder is fixed; `nos init` rewrites a stale back-pointer.
- Plain git only: no junctions, nothing OS-specific. Locks are directories with a holder file.
- Tracked footprint in the project: `nos.config.json`, one `.gitignore` entry (`.claude/worktrees/`). `.claude/skills/nos/` tracked or not, both work: invocation is absolute, machine paths sit in `settings.local.json`.
- No git repo → work root = main root, worktree features off, everything runs in cwd, one orchestrator.

## Impact (when implemented), build order
1. CLI: resolver + `nos roots` + home guard, `nos.config.json` reader, the specs default (`defaultSpecsDir`, `../<name>.specs`) as single source, `spec-file` relative to specs root, absolute paths in every result, run registry with token, locks (ids, merge, slots, reentrant per token), `nos specs commit`, `nos specs find-step`, `nos gate` with slot lease, `nos exec`.
2. CLI: `nos run start|sync|finish|cleanup|abandon`, statuses `merged` / `discarded`, `set-status --run`.
3. Paths in abilities: all eleven abilities, `workflow.md` (`<start>`, options) and the templates stop building `specs/...` paths and use the roots the orchestrator passes. Own step, checklist per file.
4. `develop.md` step6, `review-fixing` step7/8, `architect`: code only, gate via `nos gate`. `workflow.md`: run start + enter worktree, roots once per run, sync before develop, `<specs>` commit after each ability, finish/cleanup, resume rule "rebase in progress → integrate", exit code handling (3, 5, 7). New ability `integrate`. `templates/quality-tools.md`: reads `nos.config.json`, documents `NOS_SLOT`, `nos gate`, `nos exec`.
5. Chat: `paths.js`, `hook.js` on the resolver, `runner.js` run in `sessions.json`. spec-ui (`ui/vite.config.ts`, `src/serve-specs.ts`): resolver, `nos.config.json` for docs-folder, runs list, branch badge, ahead/behind main, running indicator. No merge button.
6. Setup: fresh + check only, slots, `settings.local.json`. Then the manual migration of this project.
7. This project: `NOS_SLOT` in `playwright.config.ts` and `vite.config.ts`.

Step 1 includes a check, not a mechanism: enter a worktree without `.claude/` from a chat session and confirm permissions, hook and skills still apply (docs say they read through from the launch dir).

## Risks
- Specs not visible in PRs / CI. Mitigation: `specs.remote`.
- No remote → specs only on this disk.
- `<specs>` repo dirty if an ability fails before the orchestrator commits → `nos run start` commits or reports leftovers of its own domain.
- Stale lock or run file after a crashed orchestrator → never auto-broken, the user breaks it. The CLI reports holder and age (`seen`).
- Two plans that touch the same code: allowed, but the integrate ability carries the cost. User should not start them on purpose. Same domain is refused.
- Token is cooperative: a session that reads the run file can act as holder. Acceptable for solo use; `--take-over` is the honest path.
- Specs root configured inside the checkout (`specs.dir ".specs"`): worktree sessions cannot write it. `nos roots` / `nos init` warn.
- Specs root outside the checkout: a project moved without its sibling folder is not set up until fixed (see Portability). Tools see it only with the path passed (Read/Grep/Glob), default-mode permissions need `additionalDirectories` (setup writes it).
- Worktree isolation also refuses computed command names and git redirected into main: a session that calls nos through `$NOS` or runs `git -C <main>` is blocked. Abilities and workflow forbid both; git against main runs only inside nos commands.
- A merge into main updates `.claude/skills/nos` only in projects that track it. Here nos is its own repo, unaffected. The home guard warns when a worktree copy runs.

## Rejected alternatives
- **Specs tracked on main, resolver points at `<main>/specs`, orchestrator commits on main.** Gives PR visibility and backup for free, no migration. Rejected: every spec commit moves the main ref, so a `finish` that rebased and is running the gate under the lock is beaten by any orchestrator's spec commit and its ff-merge fails. Fixing that means spec commits take the merge lock, blocking spec writes for the length of a gate. Spec state and code integration are orthogonal and must not share a ref. A tracked `specs/` also leaves a stale copy in every worktree that a subagent can Grep by accident.
- **Specs inside the checkout (`.specs`, ignored by the project).** Was the design until the live run 2026-10-06: Claude Code worktree isolation blocks writes to the main checkout from worktree sessions and subagents, also through junctions. The specs are written from run worktrees all the time, so the specs root moves next to the checkout.
- **Junction or symlink `specs` → `<specs>`.** Machine paths, OS-specific, not portable. A junction into the main checkout is also refused by worktree isolation.
- **Pushing run branches from develop / review-fixing / architect.** Auto mode denies `--force-with-lease` after a rebase, and a push is the user's call. nos never pushes code (D-12).
- **Slot per run, allocated at start.** Refuses the second run when slots are exhausted although develops do not need ports. A slot is a lease on ports; take it at gate or dev time.
- **Session id as holder.** No env var exposes it to Bash; the chat could inject one but a terminal session cannot. Two identity sources for one check. A run token works the same everywhere.
- **Autostash on sync.** Hides state from the integrate ability, stash pop conflicts are silent.
- **`--settings <main>/.claude/settings.json` on spawn.** Redundant: settings and skills are not reloaded on cwd change; a worktree without `.claude/` reads through to the launch dir.
- **Scoped commits to let two runs share a domain.** One run per domain is one check and makes the domain-scoped add exact; scoped commits would need the current step in the run file and still leak `plan.json` edits.

## Open
- spec-ui: trigger `nos run finish` from the UI later? Needs a session to run the gate, so orchestrator only for now.
- Dev server per slot: only when e2e is configured. Without e2e slots default 1 and nothing ever waits.
