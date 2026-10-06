import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CHAT_HELP } from './chat/commands.js';
import { createDomain } from './domain.js';
import { EXIT, NosError } from './exit-codes.js';
import { execCommand } from './exec.js';
import { runGate } from './gate.js';
import { initProject } from './init.js';
import { listLocks, lockStatus, publicHolder, releaseLock, takeLock } from './lock.js';
import { createPlan } from './plan.js';
import { createQuickStep } from './quick-step.js';
import { homeGuard, NOS_HOME, resolveRoots, slash } from './roots.js';
import { abandonRun, cleanupRun, finishRun, startRun, syncRun } from './run.js';
import { readRun, requireToken } from './runs.js';
import { commitSpecs, domainOfTarget, findStep } from './specs-git.js';
import { setRunStatus, setStatus } from './status.js';
import { updatePlan } from './update-plan.js';

export const USAGE = `nos - file manager for the nos harness

Usage: nos <command> [options]

Commands:
  init               Set up the nos layout: nos.config.json, .specs/ (own git repo), .gitignore entries
  roots              Print the resolved roots: home, work, main, specs, inWorktree, configured
  create-domain      Reserve a domain id and create <specs>/domain-<id>-<slug>/idea.md
  create-plan        Save a plan.json in a domain and create its phase folders and step files
                     (--hollow: an empty plan.json, promotes the domain unplanned)
  update-plan        Save an updated plan.json and create, move or delete phase folders and step files
  create-quick-step  Add a quick step (no plan) to <specs>/<domain>/quick-steps/
  set-status         Change the status of a plan, phase, step or quick step
                     (--run <kind>-<id> merged|discarded: a whole run, only run finish / abandon)
  run <command>      Run lifecycle: start, sync, finish, cleanup, abandon (branch + worktree per run)
  specs commit       Commit config.json + one domain folder of the specs repo (--run, --domain or --config)
  specs find-step    Find the spec file of a step id in any domain
  gate               Run the quality tools of nos.config.json (--e2e: also e2e, under a slot lease)
  exec <name>        Run a project command: install, dev (holds a slot while it runs), deploy-test
  lock <action>      take, release or status of a lock in <specs>/.locks (merge, ids, slot-<n>)
  chat <command>     Local chat with this Claude Code session (nos chat --help)
  help <command>     Show detailed help for a command

Options:
  -h, --help         Show help (after a command: help for that command)
  --root <dir>       Work root (default: NOS_SPECS_ROOT, else the nearest folder with nos.config.json
                     from the current directory, else the current directory)

Roots: work = the checkout you sit in (main or a git worktree), main = the main checkout,
specs = main + "specs.dir" of nos.config.json (default .specs). See "nos help roots".
Every command except init and roots needs a project set up by nos init: without nos.config.json
it fails with "nos is not set up here".
Slugs are never generated: they must be lowercase kebab-case (e.g. user-auth).
Pass "-" to read an input from stdin. Results are printed as JSON, paths absolute with forward slashes.
"spec-file" values are relative to the specs root, e.g. domain-1-auth/phases/phase-1-a/step-2-b.md.
Exit codes: 0 ok, 1 operation failed, 2 usage error / missing input, 3 conflict, 4 held by another
holder, 5 dirty worktree, 6 domain already running, 7 slot timeout. For 3-7 stdout has
{ "action", "error", "exit", "details" }.`;

const INIT_HELP = `Usage: nos init [--root <dir>]

Set up the nos layout of a project. Idempotent: only missing parts are created.
Refused inside a git worktree (the layout belongs to the main checkout).
Without nos.config.json and without --root / NOS_SPECS_ROOT, run it from the project root: refused
in a subfolder of a git repo and inside the nos folder (e.g. <project>/.claude/skills/nos).

  1. Creates nos.config.json from templates/nos.config.json of this nos if missing
  2. Creates .specs/ (specs.dir) with config.json (id-counters, from templates/config.json)
     and .gitignore (.chat/, .locks/, .runs/)
  3. Git project: appends ".specs/" and ".claude/worktrees/" to the project .gitignore unless a
     .gitignore of the repo already ignores them (e.g. ".claude/*"), in the file's line ending
  4. Git available: "git init -b main" in .specs, first commit "nos: init",
     and "git remote add origin <specs.remote>" when specs.remote is set and origin is missing
     (an origin with another URL is reported as "mismatch", never changed)
  Commits nothing in the project. Existing files are never changed (except appended .gitignore entries).

Options:
  --root <dir>     Project root (default: see nos --help)

Example:
  nos init
  {
    "action": "init",
    "main": "D:/repo",
    "specs": "D:/repo/.specs",
    "created": ["D:/repo/nos.config.json", "D:/repo/.specs", "D:/repo/.specs/config.json", ...],
    "existing": [],
    "gitignoreAdded": [".specs/", ".claude/worktrees/"],
    "commit": "<sha of the first .specs commit, null when it existed>",
    "remote": null
  }`;

