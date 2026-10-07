# nos: Orchestrated development with Claude Code

nos turns Claude Code into a small development team. You describe an idea. nos turns it into a plan, implements that plan step by step with TDD, reviews every step twice and every phase once more, and all of this happens in a loop that only stops when you want it to.

The main session is the **orchestrator**. It never writes code itself. It starts a fresh subagent for every job (idea, plan, develop, review, architect), keeps track of progress in `<specs>/` (the specs' own git repo, by default the folder `<project>.specs` next to the project checkout), and reports to you in simple language. Every plan and quick step runs in its own git branch and worktree, so several can run in parallel.

> **This is a blueprint, not a finished product for every type of project.** It shows one way to build a harness. Use it as is, take pieces from it, or rebuild it for your own team and project. Part 3 explains the ideas behind it, and Part 4 shows how to change it.

> **My suggestion. Fork this and clone into your `skills` folder. If your skills are not git ignored then clone and copy contents into your skill folder.** 

**Contents**
- Part 0: The idea -> Read First
- Part 1: How to use it
- Part 2: What everything does
- Part 3: Understanding harnesses (for newcomers)
- Part 4: Changing the blueprint (by hand and with AI)
- Part 5: Spec UI (viewer)
- Part 6: nos CLI
- Porting to another project

---

![screenshot-spec-ui](https://i.imgur.com/DaXJGQT.png)

---

## Part 0: The idea

### The flow
- The idea behind this harness is that the user only needs to actively initiate one skill.
- You start with an idea.
- The agents then create a plan by breaking the idea down into manageable pieces, such as phases and steps.
```
idea    ──►    plan    ──►    phases    ──►    steps
idea agent      plan agent                      (implementation artifacts)

Phases and steps are inspired by implementation plans from the Claude plan mode when it is prompted to split the work
```
- Then, the user can choose to develop fully autonomously, or manually control each step if needed.
- Even though manual control is an option, the goal is to improve the harness to the point where you can trust it to autonomously build features overnight.
- For every step in every phase, the following cycle is executed:
```
open ──► in-specification ──► specified ──► in-progress ──► implemented ──► in-review ──► reviewed ──► done
         specify + spec-review              develop                         review agents                                                                    
```
- The orchestrator is the backbone of the loop capability. It enables full implementation runs with dozens of contexts to be run overnight. 
- The Specs UI is an addition to the Orchestrator Chat, allowing users to browse and track their current progress.
- This process is designed for larger implementations. For small changes use a quick step (QUICK): one step without idea and plan, through the same specify → develop → review cycle.

### Customizable
- This readme explains how this harness works and what its components are.
- It demonstrates that there can't be one harness to rule them all.
- Different types of tests are also technically part of a harness, but are completely based on your project code.
- Pick it apart. Copy only what you need. Use it to inspire you to build your own completely from scratch.
- This harness blueprint was built for a front-end project. Project specific commands (test, lint, format, typecheck, e2e, dev server, deploy) are not hardcoded: they live in `nos.config.json` at the project root and the SETUP option gathers them for your project.
- You can simply ask an AI to make further changes. This harness has matured enough to allow an AI to make changes without easily breaking it. I hope so, at least!
- You don't use Node.js? Well, let the AI port the CLI to Python.

## Part 1: How to use it

### Prerequisites

- `nos` CLI (Node.js 20+) | Creates `<specs>/` folders and ids, changes statuses, and runs every git step of a run (worktree, rebase, gate, merge).
- Install: `cd .claude/skills/nos/cli && npm install` (no dependencies). Nothing is linked: orchestrator, abilities and hooks call `node <home>/cli/bin/nos.js` literally, `<home>` = the nos folder (see Part 6). In this README `nos` stands for that call.
- git. Without a git repo nos works in the current folder, without branches and worktrees.

- A test suite, linter and formatter in the project are recommended. Develop and both reviewers run the configured quality check (`nos gate`). Missing ones are skipped; the architect (TESTS) can add them later.
- Run SETUP once (the orchestrator offers it when `nos.config.json` is missing or has no quality tools). Works for any stack, not only npm.

### Setup (SETUP)

Idempotent: on a fresh project it sets everything up, on a set up one it only checks and fills gaps. Run it on main.

1. Runs `nos init`: creates `nos.config.json` (`specs.dir` `null` = the default `../<project>.specs`), `<specs>/` next to the checkout as its own git repo (first commit `nos: init`, `config.json` with the back-pointer `project`) and the `.gitignore` entry `.claude/worktrees/`. Existing files and id counters stay untouched. Adds the specs root to `permissions.additionalDirectories` in `.claude/settings.local.json`.
2. Detects the tooling: package manager, `package.json` scripts, Makefile, pyproject, go.mod, …
3. Proposes the commands per key, the docs folder for the viewer and the slots (3 when e2e is configured, else 1), and asks you to confirm or adjust.
4. Writes `quality-tools`, `project-commands`, `spec-ui` and `worktrees` into `nos.config.json`.
5. Runs the quality tools once with `nos gate` and reports pass or fail.
6. Slot check: starts the dev server once per slot (`nos exec dev`) and checks that each answers on its own port.
7. Chat: permissions and (relay) the Stop hook go into `.claude/settings.local.json` with absolute paths. `settings.json` is never written.
8. Offers a git remote as backup for `<specs>` (`specs.remote`).
9. Commits `nos.config.json` and `.gitignore` on main with `setup: …` (setup is a listed exception to "main moves only by merges").

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
  "install": "npm ci",
  "dev": "npm run dev",
  "deploy-test": "npm run deploy:test"
}
```

`null` → not available. Key meanings, slots and the quality check rules: `templates/quality-tools.md`. Project commands only ever run through `nos gate` and `nos exec`.

### Start

In Claude Code, type:

```
/nos
```

The orchestrator asks:

```
What do you want to do?
A - Document an idea [IDEA]
B - Create a plan from an idea [PLAN]
C - Run or continue a plan or quick step [RUN]
D - Quick step: one small change straight to specify, develop, review [QUICK]
E - Improve project quality and docs: architecture docs, guardrails, tests [ARCHITECT]
F - Set up or update nos for this project: nos.config.json, the specs repo, quality tools, slots [SETUP]
G - Continue in the browser or on the phone: open the local chat (its own Claude Code sessions, one per tab) [CHAT]
```

Answer with the letter or the key (`A` or `IDEA`). All questions work this way.

### The typical path

1. **IDEA**: describe what you want. The idea agent asks you questions until the idea is clear. It saves the result as `<specs>/domain-<id>-<slug>/idea.md`.
   Then: `Create a plan now?` → `YES`.
2. **PLAN**: the planner splits the idea into phases and steps and saves `plan.json`. Every step gets an empty spec file.
   Then: `Run it now?` → `YES`. Or `CHANGE` to describe changes to the split. The planner revises the plan and asks again.
   > The plan agent will judge on its own where human intervention is required and where a review is not needed (pure documentation). It configures this in the plan.json. By changing the boolean values you can overrule that.
3. **RUN**: choose a mode:
   ```
   How should the plan run?
   A - Autonomous. Stops only for problems or human validation [AUTO]
   B - Stops after each specification, implementation and review for your go [MANUAL]
   ```
   nos creates the branch and worktree of the run (`plan-<domain id>`), moves the session into it and works through every step and phase there.
4. **Integrate**: when the plan is done, nos asks whether to integrate it into main now. `YES` rebases, runs the full gate and merges fast-forward, then removes the worktree and the branch.

Each option can also be started on its own. PLAN lists ideas without a plan. RUN lists all plans and quick steps that are not done, merged or discarded, and marks the running ones.

### Quick step (QUICK)

Outside the typical path. For a small change that needs no idea and no plan. A quick step is one step ticket in a domain's `quick-steps/` folder that runs through the normal step cycle: specify + spec-review → develop → reviews → done.

1. QUICK offers to continue an unfinished quick step, or to create a new one.
2. Tell nos what you want. A rough intent is enough; specify works out the details with you.
3. Choose the mode:
   - **AUTO**: nos picks the best fitting domain (or creates one) and runs the quick step in AUTO mode.
   - **MANUAL**: nos shows the matching domains with a suggestion and `NEW` (with a suggested name you can change). You choose. Then you choose AUTO or MANUAL for the run.
4. A new domain gets an `idea.md` with your intent and a note that the quick step flow generated it.
5. The quick step runs like a plan step, in its own branch and worktree (`quick-<step id>`): same statuses, parks, `human-validation-needed` and `review-needed`. There is no phase and no phase review. PAUSE keeps the status; continue later via QUICK or RUN.
6. When the step is done, nos integrates it into main automatically.

### Project quality and docs (ARCHITECT)

Outside the typical path. Use it when you add nos to a project, and whenever runs keep failing in the same way. The architect shows a menu first and does nothing before you pick:

```
What do you want to do?
A - Create the architecture docs [CREATE-DOCS]          (no or empty docs/architecture.md)
B - Update the architecture docs [UPDATE-DOCS]          (docs/architecture.md has content)
C - Add guardrails from observed failures [ADD-GUARDRAILS]
D - Review the existing guardrails [REVIEW-GUARDRAILS]  (docs/guardrails.xml exists)
E - Add missing test types [TESTS]
F - Measure the effect of past harness changes [MEASURE]
G - End [DONE]                                          (after a task ran)
```

After each task the menu comes back. Every change is proposed first and committed on its own with prefix `architect: ` (on main when started from the menu, a listed exception). Bugs it finds go into the Tech debt section of the architecture doc. At the end nos offers to start an idea for them.

### Lessons become guardrails

nos never saves a Claude Code memory. When you correct it, decide something for the project, or the same failure keeps coming back, the orchestrator writes it down as a **guardrail proposal**: the section (`coding`, `review`, `specify`, `plan`, `architect` or `orchestrator`), the wording, the reason (your words and the date, or the failure with its step, park, Dev Log entry or review finding) and why it does not block valid work. Guesses, one-offs and things already in a guardrail or the docs get no proposal. A lesson about nos itself is just reported to you.

It never interrupts a step for this. It asks at the next park or final report, also in AUTO:

```
Lessons from this work, proposed as guardrails. Which should the architect add?
A - coding: … (reason, why it does not block valid work) [P1]
B - plan: … [P2]
C - Accept all [ALL]
D - Drop all. Nothing is written, no memory either [NO]
```

Accepted ones go to the architect (task ADD-GUARDRAILS). It checks each (section, wording, reason, duplicates, contradictions, valid work blocked), adds the good ones to `docs/guardrails.xml` and commits `architect: guardrails from run lessons`. It asks you only about problem ones. Inside a run the commit lands on the run branch and reaches main with the merge; outside a run it goes on main (a listed exception). Subagents read their section, so the lesson reaches the agent that needs it, versioned with the code.

### Modes

| | AUTO | MANUAL |
| --- | --- | --- |
| After a step is specified | continues | stops, shows the spec in simple words, waits for your go |
| After a step or phase is implemented | continues | stops, waits for your go |
| After a step or phase is reviewed | continues | stops, waits for your go |
| Develop or review is blocked | stops | stops |
| `human-validation-needed: true` | stops at reviewed | stops at reviewed |
| `review-needed: false` | skips the review, implemented → done | skips the review, implemented → done |
| both of the above | stops at implemented | stops at implemented |

You can switch modes at every stop.

### When nos stops (a "park")

nos tells you what it stopped at, its status and why. For human validation it explains in simple steps what to check, so you don't need to know the code. Then:

```
How do you want to continue?
A - Continue with the next step of the cycle [GO]
B - Switch to the other mode and continue [MANUAL]
C - Give feedback on what is wrong [REJECT]      (only when something is specified or reviewed, or implemented without review)
D - Pause the plan [PAUSE]
E - Drop the plan or quick step [ABANDON]
```

Pending guardrail proposals are asked first (see "Lessons become guardrails").

- **GO**: continue.
- **AUTO/MANUAL**: switch the mode and continue.
- **REJECT (specified step)**: the step goes back to `in-specification`. Specify reworks the description and ACs with your feedback, then spec-review checks them.
- **REJECT (reviewed step, or implemented step without review)**: the step goes back to `in-specification` with your feedback. Specify updates the ACs if needed and spec-review checks them, then develop runs again, and both reviews too when `review-needed` is `true`.
- **REJECT (phase)**: the planner adds a new **fix phase** directly after it, made from your feedback. The fix phase runs the full cycle and always asks you to validate it.
- **PAUSE**: the plan becomes `on-hold`. Start it again later with RUN. A quick step keeps its status; continue it with QUICK or RUN. The worktree and branch stay.
- **ABANDON** (after a confirmation): `nos run abandon` sets the plan or quick step `discarded`, deletes the worktree and the branch. The specs stay as history.

### Interruptions

Usage limit, closed terminal, shutdown: nothing is lost. Start `/nos` → `RUN` and pick the plan. nos reads the statuses in `plan.json` and continues exactly where it stopped. It never resets a status. Interrupted work is simply redone. For example, a step stuck at `in-review` gets both reviews run again.

A resumed session (`claude --resume`, a restarted chat) is back in the run's worktree and still knows the run token. A new session that picks a running run is refused (another holder); nos asks whether to take it over (`TAKEOVER`). A rebase that stopped with conflicts is resolved by the integrate ability first.

### Runs: branches and worktrees

- A **run** is one plan (`plan-<domain id>`) or one quick step (`quick-<step id>`) in its own branch and git worktree under `.claude/worktrees/<run>`. The session works inside it; subagents, tests and code commits land there. One run per domain, one run per session; run several in parallel from several terminals or chat tabs.
- The specs are not in the worktrees. They live once in `<specs>/` (its own git repo next to the project checkout, default `../<project>.specs`), shared by every run and live in the Spec UI. Only the orchestrator commits them (`nos specs commit`, after every ability; specify and spec-review count as one).
- Why outside the checkout: Claude Code's worktree isolation (after `EnterWorktree`) refuses edits to the main checkout from the worktree session and its subagents, also through junctions, and blocks git redirected into it (`git -C <main>`, `cd <main> && git`). So the specs live outside, nos is always called as the literal `node <home>/cli/bin/nos.js …` (never via a variable or alias: computed command names are refused too), and git against main runs only inside nos commands.
- Live-run rules that follow from it (workflow.md `<rules>`, repeated in every ability that needs them): never `cd` into `<specs>` or anywhere outside the work folder (the Bash cwd persists; `EnterWorktree` from outside the repo needs an approval auto mode and the chat cannot give, so a denied enter retries once from `<main>`, then parks); files in `<specs>` are written only with Write/Edit (auto mode refuses shell writes outside the cwd; `<specs>` is an added directory); shell commands that run git or change files stay literal (no `$(…)`, backticks, variables or `cd x && git`), one plain git command per call.
- nos never pushes code; you push. Only the specs repo is pushed, by `nos specs commit`, when you set `specs.remote` as backup.
- Lifecycle: `nos run start` → enter the worktree → steps as usual, with `nos run sync` (rebase onto main) before every develop → `nos run finish` (merge lock, main checks, sync, full gate incl. e2e, `merge --ff-only`, statuses `merged`) → leave the worktree → `nos run cleanup`. Or `nos run abandon` (status `discarded`).
- Merges serialize, developing does not: first done, first merged. The others pick up main at their next sync.
- A rebase conflict starts the **integrate** ability: it reads both specs (its own and the ones of the commits already on main), resolves by intent, continues the rebase and runs the gate. When both specs want contradicting things it stops and shows you both.
- Dirty worktrees are never stashed. Leftover work is committed with the step prefix, or nos stops and shows the files.
- Slots: e2e runs and dev servers take a slot (port set, `NOS_SLOT`) only while they run. With `slots: 1` parallel e2e runs queue instead of colliding.

| nos exit code | Meaning | nos does |
| --- | --- | --- |
| 3 | rebase conflict | integrate, then the same command again. Contradicting specs: you decide which intent wins (`DECIDE`), pause or abandon |
| 4 | held by another session (run token or merge lock) | run: shows holder and age, you decide: take over or stop. Merge lock: waits and retries, then stops |
| 5 | dirty worktree | commits the step's own leftover files (never `git add -A`), or stops and asks you to ignore or delete the rest. At cleanup (modified files in a merged worktree): stops, you revert or delete them |
| 6 | another run in the domain | shows it, you decide |
| 7 | no free slot in time | stops |
| 1 | failed (gate, main busy, dirty or on another branch, ff merge refused twice) | stops and reports; GO repeats the integration once you fixed main. Gate fail at integration: `FIX` runs develop for the last step with the failures |

### Controlling human validation

In `plan.json`, every phase and step has `"human-validation-needed"`. When it is `true`, nos always stops at `reviewed` for you, in any mode. You can edit this in the plan before or during a run. Fix phases always have it set.

### Controlling reviews

In `plan.json`, every phase and step has `"review-needed"` (missing counts as `true`). When it is `false`, nos skips both reviews and moves it from `implemented` straight to `done`. If human validation is needed too, nos stops at `implemented` instead and derives the verification steps from the ACs. The planner sets it to `false` for pure documentation steps, and for phases that are only documentation and human verification (then the phase and all its steps), and always for phases with exactly one step (only the phase, the step keeps its own flag). You can edit this in the plan before or during a run.

### Where to look

```
nos.config.json                          tracked: quality tools, project commands, spec-ui docs folder, slots, specs dir/remote (setup)
.claude/worktrees/plan-1/                worktree of a running run (branch plan-1)
../<project>.specs/                      the specs root: own git repo next to the project checkout
├── config.json                          back-pointer "project", id counters (managed by nos), chat
├── .gitignore .gitattributes            local state ignored; LF working copies (nos init)
├── .runs/ .locks/ .chat/                running runs, locks, chat state (local, not committed)
└── domain-1-user-auth/
    ├── idea.md                          the idea
    ├── domain.json                      name, labels, cross-cutting
    ├── plan.json                        phases, steps, statuses
    ├── phases/
    │   └── phase-1-data-model/
    │       ├── step-1-user-table.md     spec: description, ACs, spec log, test strategy, tasks, dev log, review
    │       └── review.md                phase review
    └── quick-steps/
        ├── quick-steps.json             quick steps and their statuses
        └── step-7-fix-typo.md           quick step spec, same structure as a step spec
```

```
docs/
├── architecture-template.md             structure of the architecture doc (architect)
├── architecture.md                      architecture, rules, tech debt (architect)
└── guardrails.xml                       extra rules per ability and for the orchestrator (architect)
```

Code commits start with `step-<id>: ` or `phase-<id>: ` (with the colon), so `git log --grep "^step-3:"` shows everything done for step 3 and never step 30. The architect's commits start with `architect: `, setup's with `setup: `. Spec changes are committed in `<specs>` (`git -C <specs> log`), one commit per ability.

The easier way to see all of this is the **Spec UI**. Open `ui/index.html` in Chrome or Edge, or run `npm run dev` inside `ui/` for live updates while a run is going (see Part 5).

---

## Part 2: What everything does

### File overview

```
.claude/skills/nos/
├── SKILL.md                        orchestrator: role, rules, list of abilities
├── workflow.md                     orchestrator: what to do when
├── README.md                       this file
├── abilities/                      abilities, each run as its own subagent
│   ├── setup.md
│   ├── idea.md
│   ├── quick-step.md
│   ├── plan.md
│   ├── specify.md
│   ├── spec-review.md
│   ├── develop.md
│   ├── review-pessimistic/SKILL.md  also runs standalone
│   ├── review-fixing/SKILL.md       also runs standalone
│   ├── integrate.md                 merge agent: resolves a stopped rebase
│   ├── chat.md
│   └── architect.md
├── templates/
│   ├── config.json                 initial id counters of <specs>/config.json
│   ├── nos.config.json             initial project config: specs, worktrees, quality tools, project commands, docs folder
│   ├── domain.json                 domain structure
│   ├── plan.json                   plan structure
│   ├── status.xml                  valid statuses
│   ├── step-spec-template.md       structure of a step spec file
│   ├── review-template.md          structure and rules of a review (step Review section, phase review.md)
│   ├── architecture-sections.md    section catalog for a project's architecture template
│   ├── quality-tools.md            config keys and the quality check
│   ├── test-types.md               test groups and architecture rule ideas
│   └── guardrails.xml              structure of docs/guardrails.xml
├── cli/                            `nos` CLI: ids, folders, statuses, runs, gate (Part 6)
└── ui/                             read-only browser viewer for the specs root (Part 5)
```

All skill files are written in minimal pseudo-XML: `<coreRules>`, `<input>`, and a numbered `<workflow>`.

### SKILL.md: the orchestrator

Defines the main session's role. It only delegates, orchestrates and reports. It never implements or verifies. It must read `workflow.md` first and must not read an ability file until the workflow calls for it. It lists the abilities: setup, idea, plan, quick-step, specify, spec-review, develop, review-pessimistic, review-fixing, integrate, chat, architect. Every ability gets `home`, `work` (the checkout: main or the run's worktree) and `specs` from the orchestrator, which reads them once per run from `nos roots`.

#### Step and phase cycle

Each cycle step shows exactly which status changes (`<status from to>`), what runs (`<do>`), and where it may stop (`<park mode when>`).

Step:
```
open ──► in-specification ──► specified ──► in-progress ──► implemented ──► in-review ──► reviewed ──► done
         specify              park: MANUAL  develop         park: MANUAL    pessimistic   park: MANUAL
                                            park: blocked                   fixing        park: human validation
                                                                            park: blocked
```

Phase (no specification stage):
```
open ──► in-progress ──► implemented ──► in-review ──► reviewed ──► done
         all steps       park: MANUAL    pessimistic   park: MANUAL
                                         fixing        park: human validation
                                         park: blocked
```

- `review-needed: false` (step or phase): `implemented ──► done`. No review, and the human-validation park moves to `implemented`.
- Step: `in-specification` runs specify, then spec-review. `in-progress` runs develop.
- Phase: `in-progress` runs the step cycle for every step that is not done. The phase review starts only after all steps are done.
- There is no review of the whole plan. The phase reviews already cover how steps fit together.
- Plan statuses: `open`/`on-hold` → `in-progress` → `done` → `merged` (by `nos run finish`). `discarded` by `nos run abandon`.
- Run: `nos run sync` before every develop. Plan done → you decide on integrating; quick step done → integrated automatically.

#### Resume

Every cycle starts with `<entry>resume</entry>`, and every cycle step has `resume-at="<status>"`. On start nos reads the status:

| Status | Continues with |
| --- | --- |
| `open` | step1 (normal start) |
| `in-specification` | specify and spec-review again (step only) |
| `specified` | the MANUAL park, then develop (step only) |
| `in-progress` | develop again (step), or the step loop (phase) |
| `implemented` | the MANUAL park, then review (or `done` when `review-needed: false`) |
| `in-review` | both reviews again |
| `reviewed` | the parks, then `done` |
| `done` | skipped |

The status change of the resumed step is skipped because it already happened. The ability is told that it resumes interrupted work.

### abilities/setup.md: setup 🔧

Not part of the run cycle. Started from the menu (SETUP), or offered at start when `nos.config.json` is missing or has no `quality-tools`. Runs `nos init`, detects the project's tooling, lets you confirm the commands and slots, writes `nos.config.json`, runs the gate once, verifies the slots, writes `additionalDirectories` (the specs root) and the chat settings to `.claude/settings.local.json` and offers a remote for `<specs>`. Never touches the id counters or `settings.json`.

### abilities/idea.md: idea 💡

Asks you focused questions until the idea is ready for planning. It generates a slug, picks a domain name and labels, and saves the idea with `nos create-domain`, which creates `<specs>/domain-<id>-<slug>/idea.md` and `domain.json`. It reports the domain folder. Its questions reach you through the orchestrator. Optional input: a starting context, e.g. tech debt entries handed over by the architect.

### abilities/quick-step.md: quick step ⚡

Not part of the plan flow. Started from the menu (QUICK). Gets your intent (a rough one is fine, it only has to be clear enough to pick a domain) and asks AUTO or MANUAL. AUTO: picks the best fitting domain itself, or creates one. MANUAL: lists the matching domains with a suggestion plus `NEW`, and you choose; then asks the mode of the run. A new domain is created with `nos create-domain` and an `idea.md` holding the intent and a "generated by the quick step flow" note. Saves the step with `nos create-quick-step`. Returns domain, step id and run mode; the orchestrator then runs the step cycle for it. specify, spec-review, develop and both reviewers read `quick-steps/quick-steps.json` instead of `plan.json` for a quick step.

### abilities/plan.md: implementation architect and planner 🏗️

Reads `docs/architecture.md` if it exists and respects its structure and rules. Reads the `plan` guardrails in `docs/guardrails.xml` in every action: they add constraints to splitting and flags, but never override your sizing or the `review-needed` rules unless they say so. Three actions:
- **create**: needs the domain and its `idea.md`. Splits the idea into phases and steps that respect the existing architecture, following `templates/plan.json`. All statuses are `open`, and every phase and step gets a slug. Pure documentation steps, and phases that are only documentation and human verification (with all their steps), get `review-needed: false`. A phase with exactly one step always gets `review-needed: false` on the phase only. Saves with `nos create-plan`, which creates phase folders and empty step spec files and fills `spec-file`.
- **extend**: used after a phase is rejected. Inserts a fix phase directly after the rejected one, with the issues split into steps and `human-validation-needed: true`, and `review-needed` set by the same rules as create. Saves with `nos update-plan`.
- **revise**: used when you pick `CHANGE` after the split is shown. Applies your changes (move, merge, split, add or remove phases and steps), reapplies the `review-needed` rules and saves with `nos update-plan`.

### abilities/develop.md: developer 🪛

Input: domain, phase id, step id, optional feedback and resume flag. For one step it:
1. Reads `plan.json` and the step spec file. A spec without ACs → `blocked` (step not specified).
2. Writes a detailed implementation plan into the Task List, with a test task before each implementation task, plus tasks for the integration/e2e tests and existing-test changes from the Test Strategy. It changes an existing test only when the Test Strategy lists it. On feedback it changes or extends the tasks. On resume it checks every task and AC against the code.
3. Works through the tasks with TDD: test → see it fail → implement → green. It ticks tasks and met ACs with `(x)`.
4. Runs `nos gate` (with `--e2e` when the Test Strategy names e2e). It fixes what it can and marks what it can't with `(!)`.
5. Fills the Dev Log. It never changes the Spec Log.
6. Commits code only with `step-<id>: <what>` in the worktree, never pushes (you push). The spec file lives in `<specs>` and is committed by the orchestrator.
7. Reports `pass` or `blocked`.

It never changes the Description, ACs, Spec Log or Test Strategy. Changing a test to make it pass is strictly forbidden.

It reads the coding guardrails in `docs/guardrails.xml` and the architecture in `docs/architecture.md` if they exist. It never changes the architecture docs. When a change needs them updated or breaks one of their rules, it notes this in the Dev Log marked `(architecture)` for the architect.

### abilities/specify.md: requirements engineer 📑

Runs before develop, as its own subagent. Input: domain, phase id, step id, mode, optional feedback. It reads `idea.md`, `plan.json` and the spec, fills an empty spec from `step-spec-template.md`, and writes the Description and the Acceptance Criteria (`( )`). ACs must be understandable and verifiable by a non-technical person, with no filenames or line numbers. On feedback it changes ACs only where the feedback isn't already covered.

When something is unclear:
- **MANUAL**: it asks you focused questions, which are relayed through the orchestrator.
- **AUTO**: it makes a reasonable assumption.

It writes every assumption and every answer you gave into the Spec Log marked `(specify)`, so spec-review, develop and the reviewers see it. It never writes tasks or code, and it doesn't commit; the orchestrator commits the specs after every ability.

It fills the Test Strategy: whether new integration and e2e tests add real value (judged with `templates/test-types.md` against the project's tests and tooling), and which existing tests (also unit) must be changed or extended. Strong, meaningful tests only, never a test for the sake of having one. Extending an existing test beats a new one. Missing tooling → no, noted in the Spec Log for the architect.

When it is done, the orchestrator keeps its session alive for spec-review. From then on it MUST NOT edit the spec file. It only answers spec-review's questions about its reasoning, and asks back only when it doesn't understand a question.

### abilities/spec-review.md: spec reviewer 📑🕵🏼

Runs right after specify, as its own subagent, with the same input. It checks the spec with five checks:
- **requirement**: every part of the step intent, description and relevant idea parts (and your feedback) is covered by an AC, nothing out of scope.
- **holes**: missing states, error and edge cases, undefined behavior.
- **coherence**: ACs contradicting each other, the Description, the idea or other steps' specs.
- **tests**: the Test Strategy is justified: no valuable test missing, no test without value, no affected existing test left out.
- **decisions**: each Spec Log entry is grounded in code and idea and correctly reflected in the ACs.

When it needs specify's reasoning, it returns all questions at once marked `for-specify`. The orchestrator forwards them to the still-open specify session and the answers back. One round only. On resume without that session it decides alone.

- **MANUAL**: it shows you each flaw with a suggested change and applies what you accept.
- **AUTO**: it fixes the spec directly and moves on.

It writes every change with its reason into the Spec Log marked `(spec-review)`. Then the specification is finished.

### abilities/review-pessimistic/SKILL.md: first reviewer 🕵🏼😠

It assumes the implementation is wrong. It never changes code or tests. It finds the changes through the commit prefix (`git log <mainBranch>..HEAD`, subjects starting exactly with `step-<id>:`), runs `nos gate`, and reviews with a target-specific focus:
- **step**: ACs met, tests cover every AC, edge cases, bugs, weakened tests, quality and conventions, broken architecture rules, and whether the Task List and Dev Log are truthful.
- **phase**: steps fit together, gaps between steps, duplication and inconsistency, phase intent met.

It runs four passes on top of that focus:
- **criteria**: each AC is split into checkable conditions and marked `met`, `partly` or `not met`, with what is missing.
- **code**: names, error paths, security, cleanup, unsafe casts, duplication and null guards.
- **edges**: empty input, off-by-one, races, big input, validation at boundaries and actionable error messages.
- **tests**: whether a test checks each AC's outcome and edge cases. If an AC names an error case and no test covers it, that is `must-fix`. So is a Test Strategy test that is missing, or a listed existing test that wasn't changed or extended.

It writes the review file (step: `## Review` in the spec, phase: `review.md` in the phase folder) from `templates/review-template.md`, replacing the old content. Each finding is `( )` with an id (`F1`), a weight (`must-fix`|`should-fix`), a category (bug|gap|test|quality), `file:line`, evidence, a suggested fix and a fix kind (`mechanical`|`judgment`). The Result is `passed` only when every AC is met and there is no `must-fix`, and it reports only that Result.

### abilities/review-fixing/SKILL.md: second reviewer and fixer 🕵🏼🛠️

Runs in a new context and does its **own review first, without reading the review file**, including tests, lint and format. Then it reads the pessimistic review, compares, removes invalid findings and adds missing ones. It fixes the findings with TDD and marks each one `(x)` fixed or `(!)` (not fixable, out of scope, or needs your decision). It reruns `nos gate`, writes its fixes into the Dev Log marked `(reviewer)`, and commits the code with `step-<id>: `/`phase-<id>: `. Then it fills `### Fixes` in the review with that prefix (never a sha, shas change on rebase) and updates Criteria and Result when they changed. No second commit: the review lives in `<specs>`. It reports `pass` or `blocked`. When human validation is needed, it adds simple verification steps that the orchestrator shows you.

Both reviewers read the review guardrails in `docs/guardrails.xml` and the architecture in `docs/architecture.md` if they exist. Like develop, review-fixing never changes the architecture docs and notes needed changes in the Dev Log marked `(architecture)`.

Both work standalone too: tell Claude to follow `abilities/review-pessimistic/SKILL.md` or `abilities/review-fixing/SKILL.md`, optionally with a scope (files, commit range, branch). No scope → uncommitted changes plus branch commits not in main. Without a step ticket they print the outcome instead of writing a review file or Dev Log. Standalone review-fixing accepts findings (e.g. the printed pessimistic review), fixes them but doesn't commit.

### abilities/integrate.md: merge agent 🔀

Runs only when `nos run sync` or `nos run finish` stops with a rebase conflict (exit 3), or a resumed run has a rebase in progress. It is the only ability that continues a rebase. It reads the commits already on main since the run's base (`step-<id>:` prefixes → `nos specs find-step`) and its own step spec, resolves each conflict by the intent of both, continues the rebase commit by commit and runs `nos gate`. It notes each resolution in the Dev Log marked `(merge)`. When the two specs contradict each other it stops and cites both. The orchestrator then repeats the command that stopped.

### abilities/architect.md: quality and docs architect 🏗️🕵🏼

Not part of the run cycle. It is started from the menu (ARCHITECT) and works with you. Its core rules come from harness engineering: harden only in response to observed failures, change one thing at a time and measure it, don't trust a rule just because it exists, and test both "should happen" and "should NOT happen". It never changes production code, and it is the only role that changes the architecture docs.

It shows its task menu first and analyzes nothing before you pick. Every change is proposed, applied only after you agree, and committed on its own with prefix `architect: ` (code, docs, `nos.config.json`; never specs). New test tools go into `quality-tools` of `nos.config.json`.

| Task | Does |
| --- | --- |
| CREATE-DOCS | Derives a project template (`docs/architecture-template.md`) from `templates/architecture-sections.md`: from the code's project type and stack, or for an empty project from `idea.md` or your intent. You approve the template, then it writes `docs/architecture.md` exactly by it |
| UPDATE-DOCS | Checks each section against the code, fixed tech debt and `(architecture)` Dev Log notes. Proposes one fix per drift. A new section changes the template first |
| ADD-GUARDRAILS | Collects observed failures (review findings, `(!)` markers, `(reviewer)` Dev Log entries, fix commits, plan revisions and fix phases) and proposes one guardrail per recurring failure, with the evidence as `reason`. No evidence, no guardrail. Started by the orchestrator with proposals you already accepted: skips the search, checks each, applies the good ones without asking again and asks only about problem ones |
| REVIEW-GUARDRAILS | Proposes sharper wording, enforcement by a test, or removal for vague, duplicate, contradicting, blocking or never relevant guardrails, in all six sections |
| TESTS | Investigates the code and existing tests, then summarizes needed tests grouped as unit logic, unit ui, unit a11y, integration, e2e and architecture, with tooling present or a suggested library. Only tests that add value. You approve, also partly. Then group by group: tooling, and per test: fail first, see it fail, final version, see it pass |
| MEASURE | Lists the `architect` commits. For the one you pick it compares the failures it targets before and after, and recommends keep, sharpen or remove |

**Why a template.** Architecture docs look different in every project. The skill ships only a catalog of sections and profiles per project type. The architect turns it into a template for your project, and the doc follows that template. Later runs reuse it, so the structure stays stable and drift is easy to find.

**Tech debt.** When a test fails because of production code, the architect doesn't fix the code and doesn't write a test that locks in the bug. It leaves the test out and adds the bug to the Tech debt section of the architecture doc. At the end it hands the new entries over, and the orchestrator offers to start an idea for them.

### Templates

- **config.json**: initial id counters for domain, phase and step. `nos init` copies it to `<specs>/config.json` (which also holds the `chat` settings). Ids are global across all domains.
- **nos.config.json**: initial project config, copied to the project root by `nos init`: `specs` (`dir`, `remote`; `dir` `null` = the default `../<project>.specs`, resolved on every call; an explicit value wins), `worktrees` (`slots`, `slotWait`), empty `quality-tools` and `project-commands`, and `spec-ui.docs-folder` (`docs`, the folder the viewer's Docs view shows).
- **domain.json**: domain structure. It has a name, labels and `cross-cutting` (`false` for now, reserved for an upcoming spec UI change). Written by `nos create-domain`.
- **plan.json**: plan structure. It has a name, status and phases. Phases have a name, status, intent, `human-validation-needed`, `review-needed`, a description and steps. Steps have an intent, status, `human-validation-needed`, `review-needed`, a description and `spec-file`, and every phase and step also has a slug. `spec-file` is filled by `nos`.
- **status.xml**: valid statuses. `nos set-status` rejects anything else.
  - Plans: `open`, `in-progress`, `on-hold`, `done`, `merged`, `discarded`.
  - Phases: `open`, `in-progress`, `implemented`, `in-review`, `reviewed`, `done`.
  - Steps: `open`, `in-specification`, `specified`, `in-progress`, `implemented`, `in-review`, `reviewed`, `done`, `merged`, `discarded`.
  - `merged` (branch is on main) and `discarded` (abandoned) are set only by `nos run finish` / `nos run abandon` for the whole run. Phases get none: a merged plan shows via the plan.
  - Three sections, `<plans>`, `<phases>` and `<steps>`, so a status can be valid for steps only.
- **step-spec-template.md**: sections Description, Acceptance Criteria, Spec Log (`(specify)` / `(spec-review)` entries), Test Strategy (integration, e2e, existing tests to change), Task List, Dev Log (What I did / What I didn't do and why), and Review.
- **review-template.md**: the Review section and phase `review.md`. It has a Date and Result line, a short summary, Criteria (one line per AC), Findings (`( )` with id, weight, category, location, evidence, fix and fix kind) and Fixes (written by review-fixing, referencing the commit prefix). Rules for weights and fix kinds are at the bottom.
- **architecture-sections.md**: catalog for a project's architecture template. Core sections (Overview, Stack & commands, Structure, Rules, Testing, Decisions, Tech debt), optional sections with "include when", profiles per project type, and the template format.
- **test-types.md**: test groups with when they add value and tooling examples, architecture rule ideas, enforcement mechanisms (lint rule, dependency graph, test) and pitfalls.
- **guardrails.xml**: structure of `docs/guardrails.xml`. One section per reader: `coding` (develop, integrate), `review` (both reviewers), `specify` (specify, spec-review), `plan` (plan), `architect`, `orchestrator` (the main session running `workflow.md`). Every guardrail has a `reason`. Orchestrator guardrails only add restrictions (extra parks, questions, MANUAL mode, refusals); they never remove a park and never override a workflow rule, the workflow wins on conflict. The orchestrator re-reads them after entering or leaving a worktree (the file is versioned per branch) and names a guardrail when it applies.

### Markers

Used in ACs, the Task List and review findings:

| Marker | Meaning |
| --- | --- |
| `( )` | open |
| `(x)` | done / met / fixed |
| `(!)` | problem, not fixable → verdict blocked |

### nos CLI commands used

| Command | Used by | Does |
| --- | --- | --- |
| `nos roots` | orchestrator, every ability without given paths | prints `home`, `work`, `main`, `specs`, `inWorktree`, `configured` |
| `nos init` | setup | creates `nos.config.json`, the `<specs>` repo next to the checkout (with the back-pointer) and the `.gitignore` entry if missing |
| `nos create-domain --idea <file> --slug <s>` | idea, quick-step | new domain id, folder, `idea.md`, `domain.json` |
| `nos create-plan --domain <d> --plan <file>` | plan (create) | saves `plan.json`, creates phase folders and step files |
| `nos update-plan --domain <d> --plan <file>` | plan (extend, revise) | saves the changed plan, creates/moves/deletes phases and steps |
| `nos create-quick-step --domain <d> --step <file>` | quick-step | new step id, quick step file, entry in `quick-steps/quick-steps.json` |
| `nos set-status --domain <d> [--phase <id>] [--step <id>] --status <s>` | orchestrator | changes one status, checked against the matching `status.xml` section. A step id not in `plan.json` is looked up in the quick steps |
| `nos run start\|sync\|finish\|cleanup\|abandon` | orchestrator | run lifecycle (branch, worktree, rebase, gate, ff-only merge, removal) |
| `nos specs commit (--run <r>\|--domain <d>\|--config) -m <msg>` | orchestrator | commits one domain's specs (or only `config.json`) in `<specs>` |
| `nos specs find-step <id>` | integrate | spec file of a step id in any domain |
| `nos gate [--e2e]` | develop, reviewers, integrate, architect, setup | the quality check, JSON per tool |
| `nos exec <install\|dev\|deploy-test>` | setup, `run start` | project commands with slot lease |

### Who may do what

| Role | Writes code | Writes spec | Changes status | Commits |
| --- | --- | --- | --- | --- |
| orchestrator | no | no | yes (nos) | `<specs>` only (`nos specs commit`); in the worktree only a step's leftovers on exit code 5 |
| idea / plan / quick-step | no | idea / plan / quick step (nos) | no | no |
| specify | no | Description, ACs, Spec Log, Test Strategy. Read-only once done | no | no |
| spec-review | no | Description, ACs, Spec Log, Test Strategy | no | no |
| develop | yes | Task List, AC ticks, Dev Log | no | code only (`step-<id>: `) |
| review-pessimistic | no | Review | no | no |
| review-fixing | yes | Review marks, Dev Log | no | code only (`step-<id>: `/`phase-<id>: `) |
| integrate | resolves conflicts | Dev Log `(merge)` | no | rebase, merge fixes (`step-<id>: `) |
| architect | tests and test tooling only | no. Writes architecture template and doc, guardrails | no | code and docs (`architect: `) |

### Known limitations

- Questions from subagents (idea, architect, and specify and spec-review in MANUAL) are relayed through the orchestrator session. They only work while that session is open.
- spec-review can ask specify only while the orchestrator session that ran specify is open. After a resume it decides alone.
- Reviewers find changes only through the commit prefix. A commit without the prefix is invisible to them.
- The run token lives in the session's transcript. A fresh session must take a running run over on purpose.
- Stale locks and run files after a crash are never broken automatically; nos shows holder and age, you decide (`nos lock release <name> --break`).
- An interrupted review reruns both review stages. The pessimistic review file is replaced.

### workflow.md: the orchestrator's playbook

| Block | Purpose |
| --- | --- |
| `<rules>` | Invocation and roots. Runs, token, specs commits after every ability, code commit prefixes. Orchestrator guardrails; lessons become guardrail proposals, never memories. Every ability runs in a new subagent. Statuses change only via `nos set-status`. Questions from subagents are relayed to you and the answers sent back to the same subagent. Reports use simple language. Every question uses the `A - text [KEY]` format |
| `<exitCodes>` | What to do on each nos exit code: 3 integrate (blocked → DECIDE), 4 take over or stop (merge lock: wait and retry), 6 switch, wait or stop, 5 commit the step's leftover files or park, 7 and 1 park |
| `<start>` | `nos roots`, the setup check, resume of a run when the session sits in its worktree, and the IDEA / PLAN / RUN / QUICK / ARCHITECT / SETUP / CHAT menu |
| `<option name="idea">` | Runs idea, then offers PLAN |
| `<option name="architect">` | Runs architect. Tech debt handed over → offers an idea for all bugs or one per bug |
| `<option name="plan">` | Picks a domain without a plan, runs plan (create), then offers RUN |
| `<option name="quick">` | Continues an unfinished quick step or runs quick-step for a new one, then runs the step cycle for it |
| `<modes>` | Defines AUTO and MANUAL through the `mode` attribute on each `<park>` |
| `<option name="run">` | Picks a plan or quick step, starts or resumes its run (`nos run start`, enter the worktree) and a mode. Quick step → step cycle, then finish. Plan → sets the plan `in-progress`, runs every unfinished phase, sets the plan `done`, asks to integrate |
| `<cycle name="finish">` | `nos run finish`, leave the worktree, `nos run cleanup` |
| `<cycle name="phase">` | Runs all steps, then reviews the phase as a whole |
| `<cycle name="step">` | specify → spec-review → develop → review-pessimistic → review-fixing |
| `<proposals>` | Asks pending guardrail proposals (P1… / ALL / NO) at a park or final report; accepted ones go to architect ADD-GUARDRAILS |
| `<park>` | Stop, explain, ask pending proposals, then GO / switch mode / REJECT / PAUSE / ABANDON |
| `<resume>` | How to continue after an interruption |

---

## Part 3: Understanding harnesses (for newcomers)

### What is a harness?

An AI coding agent on its own is one long conversation. It forgets, it drifts, it grades its own homework, and it is hard to stop and resume. A **harness** is the structure around the agent: roles, rules, files and tools that turn "chat with an AI" into a repeatable process.

A useful mental model is a small team with a project board:

| Team | nos |
| --- | --- |
| Project manager | orchestrator (`SKILL.md` + `workflow.md`) |
| Product owner interview | idea |
| Implementation architect | plan |
| Requirements engineer | specify |
| Spec reviewer | spec-review |
| Developer | develop |
| Critical code reviewer | review-pessimistic |
| Senior reviewer who fixes | review-fixing |
| Quality and docs architect | architect |
| Ticket board | `plan.json` + statuses |
| Tickets | step spec files |
| Board admin tool | `nos` CLI |

### The ideas behind the design

Each idea is worth stealing on its own:

1. **One job per context.** Every ability runs in a fresh subagent. A fresh context has no bias from earlier work and no clutter. That is why develop, the first review and the second review are separate agents.
2. **The orchestrator does not work.** When the manager also codes, it loses track of the process. Keeping it to "delegate and report" keeps its context small enough for long runs.
3. **State lives in files, not in memory.** Statuses in `plan.json`, specs in markdown, changes in git. Any session can pick up where another stopped. This is what makes resume after a shutdown possible.
4. **Deterministic things go into a tool.** Ids, folder names and status changes are done by `nos`, not by the AI. An AI can mistype JSON; a CLI with validation cannot.
5. **Statuses form a state machine.** Every status is set by exactly one step. So the current status always tells you where to continue.
6. **Parking states give humans control.** `specified`, `implemented` and `reviewed` are places to stop. AUTO passes through them, MANUAL stops at each, and human validation always stops at `reviewed`. You choose how much autonomy you give.
7. **Review in two stages against bias.** The first reviewer is told to find problems. The second one reviews on its own before reading those findings, then judges them. This catches both missed bugs and false alarms.
8. **Business-readable acceptance criteria.** ACs without code terms let a non-developer verify the result. That makes human validation meaningful.
9. **TDD and "never change a test to pass".** Tests are the contract. The rule stops the agent from cheating its way to green.
10. **Minimal pseudo-XML instructions.** Short tagged steps are easier for a model to follow, and for you to read and change, than long prose.

### How to learn it

- Read `workflow.md` next to the status diagram in Part 2. It is the whole process on one page.
- Run a tiny idea (for example "add a footer with the version number") in MANUAL mode. Watch each park and open the spec file every time.
- Look at `git log` and the spec's Dev Log and Review sections after each step. That is where you see what each role did.
- Then try AUTO on something slightly bigger.

### Ideas for your own harness

- Other roles: a security reviewer, a documentation writer, a UX checker driving a browser, a performance reviewer.
- A different state store: GitHub issues or a ticket system instead of `plan.json`.
- Notifications: send a message when a run parks.
- Cost control: cheaper models for simple roles through `effort` or model settings in the frontmatter.
- Parallel steps: independent steps in separate git worktrees.
- Metrics: count how often reviews find bugs, to see which roles earn their cost.

---

## Part 4: Changing the blueprint

### The golden rule: keep it consistent

Most changes touch more than one file. Before you finish a change, check these connections:

| If you change… | Also check… |
| --- | --- |
| an ability name or file | the `<abilities>` list in `SKILL.md` and every `Run ability "..."` in `workflow.md` |
| a status | the right section (`<plans>`, `<phases>`, `<steps>`) of `templates/status.xml` (nos validates against it), every `<status from to>` in `workflow.md`, the `resume-at` attributes, `ui/src/status.ts` and the colours in `ui/styles.css` |
| what an ability reports (e.g. `pass`/`blocked`) | the `<park when="...">` that reacts to it in `workflow.md` |
| spec sections | `step-spec-template.md` and every skill that reads or writes that section |
| review layout (weights, fix kinds, Result) | `review-template.md`, the `<passes>` of review-pessimistic, review-fixing |
| inputs of an ability | what the caller passes in `workflow.md` |
| commit prefix (`step-<id>: `, with colon) | develop, review-fixing, integrate, review-pessimistic (it matches the prefix exactly), `workflow.md` (specs commit messages, exit code 5). `architect: ` prefix: architect (MEASURE searches by it) |
| a `nos` command or its output | `workflow.md` (exit code table), the abilities that call it, `templates/quality-tools.md` (gate, exec), `cli/README.md` |
| markers | specify, spec-review, develop, both reviewers, the template, `ui/src/model.ts` |
| doc paths (`<work>/docs/architecture.md`, `<work>/docs/architecture-template.md`, `<work>/docs/guardrails.xml`) | architect `<files>` and every ability that reads them: plan, develop, integrate, specify, spec-review, both reviewers; `workflow.md` (orchestrator guardrails) |
| Spec Log markers `(specify)`, `(spec-review)` | specify, spec-review, develop (must not change it), the template |
| Test Strategy section | the template, specify, spec-review, develop, review-pessimistic (tests pass) |
| Dev Log marker `(architecture)` | develop, review-fixing, architect (UPDATE-DOCS) |
| guardrail sections (`coding`, `review`, `specify`, `plan`, `architect`, `orchestrator`) | `templates/guardrails.xml`, architect (ADD-GUARDRAILS, REVIEW-GUARDRAILS), `workflow.md` rule "Lessons → guardrail proposals", the readers of the section (`specify`: specify and spec-review; `plan`: plan; `orchestrator`: `workflow.md` rule "Guardrails" and `SKILL.md`) |
| architect handover (tech debt) | `<option name="architect">` in `workflow.md`, `idea.md` input |
| `plan.json` structure or spec sections | `ui/src/model.ts` and its tests |

### Changing it by hand

The files are plain text, so no tools are needed.

**Change behaviour inside a role.** Edit the `<workflow>` or `<coreRules>` of that file in `abilities/`. Example: make the pessimistic reviewer also check accessibility by adding it to `<focus target="step">`.

**Add a role.** Example: a security review after the pessimistic review.
1. Create `abilities/review-security.md` with frontmatter, `<coreRules>`, `<input>` and `<workflow>`. Copy an existing reviewer as a starting point.
2. Add an `<ability name="review-security">` to `SKILL.md`.
3. In `workflow.md`, add `<do>Run ability "review-security" with the step</do>` to step5 of the step cycle (the review step), plus a `<park>` if it can block.

**Add a stop point.** Example: always stop before a phase review. Add `<park mode="auto,manual"/>` to step2 of the phase cycle.

**Change when AUTO stops.** Add or remove `auto` in a park's `mode` attribute.

**Add a status.** Add it to `status.xml`, then add a cycle step with `<status from to>` and `resume-at` in `workflow.md`, and adjust the `from` of the next step. Every status must be set by exactly one step, or resume breaks.

**Change the spec.** Edit `step-spec-template.md`, then the skills that fill that section.

**Tip:** make small changes and test each one with a tiny idea in MANUAL mode.

### Changing it with AI

Claude Code can edit the harness too. What worked well while building this one:

1. **Use plan mode.** Let the AI propose first and edit after you approve.
2. **Ask for the exact final text.** Have the plan show the complete new pseudo-XML, not a summary, so you can check every word.
3. **Change one skill at a time.** Review it, commit it, then go to the next.
4. **Let it ask questions.** Tell it to ask when the intended workflow is unclear instead of guessing.
5. **Ask for a consistency check.** After a change, have it check the table above.
6. **Keep it lean.** Tell it to avoid bloat: minimal pseudo-XML, one line per step.
7. **Test the edge cases in conversation.** Ask "what happens if the computer shuts down while a step is in-review?". Questions like that found real gaps in this blueprint.

Example prompts:

```
Add a security review ability after the pessimistic review. Show the full new file
and every change to SKILL.md and workflow.md in the plan. Ask me when unsure.
```

```
Check the nos skill for consistency: ability names, statuses vs status.xml,
verdicts vs parks, inputs vs callers, commit prefixes. List problems only.
```

```
Walk through a run where the user rejects phase 2 and then the usage limit hits
during the fix phase review. Which statuses are set, and where does it resume?
```

---

## Part 5: Spec UI (viewer)

`ui/` is a read-only browser viewer for `<specs>/` and the project docs. It shows what nos is doing without opening JSON or markdown files. It never changes anything. Statuses change only through `nos set-status`.

### Use it

**Without a server (standalone):**
1. Open `.claude/skills/nos/ui/index.html` straight from disk in Chrome or Edge. These browsers support the File System Access API.
2. Click **Open the specs folder** and pick the specs root (by default `<project>.specs` next to the project; Docs stays empty then: a picked folder cannot reach the project next to it). A project folder whose specs root lies inside it works too, docs included; picking a project folder whose specs root lies outside says which folder to pick instead.
3. The folder is remembered, so the next visit takes one click (**Reopen**). **↻ Reload** reads the folder again.

**With live reload (dev server):**
```
cd .claude/skills/nos/ui
npm install      # once
npm run dev           # or: npm run dev-to-lan
```
This serves `dev.html` on http://localhost:5180. The server reads `<specs>/` and the docs folder from disk and the page fetches them (`/__specs`, `/__docs`). When a spec or doc changes the page refreshes by itself; **↻ Reload** fetches again. It is handy for watching a run in AUTO mode.

The dev server finds the project with the nos resolver: it walks up from `ui/` to the first `nos.config.json`. Not set up yet → the page says "nos is not set up … run nos init". Environment:

| Variable | Effect |
| --- | --- |
| `NOS_SPECS_ROOT=<project>` | serve another project than the one nos sits in (also turns the browser auto-open off) |
| `NOS_UI_OPEN=0` / `1` | never / always open `dev.html` in the browser on start (default: open, except under `NOS_SPECS_ROOT`, vitest or CI) |
| `NOS_CHAT_PORT` | port of the chat server the dev server starts (`nos chat start`: a running server with the same version and code fingerprint is kept with its tabs; other code is replaced) |

Runs (`nos run start`) show live: `/__runs` lists `<specs>/.runs/*.json` with ahead/behind main and a dirty worktree. A chat tab working in a run shows its id (`quick-7`). Domains, quick steps and cards get a dot: pulsing = running, grey = stale (not seen for 2h), green = merged/abandoned, awaiting `nos run cleanup`. Statuses `merged` and `discarded` have their own pills; Board and Backlog hide `discarded` unless the status filter asks for it.

`npm run dev-to-lan` does the same, but also listens on the network. Other devices open the printed `Network` URL (`http://<host-ip>:5180/`) and see the host's `<specs>/` without picking a folder. Windows may ask to let Node through the firewall.

### Views

| View | Shows |
| --- | --- |
| **Ideas** | Domains without a `plan.json`. In the live viewer (dev server) an idea's page has a **Manual promote** button: it runs `nos create-plan --domain <folder> --hollow`, which saves an empty `plan.json` (`status` open, no phases), so the idea moves to Domains. The standalone viewer shows the command to run instead. A later PLAN replaces the hollow plan; RUN skips plans without phases |
| **Domains** | Domains with a `plan.json`. Tree of domains → phases → steps on the left, plus a "Quick steps" node per domain that has quick steps. On the right: details (idea.md, rendered spec, AC/task progress) and a kanban per domain, phase or the quick steps of a domain. Old `#explore` links still open |
| **Board** | One kanban of all steps or phases across all ideas. There is one column per status. Step boards include `in specification` and `specified`; phase boards only show them when used. `on-hold` and unknown statuses appear only when used |
| **Backlog** | The same items as a sortable table (id, title, where, status, AC progress) with status tiles |
| **Docs** | The docs folder (`"spec-ui": { "docs-folder": "docs" }` in `nos.config.json`, relative to the repo root) as a tree of its own folders and text files. Markdown is rendered, and relative links between docs work. Other text is shown as code. A folder shows its `index.md`/`README.md` and its contents |

Board and Backlog can be filtered by label, status, domain and free text. Labels and domains are picked from a search box with suggestions (the list opens on focus) and show as removable badges; domains are named by `name` in `domain.json`. Values of one kind combine with OR, different kinds with AND. Filters live in the URL hash (`#board?status=in-review&labels=ui`), so every view can be bookmarked. Cards show AC and task progress, which is counted from the `( )`/`(x)` markers, a badge for human validation and a ⚡ quick badge for quick steps. Quick steps show in every step kanban and in the backlog next to plan steps (path `<idea> › Quick`). Unknown statuses are flagged.

### Chat with Claude (live viewer only)

The **Chat** button in the header opens the chat of this project (ability `chat`, `nos chat`). Each tab is its own
headless Claude Code session in the project root, run by the chat server (`claude -p --resume <id>`, permission mode
`auto`, no permission prompts). **+** opens a new tab, **✕** on a tab closes it, **✎ Rename** names the active tab,
**Stop** ends the current run, a tab's tooltip names
`claude --resume <id>` to continue it in a terminal. While Claude works, the current tool call shows under the log.
On a desktop the chat is a drawer next to the views; on a phone or tablet (≤ 860px) a full-size dialog that the back
gesture closes. Messages carry the spec you look at as `[context: …]` (absolute path from the live viewer, so a tab inside a run worktree finds it; each tab gets the specs root via `--add-dir`); detail pages offer **Ask Claude** buttons
(specify, develop, review, plan) that prefill a message. `"chat": { "runner": false }` in `<specs>/config.json` switches
to relay: a terminal session answers with `nos chat await` / `reply`.

From the couch (`npm run dev-to-lan`):

- **HTTPS**: the dev server uses a self-signed certificate made once and kept in `<specs>/.chat/tls/`. Each phone shows a
  warning once; compare the fingerprint the terminal prints with the one the phone shows, then accept.
- **Pairing**: the terminal prints a one-time link and QR code (also "Pair a device" in the chat panel's **Devices**,
  or `nos chat pair`). A link works **once, within 10 minutes**. The phone then shows a 4-digit number; allow the
  device on the PC only if the PC shows the same number (toast, Devices panel, or `nos chat devices --approve <id>`).
- **Per device**: each device gets its own cookie (30 days idle, only a hash is stored). Revoke one in **Devices** or
  with `nos chat devices --revoke <id>` (`--revoke-all` for all); its open chat stops at once.
- **Whole spec-ui gated**: other devices see nothing (specs, docs, promote, live reload) before they are paired. This
  PC needs no pairing.
- **Audit log**: `<specs>/.chat/audit.log` records pairing, approvals and every chat action with the device. Everything in
  `<specs>/.chat/` is gitignored.
- Anyone holding a paired device can make Claude Code act in the project (auto mode). `"permissionMode"` in `"chat"`
  sets another mode, e.g. `acceptEdits` or `plan`.
- Design: `ui/requirements/Concept spec-ui chat integration.md`.

### How it works

| File | Role |
| --- | --- |
| `src/model.ts` | Pure: turns `path → text` of `<specs>/` into ideas → phases → steps. Parses `domain.json` (name, labels, cross-cutting), `plan.json` and `quick-steps/quick-steps.json` (quick steps: `phase` null, `quick` true), reads the spec sections, counts markers |
| `src/status.ts` | The statuses from `templates/status.xml` and their board order |
| `src/serve-specs.ts` + `src/main.ts` | Dev server: a Vite plugin reads `<specs>/` on the host with `readSpecsFolder` and serves it at `/__specs` (`/` is `dev.html`); `/__docs` serves the docs folder (`readDocs`); it pushes `specs:changed` / `docs:changed` when a file changes, and the page fetches again. `POST /__promote?domain=<folder>` runs `nos create-plan --hollow` (Manual promote) |
| `src/folder.ts` + `src/handle-store.ts` + `src/standalone.ts` | Standalone: reads the picked folder (specs and docs) and remembers the handle in IndexedDB |
| `src/docs.ts` | Pure: turns `path → text` of the docs folder into a folder tree, resolves relative links |
| `src/route.ts`, `src/filter.ts` | Hash routes and filters |
| `src/app.ts`, `src/views/*` | Rendering: explore, board, backlog, docs, kanban, filter bar |
| `src/markdown.ts` | Minimal markdown renderer. Escapes first, so no raw HTML is rendered |
| `bundle/viewer.js` | Built standalone script (IIFE, because `file://` pages can't load modules). Commit it with source changes |
| `tests/` | Vitest tests. `real-specs.test.ts` checks that the project's real `<specs>/` parse |
| `package.json`, `tsconfig.json`, `vite.config.ts` | Its own package: vite, vitest, jsdom, TypeScript, Prettier. Nothing in the host project |

The viewer is a separate npm package, so the project it sits in has no viewer scripts, tests or configs. Run these inside `ui/`:

| Command | Does |
| --- | --- |
| `npm run dev` | dev server with live reload |
| `npm run dev-to-lan` | the same, reachable from other devices on the network |
| `npm test` / `npm run test:watch` | viewer tests |
| `npm run typecheck` | TypeScript check |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run build` | rebuilds `bundle/viewer.js`. Commit it with every source change |

### Changing it

- **New status:** add it to `src/status.ts` (`STATUS_ORDER`, `STEP_BOARD_STATUSES` / `PHASE_BOARD_STATUSES`, labels) and a colour to `styles.css`, as well as to `status.xml`. Otherwise it shows as a flagged "other".
- **New spec section with markers:** add a `progress(section(...))` in `src/model.ts`, then show it in `src/views/parts.ts`.
- **New `plan.json` or `domain.json` field:** extend the `Raw*` types and the model in `src/model.ts`.
- Changes to the spec template or the plan structure must also be checked against the viewer (see the consistency table in Part 4). `tests/real-specs.test.ts` fails when the real `<specs>/` no longer parse.

---

## Part 6: nos CLI

`cli/` holds `nos`, the file manager for `<specs>/` and the driver of every git step of a run. It hands out ids from the counters in `<specs>/config.json`, creates domain and phase folders, lays out empty step spec files, changes statuses in `plan.json`, and runs worktrees, rebase, gate, merge, locks and specs commits. The AI never does these by hand (idea 4 in Part 3). No dependencies, Node.js 20+.

Full reference (all options, examples, `update-plan` rules, output format): [`cli/README.md`](cli/README.md).

### Install

```
cd .claude/skills/nos/cli
npm install     # no dependencies
```

Invocation: `node <home>/cli/bin/nos.js <command>`, `<home>` = the nos folder, absolute. Orchestrator, abilities, hooks and permissions use only this form, typed out literally (no `npm link`, no shell variable, function or alias: worktree isolation refuses computed command names), so a stale copy of nos inside a worktree never runs; the CLI warns when it does. Help: `nos help <command>` or `nos <command> --help`.

### Commands

| Command | Does |
| --- | --- |
| `roots` | prints the resolved `home`, `work`, `main`, `specs` (absolute), `inWorktree`, `configured` |
| `init` | creates `nos.config.json`, `<specs>/` (own git repo) and the `.gitignore` entries if missing. Run on main |
| `create-domain --idea <file\|-> --slug <s>` | a domain id, creates `<specs>/domain-<id>-<slug>/idea.md` and `domain.json` |
| `create-plan --domain <d> --plan <file\|->` | saves `plan.json`, creates phase folders and empty step files, fills `spec-file`. One plan per domain |
| `update-plan --domain <d> --plan <file\|-> [--dry-run] [--force]` | saves a changed plan, creates/moves/deletes phases and steps. Deleting files with content needs `--force` |
| `create-quick-step --domain <d> --step <file\|->` | reserves a step id, creates `quick-steps/step-<id>-<slug>.md` and adds the step to `quick-steps/quick-steps.json` |
| `set-status --domain <d> [--phase <id>] [--step <id>] --status <s>` | changes one status. Plan, phase or step depends on the arguments. A step not in `plan.json` (without `--phase`) is looked up in the quick steps. Checked against `templates/status.xml`. `--run <r> merged\|discarded` flips a whole run (finish/abandon only) |
| `run start --domain <d> (--plan\|--quick <id>)` | branch + worktree + run token for a plan or quick step |
| `run sync\|finish\|cleanup\|abandon --token <t>` | rebase onto main; lock + checks + gate + ff-only merge; remove worktree and branch; drop the run |
| `gate [--e2e]` | the quality tools of `nos.config.json`, JSON per tool |
| `exec <install\|dev\|deploy-test>` | a project command; `dev` holds a slot |
| `specs commit (--run <r>\|--domain <d>\|--config) -m <msg>` | commits one domain's specs (or only `config.json`) in `<specs>`. Never `--domain` for a domain another session's run owns |
| `specs find-step <id>` | spec file of a step id |
| `lock take\|release\|status <name> --token <t> [--break]` | the `merge`, `ids`, `slot-<n>` locks |

### Rules

- `nos` never generates slugs. They must be lowercase kebab-case (`user-auth`).
- `-` as a file argument reads from stdin.
- `--root <dir>` sets the work root (default: walk up from the current directory to `nos.config.json`). `main` and `specs` are derived from it, also from inside a worktree.
- Plans are validated before anything is written.
- Output is JSON on stdout with absolute paths, errors on stderr. Exit codes: `0` success, `1` failed, `2` usage error, `3` rebase conflict, `4` held by another holder, `5` dirty worktree, `6` domain already running, `7` slot wait timeout. 3–7 also print `{action, error, exit, details}` on stdout.
- Ids are global across the project and never reused.

### Develop it

Run inside `cli/`: `npm test` (node:test) or `npm run test:watch`. Code lives in `src/`, one file per command. See `cli/README.md` for the file table.

---

## Porting to another project

1. Clone or copy nos into `.claude/skills/nos/` (tracked or ignored, both work) and set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`.
2. `npm install` in `cli/` (Part 6). Run `/nos` → `SETUP` on main: it creates `nos.config.json`, `<specs>/` (next to the project folder) and the `.gitignore` entry. Commit nothing else by hand.
3. Make sure the project has a test command, a linter and a formatter, or remove those checks from develop and the reviewers.
   Then run `/nos` → `ARCHITECT`: CREATE-DOCS for the architecture docs, TESTS for missing test types. Add guardrails later, once runs show real failures.
4. Viewer: comes along with the folder. Opening `ui/index.html` needs nothing. For live reload or changes, run `npm install` in `ui/`. The dev server finds the project like the CLI does (walks up to `nos.config.json`, `NOS_SPECS_ROOT` overrides).
5. Parallel e2e runs and dev servers: derive ports and base url from `NOS_SLOT` in the project's dev and e2e config (e.g. `5173 + NOS_SLOT`), then raise `worktrees.slots`.

### Migrating a project with tracked `specs/`

Older nos versions kept the specs in a tracked `specs/` folder with `specs/config.json`. The new nos does not detect or convert that layout (a `spec-file` starting with `specs/` fails with "run the migration"). Migrate once by hand, working tree clean, following the rehearsed steps 0–10 in `ui/requirements/Concept specs repo and worktrees.md`, section "Migration of this project": stop the chat server with the old CLI before updating nos (the new one looks for its state in `<specs>/.chat`), split the `specs/` history with `git filter-branch --prune-empty --subdirectory-filter specs` in a bare throw-away clone (not `git subtree split`: it leaks project history when `specs/` was deleted and re-added), write `<specs>/.gitattributes` (`* text=auto eol=lf`) before pulling it into the `<specs>` repo (target: the sibling folder `../<project>.specs`), move `.chat`, split the config into `nos.config.json` (`specs.dir` `null`: the default `../<project>.specs`; `project-commands.install` `npm ci`; prettier from the project with its `node_modules`) and `<specs>/config.json` (with the back-pointer `project`), drop the `specs/` prefix of every `spec-file` and fix stale paths with a JSON-safe script (every spec-file must resolve), untrack `specs/`, run `nos init --root <project>` (adds the missing `.gitignore` entry), commit both repos, write `.claude/settings.local.json` with absolute paths and `additionalDirectories` and remove the old nos entries from `settings.json` (delete it if empty) with a JSON-safe script, and verify with `nos roots` (also from `<specs>/.chat`), the ui real-specs test, spec-ui, chat and `nos gate`.
