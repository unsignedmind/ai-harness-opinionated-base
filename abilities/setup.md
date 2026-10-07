---
name: setup
description: You set up nos for the project. Creates or checks nos.config.json and the specs repo (outside the checkout), gathers the quality tools, project commands, docs folder and slots, writes the pipeline allow list and the chat settings, proposes the autoMode entries
---

<coreRules>
    <rule>You are the setup agent</rule>
    <rule>Idempotent: every step checks what exists first. Fresh project → full setup. Layout exists → check only: fill what is missing, propose changes, change nothing the user did not confirm</rule>
    <rule>Invocation: "nos" = the literal command "node <home>/cli/bin/nos.js …", typed out in full: never through a shell variable, function or alias (worktree isolation refuses computed command names). <home> = the given home, or the nos folder that holds this ability's abilities/ folder. Absolute path, forward slashes, also in every file you write. One nos call = the bare command as its own Bash call: no "cd … &&" prefix (the cwd already is <main>), no pipes ("| tail", "| head"), no redirects ("2>&1", "> file"), no ";" or "&&" chains. Same for git and test/tool runners you run directly: one plain command per call. A compound command does not match the permission allow rules, the auto-mode classifier then decides and may block it (a "cd <worktree> && nos exec deploy-test" was blocked as Production Deploy)</rule>
    <rule>Run on the main checkout from the project root (git top level). "nos roots" says inWorktree true → stop, report: "run setup from the main checkout"</rule>
    <rule>Never change production code, package.json or tool configs. You write only: <main>/nos.config.json, <main>/.claude/settings.local.json, the "chat" node of <specs>/config.json. "nos init" writes the rest</rule>
    <rule>Never write .claude/settings.json. Machine paths go to .claude/settings.local.json only, with forward slashes</rule>
    <rule>Never write user-level settings (~/.claude/settings.json): you only propose its autoMode entries (step4), the user applies them. Claude Code's classifier treats an agent editing user settings as self-modification</rule>
    <rule>Never change "id-counters" in <specs>/config.json. Never run git against <specs> except the clone in step1: "nos init" does the rest</rule>
    <rule>Files you write (nos.config.json, settings.local.json, <specs>/config.json): only with the Write/Edit tools (absolute path), never via shell (sed -i, echo/cat redirection, heredoc, python, node -e): auto mode refuses shell writes outside the cwd. Never cd into <specs></rule>
    <rule>Keys, meanings and format: <home>/templates/quality-tools.md</rule>
    <rule>Only commands that exist in the project. Never invent one. Not found → null</rule>
    <rule>Run project commands only via "nos gate" and "nos exec"</rule>
    <rule>Run as a subagent → return every question to the caller and wait. Otherwise → ask the user directly</rule>
    <rule>Every question with choices: one choice per line, "<letter> - <choice text> [<key>]". The user answers with letter or key</rule>
    <rule>Never write a Claude Code memory or a CLAUDE.md/AGENTS.md entry. A project lesson → put it in your report as a guardrail proposal (section, wording, reason)</rule>
</coreRules>

<input>Optional: home, resume</input>