const ROOTS_HELP = `Usage: nos roots [--root <dir>]

Print the roots every other command uses. The CLI is the only resolver of nos paths.

  home        the nos folder of this CLI (templates are read from <home>/templates)
  work        --root, else NOS_SPECS_ROOT, else the nearest folder with nos.config.json
              from the current directory, else the current directory. Main or a worktree.
              A walk that climbed out of a worktree (its branch has no nos.config.json yet)
              is brought back into it
  main        the main checkout: top of git's main worktree (+ the project's subfolder in
              the repo, if any). Not a git repo: work
  specs       main + "specs.dir" of main's nos.config.json (default .specs)
  inWorktree  work is a linked git worktree of main
  configured  a nos.config.json exists in work or main (false: run nos init)

Walking up to nos.config.json first makes nested repos harmless: from <main>/.claude/skills/nos
or <main>/.specs the result is the project, not the nested repo.
Warns on stderr when this nos is not <main>/.claude/skills/nos or lies under <main>/.claude/worktrees/.

Options:
  --root <dir>     Work root (default: see above)

Example:
  nos roots
  {
    "action": "roots",
    "home": "D:/repo/.claude/skills/nos",
    "work": "D:/repo/.claude/worktrees/quick-7",
    "main": "D:/repo",
    "specs": "D:/repo/.specs",
    "inWorktree": true,
    "configured": true
  }`;

const CREATE_DOMAIN_HELP = `Usage: nos create-domain --idea <file|-> --slug <slug> [--name <name>] [--labels <a,b>] [--root <dir>]

Create a new domain for an idea.

  Needs a project set up by nos init (<specs>/config.json).
  1. Takes the next domain id from <specs>/config.json and increases the counter
  2. Creates <specs>/domain-<id>-<slug>/ and saves the idea as idea.md in it
  3. Saves domain.json in it: { "name", "labels", "cross-cutting": false }

Options:
  --idea <file|->  Idea markdown file, or "-" to read it from stdin   (required)
  --slug <slug>    Slug for the folder name, lowercase kebab-case     (required)
  --name <name>    Domain name (default: first "# " heading of the idea without "Idea:")
  --labels <a,b>   Comma separated labels, lowercase kebab-case (default: none)
  --root <dir>     Work root (default: see nos --help)

Example:
  nos create-domain --idea idea.md --slug user-auth --labels auth,ui
  {
    "action": "create-domain",
    "id": 1,
    "folder": "domain-1-user-auth",
    "path": "D:/repo/.specs/domain-1-user-auth",
    "idea": "D:/repo/.specs/domain-1-user-auth/idea.md",
    "domain": "D:/repo/.specs/domain-1-user-auth/domain.json"
  }`;

const CREATE_PLAN_HELP = `Usage: nos create-plan --domain <domain-<id>-<slug>> (--plan <file|-> | --hollow) [--root <dir>]

Lay out the spec files for a plan in an existing domain.

  1. For every phase: takes the next phase id and creates
     <specs>/<domain>/phases/phase-<id>-<slug>/
  2. For every step: reserves a step id and creates an empty
     step-<id>-<slug>.md in its phase folder
  3. Fills each step's "spec-file" (relative to the specs root:
     <domain>/phases/phase-<id>-<slug>/step-<id>-<slug>.md) and saves plan.json in the domain

Nothing is written when the plan is invalid. A domain can only be planned once.

--hollow promotes a domain without planning it: it saves only
  { "name": <domain.json name>, "status": "open", "phases": [] }
and creates no folders. A hollow plan (no phases, no phase folders) is filled
by a later create-plan with --plan.

Options:
  --domain <name>  Domain folder name, e.g. domain-1-user-auth        (required)
  --plan <file|->  plan.json file, or "-" to read it from stdin       (required unless --hollow)
  --hollow         Save an empty plan.json instead (no --plan)
  --root <dir>     Work root (default: see nos --help)

plan.json ("phases" and "steps" may be arrays or single objects):
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
Every phase and step needs a "slug" (lowercase kebab-case). Other fields are kept as-is,
except "labels": labels belong to the domain (domain.json) and are dropped.

Example:
  nos create-plan --domain domain-1-user-auth --plan plan.json
  -> <specs>/domain-1-user-auth/plan.json
     <specs>/domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md
     "spec-file": "domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md"

  nos create-plan --domain domain-2-dark-mode --hollow
  -> <specs>/domain-2-dark-mode/plan.json  { "name": "Dark mode", "status": "open", "phases": [] }`;