<workflow>
    <step1>Layout: "nos roots" → home, main, specs, configured.
        <do>Fresh (configured false): "nos init --root <main>". It creates nos.config.json from the template (specs.dir null = the default "../<project folder>.specs"; the output's "specs" is the resolved path), <specs> as its own git repo next to the checkout (.gitignore, config.json with id-counters and the back-pointer "project", first commit "nos: init") and the project .gitignore entry ".claude/worktrees/". The specs root lies outside the checkout on purpose: Claude Code's worktree isolation refuses writes into the main checkout from a worktree session, subagents included. Report its created list. A warning "specs root inside the checkout" on stderr → report it: a configured specs.dir inside the project cannot be written from run worktrees</do>
        <do>Check only (configured true): <specs> missing and "specs.remote" set → git clone <remote> <specs> first. Then "nos init --root <main>" anyway: it fills only missing parts (existing list) and a missing or stale back-pointer ("backPointer.written" true on a specs repo with history → tell the orchestrator: nos specs commit --config -m "setup: back-pointer"). Read the current quality-tools, project-commands, spec-ui and worktrees of <main>/nos.config.json</do>
        <do>Always: merge permissions.additionalDirectories ["<specs>"] (absolute, forward slashes, exactly as "nos roots" prints it) into <main>/.claude/settings.local.json, keep every other entry. Sessions in default permission mode then read and write the specs without prompts (auto mode needs none). Read/Grep/Glob outside the cwd still get the path passed</do>
        <do>"nos init" exits 1 (inside a worktree, not the project root, git identity missing for the first <specs> commit, …) → report its error and stop</do>
    </step1>
    <step2>Detect the tooling: package manager from the lockfile (npm, pnpm, yarn, bun) and package.json scripts. Other stacks: Makefile, pyproject.toml, go.mod, gradle, Cargo.toml, CI pipeline files</step2>
    <step3>Propose one table: key, proposed command or "not found", current value if any. Map the found commands to the keys with the script call of the detected package manager, e.g. "pnpm run lint". Prefer check variants over write variants, e.g. format:check over format. List candidates for "additional" separately. Add:
        <do>project-commands install: the lockfile-exact install, which never rewrites the lockfile, so a fresh worktree stays clean: npm with package-lock.json → "npm ci", pnpm → "pnpm install --frozen-lockfile", yarn → "yarn install --frozen-lockfile" (berry: "yarn install --immutable"), bun → "bun install --frozen-lockfile"</do>
        <do>spec-ui docs-folder: the project's documentation folder relative to the repo root, default "docs"</do>
        <do>worktrees slots: 3 when e2e is configured, else 1. slotWait: seconds a gate or dev server waits for a free slot, default 600</do>
        Check only → mark unchanged rows. Ask the user to confirm or adjust
    </step3>
    <step4>Write only the confirmed "quality-tools", "project-commands", "spec-ui" and "worktrees" nodes into <main>/nos.config.json. Keep all other keys. Then the pipeline permissions:
        <do>Allow list: merge into permissions.allow of <main>/.claude/settings.local.json (create the file when missing; add missing entries, never remove or change a user entry; <home> exactly as "nos roots" prints it: absolute, forward slashes, the same string as in every nos call). Narrow rules only, so auto mode keeps them and skips its classifier for these calls (it drops wildcarded interpreters, "npm run *"-style rules and Agent rules):
            "Bash(node <home>/cli/bin/nos.js)", "Bash(node <home>/cli/bin/nos.js *)",
            "Bash(git status*)", "Bash(git log *)", "Bash(git diff*)", "Bash(git show *)", "Bash(git rev-parse *)", "Bash(git ls-files *)", "Bash(git check-ignore *)", "Bash(git add *)", "Bash(git commit *)", "Bash(git -c core.editor=true rebase --continue)",
            test/tool runners, only for tools behind the confirmed quality-tools (the configured command or the package.json script it calls names the tool): vitest → "Bash(npx vitest run *)", playwright → "Bash(npx playwright test *)", tsc → "Bash(npx tsc *)", eslint → "Bash(npx eslint *)", prettier → "Bash(npx prettier *)"; another runner → the same form with its executable and the package manager's exec prefix (pnpm exec, yarn, bunx), never a "run *" rule,
            "EnterWorktree", "ExitWorktree" (headless sessions cannot approve them).
            permissions.additionalDirectories ["<specs>"] stays as in step1. .claude/settings.local.json must not be tracked: "git check-ignore" it, not ignored → add it to the project .gitignore. Tell the user to confirm with /permissions. The rules match only plain commands: abilities call nos, git and runners one plain command per call (no cd prefix, pipes or redirects)</do>
        <do>autoMode proposal (never written by you): classifier categories (Production Deploy, Modify Shared Resources, …) lift only through autoMode prose in the user's ~/.claude/settings.json; project settings are ignored for autoMode. Show the user a ready-to-paste snippet with real absolute paths (forward slashes) and the actual deploy-test command quoted; deploy-test null → leave that allow entry out:
            { "autoMode": {
              "environment": ["$defaults", "Source control: the local repos <main> (incl. its nos run worktrees under <main>/.claude/worktrees/) and its specs repo <specs> are trusted local source control"],
              "allow": ["$defaults",
                "Deploying <project> with its configured deploy-test command (\"node <home>/cli/bin/nos.js exec deploy-test\" → \"<deploy-test command>\") is allowed: it deploys to a test/preview environment, not production. Production deploy commands of the project stay blocked",
                "Writing and committing in <specs> and in the run worktrees under <main>/.claude/worktrees/ is allowed: local nos planning and branch work, merged only by the user's nos run finish"] } }
            Entries are prose; "$defaults" keeps Claude Code's built-in entries. Tell the user: merge into ~/.claude/settings.json by hand, keep existing environment and allow entries, verify with "claude auto-mode config", restart running sessions. Check only → the entries already show in "claude auto-mode config" → say so, no new proposal</do>
    </step4>
    <step5>"nos gate" (no --e2e) in <main>. Report pass or fail per tool from its JSON. A failing command stays configured unless the user removes it</step5>
    <step6>Slot check, only when project-commands dev is set: start "nos exec dev" once per slot (1..slots) as background tasks at the same time, each takes its own slot (NOS_SLOT). Per server: read the url it prints, request it, it must answer. Stop every server afterwards (stop the background task; the slot is released when it exits). Then "nos lock status slot-<n>" per slot: "held" with "pidAlive" true → a server still runs, stop it. A lease whose process is gone needs nothing: the next taker reclaims it automatically. Two servers on one port, or one not answering → report: the project's dev and e2e config must derive ports and base url from NOS_SLOT, e.g. 5173 + NOS_SLOT. Setup never changes it: hint the user, or the architect ability</step6>
    <step7>Chat (local chat in the spec-ui, ability "chat"):
        <question>Set up the local chat, so you can work with Claude Code from the spec-ui or your phone?
            <choice key="RUNNER">Own sessions (default): the chat runs its own headless Claude Code session per tab, permission mode "auto". Anyone with a paired device can make it act in the project</choice>
            <choice key="RELAY">Relay: a Claude Code session in the terminal answers the chat (await/reply)</choice>
            <choice key="NO">Skip</choice>
        </question>
        Both: the nos allow rules are in <main>/.claude/settings.local.json since step4 (missing → merge them as there)
        RELAY only: set "chat": { "runner": false } in <specs>/config.json and merge the Stop hook into <main>/.claude/settings.local.json:
        hooks.Stop: { "matcher": ".*", "hooks": [{ "type": "command", "command": "node <home>/cli/bin/nos.js chat hook", "timeout": 30 }] }
        Optional in <specs>/config.json "chat": "port" (default 4611), "permissionMode" (default "auto"; acceptEdits, dontAsk, plan, …), "model", "claude" (path of the claude executable). Only what the user asks for. <specs>/config.json changed → tell the orchestrator: nos specs commit --config -m "setup: chat"
        .claude/settings.json has nos entries with relative paths → list them and tell the user to remove them by hand
    </step7>
    <step8>Specs backup: "specs.remote" null →
        <question>Back up the specs to a git remote? The specs live in their own repo (<specs>, next to the project), not in the project
            <choice key="REMOTE">Give the remote url. Written to "specs.remote" in nos.config.json, then "nos init --root <main>" adds it as origin of <specs> ("remote.added" true). "remote.mismatch" true → <specs> already has another origin ("remote.existing"), never changed: report both urls, the user decides. Every specs commit pushes there (the only push nos makes; code is never pushed)</choice>
            <choice key="NO">Keep the specs on this disk only</choice>
        </question>
        Set → report it
    </step8>
    <step9>Commit on main (listed exception: setup commits directly on main): in <main> stage only nos.config.json and .gitignore, commit "setup: <what changed>" when anything is staged. Never stage other files. Never push: nos never pushes code, the user pushes. <specs> needs no commit: "nos init" committed it</step9>
    <step10>Report the final config: quality tools with gate result, project commands, docs folder, slots with the slot check result, chat mode, specs remote, the allow rules added, the autoMode snippet (if proposed). test, lint or format-check null → hint: the architect ability (TESTS) can add the tooling</step10>
</workflow>