const UPDATE_PLAN_HELP = `Usage: nos update-plan --domain <domain-<id>-<slug>> --plan <file|-> [--dry-run] [--force] [--root <dir>]

Replace the plan of a domain with an updated plan.json and bring the folders in line with it.
Start from the current <specs>/<domain>/plan.json and edit it:

  - Existing steps are recognised by their "spec-file" (relative to the specs root). Keep it unchanged.
    A spec-file with the old "specs/" prefix is refused: run the migration.
  - A step with an empty "spec-file" is new: it gets a new id and an empty step file.
  - Existing phases are recognised by their "slug" (phase-<id>-<slug>). A phase with a
    new slug is created with a new id; renaming a phase slug therefore replaces the phase.
  - A kept step whose phase or slug changed is moved/renamed and keeps its id and content.
  - Phase folders and step files that are no longer in the plan are deleted.

Nothing is written when the plan is invalid. Deleting a step file that has content, or a
phase folder containing other files, is refused unless --force is given.
Ids of deleted phases and steps are never reused.

Options:
  --domain <name>  Domain folder name, e.g. domain-1-user-auth        (required)
  --plan <file|->  Updated plan.json file, or "-" to read it from stdin (required)
  --dry-run        Print the changes without writing anything
  --force          Also delete step files and phase folders that have content
  --root <dir>     Work root (default: see nos --help)

Example:
  nos update-plan --domain domain-1-user-auth --plan plan.json
  {
    "action": "update-plan",
    "domain": "domain-1-user-auth",
    "plan": "D:/repo/.specs/domain-1-user-auth/plan.json",
    "dryRun": false,
    "created": {
      "phases": [{ "id": 3, "folder": "phase-3-sessions", "path": "D:/repo/.specs/.../phase-3-sessions" }],
      "steps": [{ "id": 5, "path": "D:/repo/.specs/.../phase-3-sessions/step-5-session-store.md",
                  "specFile": "domain-1-user-auth/phases/phase-3-sessions/step-5-session-store.md" }]
    },
    "moved": [],
    "deleted": {
      "phases": [],
      "steps": [{ "id": 2, "path": "D:/repo/.specs/.../phase-1-data-model/step-2-hashing.md", "empty": true }]
    }
  moved entries: { "id", "from", "to" (absolute paths), "specFile" (the new spec-file) }
  }`;

const CREATE_QUICK_STEP_HELP = `Usage: nos create-quick-step --domain <domain-<id>-<slug>> --step <file|-> [--root <dir>]

Add a quick step to an existing domain. A quick step is a single step outside any plan.

  1. Reserves a step id (same counter as plan steps, so ids stay unique)
  2. Creates <specs>/<domain>/quick-steps/step-<id>-<slug>.md (empty)
  3. Appends the step to <specs>/<domain>/quick-steps/quick-steps.json with its "spec-file"
     (<domain>/quick-steps/step-<id>-<slug>.md, relative to the specs root) filled and status "open"

Options:
  --domain <name>  Domain folder name, e.g. domain-1-user-auth        (required)
  --step <file|->  Quick step JSON file, or "-" to read it from stdin (required)
  --root <dir>     Work root (default: see nos --help)

Quick step JSON ("slug" and "intent" required, other fields are kept as-is):
  {
    "slug": "fix-login-typo",
    "intent": "Fix the typo on the login button",
    "description": "",
    "human-validation-needed": false,
    "review-needed": true
  }

Example:
  nos create-quick-step --domain domain-1-user-auth --step -
  {
    "action": "create-quick-step",
    "domain": "domain-1-user-auth",
    "id": 7,
    "path": "D:/repo/.specs/domain-1-user-auth/quick-steps/step-7-fix-login-typo.md",
    "quick-steps": "D:/repo/.specs/domain-1-user-auth/quick-steps/quick-steps.json"
  }`;

const SET_STATUS_HELP = `Usage: nos set-status --domain <domain-<id>-<slug>> [--phase <id>] [--step <id>] --status <status> [--root <dir>]
       nos set-status --run <kind>-<id> merged|discarded [--token <t>] [--root <dir>]

Change a status in <specs>/<domain>/plan.json or of a quick step.

  --domain only           sets the status of the plan
  --phase <id>            sets the status of that phase
  --step <id>             sets the status of that step (ids are unique, --phase is optional;
                          when given, the step must belong to that phase)
                          without --phase, a step not in plan.json is looked up in
                          <specs>/<domain>/quick-steps/quick-steps.json ("quick": true in the result)

The status must be listed in templates/status.xml of this nos:
<plans> for the plan, <phases> for phases, <steps> for steps.
Only the "status" field is changed; the rest of plan.json is kept as-is.
merged and discarded are refused here (exit 1): they are set for a whole run with --run.

--run <kind>-<id> merged|discarded flips every target of a run, one write per file (run finish and
run abandon call it; the domain comes from the run file <specs>/.runs/<kind>-<id>.json):
  plan merged       plan done -> merged, steps done -> merged, phases unchanged
  plan discarded    plan and every step not merged -> discarded
  quick merged      the quick step done -> merged
  quick discarded   the quick step (anything except merged) -> discarded
Targets already at the status stay. A violation (e.g. a step not done for merged) -> exit 1, nothing written.
While the run file exists, --token (or NOS_RUN_TOKEN) of its holder is required (missing 1, another 4).

Options:
  --domain <name>    Domain folder name, e.g. domain-1-user-auth      (required)
  --status <status>  New status, e.g. in-review                       (required)
  --phase <id>       Phase id (the number in phase-<id>-<slug>)
  --step <id>        Step id (the number in step-<id>-<slug>.md)
  --root <dir>       Work root (default: see nos --help)

Example:
  nos set-status --domain domain-1-user-auth --step 3 --status in-review
  {
    "action": "set-status",
    "domain": "domain-1-user-auth",
    "plan": "D:/repo/.specs/domain-1-user-auth/plan.json",
    "target": "step",
    "id": 3,
    "slug": "login-endpoint",
    "previous": "implemented",
    "status": "in-review"
  }
  nos set-status --run quick-7 merged
  {
    "action": "set-status",
    "run": "quick-7",
    "domain": "domain-1-user-auth",
    "status": "merged",
    "file": "D:/repo/.specs/domain-1-user-auth/quick-steps/quick-steps.json",
    "changes": [{ "target": "step", "id": 7, "slug": "fix-login-typo", "previous": "done", "status": "merged" }]
  }`;

const RUN_HELP = `Usage: nos run start --domain <domain> (--plan | --quick <stepId>) [--token <t>] [--take-over] [--root <dir>]
       nos run sync|finish|cleanup|abandon --token <t> [--run <kind>-<id>] [--root <dir>]

A run is one plan (run id plan-<domain id>) or one quick step (quick-<step id>) in branch <kind>-<id> and
worktree <main>/.claude/worktrees/<kind>-<id>. Run file: <specs>/.runs/<kind>-<id>.json. Needs git.
--token falls back to NOS_RUN_TOKEN. Missing token -> 1, another token -> 4. Every token call updates "seen".
sync/finish/cleanup/abandon act on --run, else the run of the worktree you sit in, else the run holding the token.

start    Validates the target (a plan with phases, or a quick step; not merged/discarded). Run file of
         this run: same token -> resume (recreates a missing worktree); another token -> 4; --take-over ->
         new token (also for a merged/abandoned run: then only the token, so cleanup can run; a merge lock
         of the old token is released, while its finish still runs -> 4). Another run in the domain -> 6. Uncommitted specs of the domain ->
         committed "<run>: leftovers". Branch <kind>-<id> (reused, else from main's current branch),
         git worktree add, run file (base, phase develop), "branch" in plan.json / the quick step.
         project-commands.install in a new worktree, output to <specs>/.runs/logs/<run>/install.log
         (a failure is reported in "install", the run stays).
sync     Rebase in progress -> 3. Dirty worktree -> 5 (never autostashed). git rebase <mainBranch> in the
         worktree; conflict -> 3 with the files, the rebase is left open. Clean -> updates base.
finish   The plan / quick step must be done. Under lock merge (another token -> 4): phase integrate,
         main on mainBranch, main busy (MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase
         folders) -> 1, main dirty on the paths the branch touches -> 1, sync (3, 5), phase gate: the full
         gate in the worktree (e2e when configured) -> fail 1 with the gate in details, phase merge:
         git merge --ff-only (refused -> sync + gate once more, then 1), set-status --run merged,
         specs commit "<run>: merged", phase merged. A failure releases the lock, phase develop.
         A crash keeps lock and phase: the same token resumes.
cleanup  Not from inside the worktree. Phase merged or abandoned. git worktree remove (merged: modified
         tracked files -> 5 with the list; untracked files are removed), branch -D (merged: only when the
         branch is in mainBranch), run file deleted. Parts already gone are skipped (rerun after a failure).
abandon  Not for a merged run, not from inside the worktree. set-status --run discarded, specs commit
         "<run>: discarded", phase abandoned, then the cleanup with --force / -D.

Exit: 0 ok, 1 failed (finish: gate fail, main busy/dirty/on another branch, ff refused twice print
{ action, error, exit, details }), 2 usage, 3 rebase conflict, 4 held by another token (run or merge
lock), 5 dirty worktree (sync, finish, cleanup), 6 another run in the domain, 7 no slot for the e2e gate.

Example:
  nos run start --domain domain-2-auth --quick 7
  {
    "action": "run-start",
    "run": { "kind": "quick", "id": 7, "domain": "domain-2-auth", "branch": "quick-7",
             "worktree": "D:/repo/.claude/worktrees/quick-7", "base": "<sha>", "mainBranch": "main",
             "phase": "develop", "started": "<iso>", "seen": "<iso>" },
    "token": "1a2b3c4d",
    "roots": { "home": "D:/repo/.claude/skills/nos", "work": "D:/repo/.claude/worktrees/quick-7",
               "main": "D:/repo", "specs": "D:/repo/.specs" },
    "enter": "D:/repo/.claude/worktrees/quick-7",
    "install": { "code": 0, "log": "D:/repo/.specs/.runs/logs/quick-7/install.log" },
    "leftovers": null
  }`;

const SPECS_HELP = `Usage: nos specs commit (--run <kind>-<id> | --domain <domain> | --config) -m <message> [--root <dir>]
       nos specs find-step <id> [--root <dir>]

specs commit
  Commits the specs repo (<specs>, its own git repo), scoped: git -C <specs> add -- config.json <domain>
  (adds, changes and deletions inside them, nothing else; never add -A), then commit --only those paths,
  only when something is staged. A *.lock of another writer (index, HEAD, refs) is retried 5 times, 200ms
  apart. No hooks, no signing, git never prompts (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never).
  When specs.remote is set in nos.config.json: git push -u origin HEAD after a commit, or when HEAD is
  ahead of its upstream (a commit an earlier failed push left behind) or has none. A failed push or one
  running over 60s is a warning (stderr and "warning" in the result), the commit stays.
    --run <kind>-<id>  the domain of that run file (<specs>/.runs/<kind>-<id>.json)
    --domain <domain>  a domain outside any run (idea, plan or quick step creation)
    --config           config.json only (e.g. setup changed the chat node); "domain" is null
    -m, --message <m>  commit message, e.g. "step-7: develop"                (required)
  Exactly one of --run, --domain, --config.

  nos specs commit --run quick-7 -m "step-7: develop"
  {
    "action": "specs-commit",
    "domain": "domain-2-auth",
    "committed": true,
    "sha": "<sha, null when nothing was staged>",
    "pushed": false,
    "files": ["D:/repo/.specs/domain-2-auth/quick-steps/quick-steps.json", ...]
  }

specs find-step
  Scans <specs>/domain-*/plan.json and quick-steps/quick-steps.json for the step id. Exit 1 when not found.
  An unreadable file is skipped with an entry in "warnings" (only present when there is one).

  nos specs find-step 7
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
  kind "plan": phase is the phase id.`;

const GATE_HELP = `Usage: nos gate [--e2e] [--root <dir>]

Run the quality tools of work's nos.config.json ("quality-tools") in the work root, in order:
test, lint, format-check, typecheck, each "additional" entry, then e2e (only with --e2e).
Every tool runs, also after a failure. Each runs in a shell with NOS_HOME set. e2e runs under a slot
lease (smallest free slot-<n> of worktrees.slots) with NOS_SLOT=<n>; no free slot within
worktrees.slotWait seconds -> exit 7. Full output: <specs>/.runs/logs/<run>/<tool>.log (<run> = the
run of this worktree, else main); the result carries the last 60 lines.
"additional" entries: a command string (name additional-<n>) or { "name", "cmd" }.
A tool running longer than quality-tools.timeout minutes (default 30) is killed with its process tree:
status "fail", "timedOut": true. A slot lease whose process is gone is taken over: "reclaimed":
{ slot, holder } in the result. Ctrl+C / SIGTERM kill the running tool's tree, release the lease, exit 1.

Exit: 0 all configured tools pass, 1 a tool failed (the JSON is still printed), quality tools not
set up (none configured; e2e counts only with --e2e) or interrupted, 7 no slot for e2e.

Options:
  --e2e          Also run e2e
  --root <dir>   Work root (default: see nos --help)

Example:
  nos gate
  {
    "action": "gate",
    "pass": false,
    "tools": [
      { "name": "test", "cmd": "npm test", "status": "fail", "exit": 1, "signal": null, "timedOut": false,
        "tail": "<last 60 lines>", "log": "D:/repo/.specs/.runs/logs/quick-7/test.log" },
      { "name": "lint", "cmd": null, "status": "not-configured", "exit": null, "signal": null,
        "timedOut": false, "tail": "", "log": null }
    ]
  }`;

const EXEC_HELP = `Usage: nos exec <install|dev|deploy-test> [--root <dir>]

Run a project command of work's nos.config.json ("project-commands") in a shell in the work root,
stdio inherited (no JSON result), NOS_HOME set. The exit code is the command's.
dev takes a slot lease (smallest free slot-<n> of worktrees.slots, NOS_SLOT=<n> in its env) and holds it
until the server exits; Ctrl+C / SIGTERM stop the server's whole process tree, then the lease is released.
No free slot within worktrees.slotWait seconds -> exit 7. A slot lease whose process is gone (killed
hard) is taken over, reported on stderr. Locks and runs are never taken over automatically.

Exit: the command's code (130 after SIGINT, 143 after SIGTERM), 1 the command is not configured (null),
2 unknown name, 7 no slot (dev).

Example:
  nos exec install`;

const LOCK_HELP = `Usage: nos lock take <name> --token <t> [--run <kind>-<id>] [--wait <sec>] [--root <dir>]
       nos lock release <name> (--token <t> | --break) [--root <dir>]
       nos lock status [<name>] [--root <dir>]

Locks are folders <specs>/.locks/<name> created by mkdir (atomic, exactly one taker wins) with
holder.json { run, token, pid, command, taken }. Names: lowercase letters, digits, dashes
(merge, ids, slot-<n>). The same token re-takes its own lock (refreshes "taken"). A lock is never
broken automatically: --break is the user's call. --token falls back to NOS_RUN_TOKEN.

  take     held by another token -> exit 4 with { lock, path, holder, ageSec, pidAlive, hint }
           (--wait <sec>: retry that long first)
  release  only with the holder's token (else exit 4), or --break for any holder. Not held: released false
  status   one lock, or every lock without a name ({ "locks": [...] })

Example:
  nos lock take merge --token 1a2b3c4d --run quick-7
  { "action": "lock-take", "lock": "merge", "path": "D:/repo/.specs/.locks/merge",
    "holder": { "run": "quick-7", "pid": 4242, "command": "lock take", "taken": "<iso>" },
    "reentrant": false }
  nos lock release merge --token 1a2b3c4d
  { "action": "lock-release", "lock": "merge", "path": "...", "released": true, "broken": false, "holder": {...} }
  nos lock status merge
  { "action": "lock-status", "lock": "merge", "path": "...", "held": true, "holder": {...}, "ageSec": 12,
    "pidAlive": false }
  pidAlive: the holder's process still exists (false is normal for a lock taken by "nos lock take").`;

const COMMANDS = {
  init: {
    help: INIT_HELP,
    options: { root: { type: 'string' } },
    required: [],
    setsUp: true,
    execute(values, io, roots) {
      const result = initProject(roots);
      return {
        action: 'init',
        main: slash(roots.main),
        specs: slash(roots.specs),
        created: result.created.map(slash),
        existing: result.existing.map(slash),
        gitignoreAdded: result.gitignoreAdded,
        commit: result.commit,
        remote: result.remote,
      };
    },
  },
  roots: {
    help: ROOTS_HELP,
    options: { root: { type: 'string' } },
    required: [],
    setsUp: true,
    execute(values, io, roots) {
      return {
        action: 'roots',
        home: slash(roots.home),
        work: slash(roots.work),
        main: slash(roots.main),
        specs: slash(roots.specs),
        inWorktree: roots.inWorktree,
        configured: roots.configured,
      };
    },
  },
  'create-domain': {
    help: CREATE_DOMAIN_HELP,
    options: {
      idea: { type: 'string' },
      slug: { type: 'string' },
      name: { type: 'string' },
      labels: { type: 'string' },
      root: { type: 'string' },
    },
    required: ['idea', 'slug'],
    execute(values, io, roots) {
      const result = createDomain(roots, {
        idea: readInput(values.idea, io),
        slug: values.slug,
        name: values.name,
        labels: values.labels,
      });
      return {
        action: 'create-domain',
        id: result.id,
        folder: result.folder,
        path: slash(result.path),
        idea: slash(result.ideaPath),
        domain: slash(result.domainFilePath),
      };
    },
  },
  'create-plan': {
    help: CREATE_PLAN_HELP,
    options: {
      domain: { type: 'string' },
      plan: { type: 'string' },
      hollow: { type: 'boolean' },
      root: { type: 'string' },
    },
    required: ['domain'],
    execute(values, io, roots) {
      const hollow = values.hollow ?? false;
      if (hollow && values.plan) throw new UsageError('--hollow takes no --plan', 'create-plan');
      if (!hollow && !values.plan) {
        throw new UsageError('Missing input: --plan. Please provide it and retry', 'create-plan');
      }
      const result = createPlan(roots, {
        domain: values.domain,
        ...(hollow ? { hollow } : { plan: readInput(values.plan, io) }),
      });
      return {
        action: 'create-plan',
        domain: result.domain,
        plan: slash(result.planPath),
        ...(result.hollow && { hollow: true }),
        phases: result.phases.map((phase) => ({
          id: phase.id,
          folder: phase.folder,
          path: slash(phase.path),
          steps: phase.steps.map((step) => ({ id: step.id, file: step.file, path: slash(step.path) })),
        })),
      };
    },
  },
  'update-plan': {
    help: UPDATE_PLAN_HELP,
    options: {
      domain: { type: 'string' },
      plan: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      root: { type: 'string' },
    },
    required: ['domain', 'plan'],
    execute(values, io, roots) {
      const result = updatePlan(roots, {
        domain: values.domain,
        plan: readInput(values.plan, io),
        dryRun: values['dry-run'] ?? false,
        force: values.force ?? false,
      });
      // path, from and to are absolute; specFile stays relative to the specs root
      const paths = (entry) => ({
        ...entry,
        ...(entry.path && { path: slash(entry.path) }),
        ...(entry.from && { from: slash(entry.from), to: slash(entry.to) }),
      });
      return {
        action: 'update-plan',
        domain: result.domain,
        plan: slash(result.planPath),
        dryRun: result.dryRun,
        created: { phases: result.created.phases.map(paths), steps: result.created.steps.map(paths) },
        moved: result.moved.map(paths),
        deleted: { phases: result.deleted.phases.map(paths), steps: result.deleted.steps.map(paths) },
      };
    },
  },
  'create-quick-step': {
    help: CREATE_QUICK_STEP_HELP,
    options: { domain: { type: 'string' }, step: { type: 'string' }, root: { type: 'string' } },
    required: ['domain', 'step'],
    execute(values, io, roots) {
      const result = createQuickStep(roots, { domain: values.domain, step: readInput(values.step, io) });
      return {
        action: 'create-quick-step',
        domain: result.domain,
        id: result.id,
        path: slash(result.path),
        'quick-steps': slash(result.quickStepsPath),
      };
    },
  },
  'set-status': {
    help: SET_STATUS_HELP,
    options: {
      domain: { type: 'string' },
      phase: { type: 'string' },
      step: { type: 'string' },
      status: { type: 'string' },
      run: { type: 'string' },
      token: { type: 'string' },
      root: { type: 'string' },
    },
    required: [],
    positionals: { min: 0, max: 1 },
    execute(values, io, roots, [given]) {
      if (values.run) {
        if (values.domain || values.phase || values.step) {
          throw new UsageError('--run takes no --domain, --phase or --step', 'set-status');
        }
        if (given && values.status) throw new UsageError('Give the status once', 'set-status');
        const status = given ?? values.status;
        if (!status)
          throw new UsageError('Missing input: merged or discarded. Please provide it and retry', 'set-status');
        // a running run belongs to its holder; a cleaned up run (no run file) is anyone's history
        const file = readRun(roots, values.run);
        if (file) requireToken(file, values.token, io.env);
        return setRunStatus(roots, { run: values.run, status });
      }
      if (given !== undefined) throw new UsageError(`Unexpected argument "${given}"`, 'set-status');
      for (const name of ['domain', 'status']) {
        if (!values[name]) throw new UsageError(`Missing input: --${name}. Please provide it and retry`, 'set-status');
      }
      const result = setStatus(roots, values);
      return {
        action: 'set-status',
        domain: result.domain,
        plan: slash(result.planPath),
        target: result.target,
        ...(result.id !== undefined && { id: result.id }),
        ...(result.slug !== undefined && { slug: result.slug }),
        previous: result.previous ?? null,
        status: result.status,
        ...(result.quick && { quick: true }),
      };
    },
  },
  run: {
    help: RUN_HELP,
    options: {
      domain: { type: 'string' },
      plan: { type: 'boolean' },
      quick: { type: 'string' },
      token: { type: 'string' },
      'take-over': { type: 'boolean' },
      run: { type: 'string' },
      root: { type: 'string' },
    },
    required: [],
    positionals: { min: 1, max: 1 },
    action: ([sub]) => `run-${sub}`,
    async execute(values, io, roots, [sub]) {
      if (sub === 'start') {
        if (values.run) throw new UsageError('run start takes no --run: use --domain with --plan or --quick', 'run');
        if (!values.domain) throw new UsageError('Missing input: --domain. Please provide it and retry', 'run');
        return startRun(roots, {
          domain: values.domain,
          plan: values.plan ?? false,
          quick: values.quick,
          token: values.token,
          takeOver: values['take-over'] ?? false,
          env: io.env,
        });
      }
      const commands = { sync: syncRun, finish: finishRun, cleanup: cleanupRun, abandon: abandonRun };
      if (!commands[sub]) {
        throw new UsageError(`Unknown run command "${sub}". Use start, sync, finish, cleanup or abandon`, 'run');
      }
      const startOnly = ['domain', 'plan', 'quick', 'take-over'].find((name) => values[name] !== undefined);
      if (startOnly) throw new UsageError(`run ${sub} takes no --${startOnly}`, 'run');
      return commands[sub](roots, { run: values.run, token: values.token, env: io.env, cwd: io.cwd });
    },
  },
  specs: {
    help: SPECS_HELP,
    options: {
      run: { type: 'string' },
      domain: { type: 'string' },
      config: { type: 'boolean' },
      message: { type: 'string', short: 'm' },
      root: { type: 'string' },
    },
    required: [],
    positionals: { min: 1, max: 2 },
    action: ([sub]) => (sub === 'find-step' ? 'find-step' : 'specs-commit'),
    execute(values, io, roots, [sub, arg]) {
      if (sub === 'commit') {
        if (arg !== undefined) throw new UsageError(`specs commit takes no argument "${arg}"`, 'specs');
        if (!values.message) throw new UsageError('Missing input: -m <message>. Please provide it and retry', 'specs');
        const domain = domainOfTarget(roots, values);
        const result = commitSpecs(roots, { domain, message: values.message });
        if (result.warning) io.stderr.write(`nos: warning: ${result.warning}\n`);
        return result;
      }
      if (sub === 'find-step') {
        if (arg === undefined) throw new UsageError('Missing input: <id>. Please provide it and retry', 'specs');
        return findStep(roots, arg);
      }
      throw new UsageError(`Unknown specs command "${sub}". Use commit or find-step`, 'specs');
    },
  },
  gate: {
    help: GATE_HELP,
    options: { e2e: { type: 'boolean' }, root: { type: 'string' } },
    required: [],
    async execute(values, io, roots) {
      const result = await runGate(roots, { e2e: values.e2e ?? false });
      if (!result.pass) {
        const failed = result.tools.filter((tool) => tool.status === 'fail').map((tool) => tool.name);
        io.stderr.write(`nos: gate failed: ${failed.join(', ')}\n`);
        result[EXIT_CODE] = EXIT.FAILED;
      }
      return result;
    },
  },
  exec: {
    help: EXEC_HELP,
    options: { root: { type: 'string' } },
    required: [],
    positionals: { min: 1, max: 1 },
    raw: true,
    execute(values, io, roots, [name]) {
      return execCommand(roots, name);
    },
  },
  lock: {
    help: LOCK_HELP,
    options: {
      token: { type: 'string' },
      run: { type: 'string' },
      wait: { type: 'string' },
      break: { type: 'boolean' },
      root: { type: 'string' },
    },
    required: [],
    positionals: { min: 1, max: 2 },
    action: ([sub]) => `lock-${sub}`,
    execute(values, io, roots, [sub, name]) {
      if (!['take', 'release', 'status'].includes(sub)) {
        throw new UsageError(`Unknown lock action "${sub}". Use take, release or status`, 'lock');
      }
      if (sub === 'status') {
        return name === undefined
          ? { action: 'lock-status', locks: listLocks(roots) }
          : { action: 'lock-status', ...lockStatus(roots, name) };
      }
      if (name === undefined) throw new UsageError(`Missing input: nos lock ${sub} <name>`, 'lock');
      const token = values.token || io.env.NOS_RUN_TOKEN;
      if (sub === 'release') {
        if (!token && !values.break) throw new UsageError('Missing input: --token (or --break)', 'lock');
        return { action: 'lock-release', ...releaseLock(roots, name, token, { break: values.break ?? false }) };
      }
      if (!token)
        throw new UsageError('Missing input: --token (or NOS_RUN_TOKEN). Please provide it and retry', 'lock');
      const wait = values.wait === undefined ? 0 : Number(values.wait);
      if (!Number.isFinite(wait) || wait < 0) throw new UsageError(`Invalid --wait "${values.wait}"`, 'lock');
      const holder = { run: values.run ?? null, token, command: 'lock take' };
      return { action: 'lock-take', ...takeLock(roots, name, holder, { waitMs: wait * 1000 }) };
    },
  },
};

// JSON.stringify replacer of every printed result: a lock holder never shows its token (lock status, exit 4
// details, reclaimed slot leases). Only run start prints a token: the one it minted for the caller
const printable = (key, value) => (key === 'holder' ? publicHolder(value) : value);

// A result may carry its own exit code (gate: JSON printed, exit 1 on a failed tool)
const EXIT_CODE = Symbol('exit code');

class UsageError extends Error {
  constructor(message, commandName) {
    super(message);
    this.hint = commandName ? `nos help ${commandName}` : 'nos --help';
  }
}

const isHelpFlag = (arg) => arg === '--help' || arg === '-h';

function lookupCommand(name) {
  const command = COMMANDS[name];
  if (!command) throw new UsageError(`Unknown command "${name}"`);
  return command;
}

function readInput(source, io) {
  if (source === '-') return io.readStdin();
  const file = path.resolve(io.cwd, source);
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read input file ${slash(file)}: ${err.message}`);
  }
}

function parseCommand(name, command, args) {
  let parsed;
  const { min = 0, max = 0 } = command.positionals ?? {};
  try {
    parsed = parseArgs({ args, options: command.options, strict: true, allowPositionals: max > 0 });
  } catch (err) {
    throw new UsageError(err.message, name);
  }
  const count = parsed.positionals.length;
  if (count < min) throw new UsageError(`Missing input: nos ${name} needs ${min} argument(s)`, name);
  if (count > max) throw new UsageError(`Unexpected argument "${parsed.positionals[max]}"`, name);
  const missing = command.required.find((name) => !parsed.values[name]);
  if (missing) {
    throw new UsageError(`Missing input: --${missing}. Please provide it and retry`, name);
  }
  return { values: parsed.values, positionals: parsed.positionals };
}

// Resolves with the exit code. io.env and io.home exist for tests (NOS_SPECS_ROOT, a nos home with its own
// templates); children of gate and exec get process.env.
export async function run(argv, io = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    home = NOS_HOME,
    stdout = process.stdout,
    stderr = process.stderr,
    readStdin = () => readFileSync(0, 'utf8'),
  } = io;
  const [name, ...args] = argv;
  let action = name;

  try {
    if (!name || isHelpFlag(name) || (name === 'help' && args.length === 0)) {
      stdout.write(USAGE + '\n');
      return EXIT.OK;
    }
    if (name === 'help') {
      stdout.write((args[0] === 'chat' ? CHAT_HELP : lookupCommand(args[0]).help) + '\n');
      return EXIT.OK;
    }

    const command = lookupCommand(name);
    if (args.some(isHelpFlag)) {
      stdout.write(command.help + '\n');
      return EXIT.OK;
    }
    const { values, positionals } = parseCommand(name, command, args);
    action = command.action?.(positionals) ?? name;
    const roots = resolveRoots({ root: values.root, cwd, env, home });
    homeGuard(roots, stderr);
    if (!command.setsUp && !roots.configured) throw notSetUp(roots, cwd);
    const result = await command.execute(values, { cwd, env, readStdin, stderr }, roots, positionals);
    // raw: the command printed its own output (exec: the child's stdio) and resolved with its exit code
    if (command.raw) return result;
    stdout.write(JSON.stringify(result, printable, 2) + '\n');
    return result[EXIT_CODE] ?? EXIT.OK;
  } catch (err) {
    return reportError(action, err, { stdout, stderr });
  }
}

// Every command except init and roots needs the layout of nos init (nos.config.json, <specs>/config.json).
function notSetUp(roots, cwd) {
  const where =
    roots.via === 'root' || roots.via === 'env'
      ? `no nos.config.json in ${slash(roots.work)}`
      : `no nos.config.json found from ${slash(path.resolve(cwd))} up`;
  return new NosError(EXIT.FAILED, `nos is not set up here: ${where}. Run nos init from the project root`);
}

// Error -> exit code. Every error gets one stderr line. NosError 3-7 are states the orchestrator reacts to:
// { action, error, exit, details } (holder, file lists) also goes to stdout as JSON, as for a NosError marked
// report (a 1 with details).
export function reportError(action, err, { stdout, stderr }) {
  stderr.write(`nos: ${err.message}\n`);
  if (err instanceof UsageError) {
    stderr.write(`Run "${err.hint}" for usage.\n`);
    return EXIT.USAGE;
  }
  if (!(err instanceof NosError)) return EXIT.FAILED;
  // report: a 1 whose details the orchestrator needs (run finish: gate result, main busy / dirty lists)
  if ((err.code >= EXIT.CONFLICT && err.code <= EXIT.SLOT_TIMEOUT) || err.report) {
    const report = { action, error: err.message, exit: err.code, details: err.details };
    stdout.write(JSON.stringify(report, printable, 2) + '\n');
    return err.code;
  }
  return err.code === EXIT.USAGE ? EXIT.USAGE : EXIT.FAILED;
}
