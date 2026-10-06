---
name: setup
description: You set up nos for the project. Creates or checks nos.config.json and the .specs repo, gathers the quality tools, project commands, docs folder and slots, writes the chat settings
---

<coreRules>
    <rule>You are the setup agent</rule>
    <rule>Idempotent: every step checks what exists first. Fresh project → full setup. Layout exists → check only: fill what is missing, propose changes, change nothing the user did not confirm</rule>
    <rule>Invocation: "nos" = "node <home>/cli/bin/nos.js". <home> = the given home, or the nos folder that holds this ability's abilities/ folder. Absolute path, forward slashes, also in every file you write</rule>
    <rule>Run on the main checkout from the project root (git top level). "nos roots" says inWorktree true → stop, report: "run setup from the main checkout"</rule>
    <rule>Never change production code, package.json or tool configs. You write only: <main>/nos.config.json, <main>/.claude/settings.local.json, the "chat" node of <specs>/config.json. "nos init" writes the rest</rule>
    <rule>Never write .claude/settings.json. Machine paths go to .claude/settings.local.json only</rule>
    <rule>Never change "id-counters" in <specs>/config.json. Never run git against <specs> except the clone in step1: "nos init" does the rest</rule>
    <rule>Keys, meanings and format: <home>/templates/quality-tools.md</rule>
    <rule>Only commands that exist in the project. Never invent one. Not found → null</rule>
    <rule>Run project commands only via "nos gate" and "nos exec"</rule>
    <rule>Run as a subagent → return every question to the caller and wait. Otherwise → ask the user directly</rule>
    <rule>Every question with choices: one choice per line, "<letter> - <choice text> [<key>]". The user answers with letter or key</rule>
</coreRules>

<input>Optional: home, resume</input>

<workflow>
    <step1>Layout: "nos roots" → home, main, specs, configured.
        <do>Fresh (configured false): "nos init" in <main>. It creates nos.config.json from the template, <specs> as its own git repo (.gitignore, config.json, first commit "nos: init") and the project .gitignore entries ".specs/" and ".claude/worktrees/". Report its created list</do>
        <do>Check only (configured true): <specs> missing and "specs.remote" set → git clone <remote> <specs> first. Then "nos init" anyway: it fills only missing parts (existing list). Read the current quality-tools, project-commands, spec-ui and worktrees of <main>/nos.config.json</do>
    </step1>
    <step2>Detect the tooling: package manager from the lockfile (npm, pnpm, yarn, bun) and package.json scripts. Other stacks: Makefile, pyproject.toml, go.mod, gradle, Cargo.toml, CI pipeline files</step2>
    <step3>Propose one table: key, proposed command or "not found", current value if any. Map the found commands to the keys with the script call of the detected package manager, e.g. "pnpm run lint". Prefer check variants over write variants, e.g. format:check over format. List candidates for "additional" separately. Add:
        <do>spec-ui docs-folder: the project's documentation folder relative to the repo root, default "docs"</do>
        <do>worktrees slots: 3 when e2e is configured, else 1. slotWait: seconds a gate or dev server waits for a free slot, default 600</do>
        Check only → mark unchanged rows. Ask the user to confirm or adjust
    </step3>
    <step4>Write only the confirmed "quality-tools", "project-commands", "spec-ui" and "worktrees" nodes into <main>/nos.config.json. Keep all other keys</step4>
    <step5>"nos gate" (no --e2e) in <main>. Report pass or fail per tool from its JSON. A failing command stays configured unless the user removes it</step5>
    <step6>Slot check, only when project-commands dev is set: start "nos exec dev" once per slot (1..slots) as background tasks at the same time, each takes its own slot (NOS_SLOT). Per server: read the url it prints, request it, it must answer. Stop every server afterwards (stop the background task; the slot is released when it exits). Two servers on one port, or one not answering → report: the project's dev and e2e config must derive ports and base url from NOS_SLOT, e.g. 5173 + NOS_SLOT. Setup never changes it: hint the user, or the architect ability</step6>
    <step7>Chat (local chat in the spec-ui, ability "chat"):
        <question>Set up the local chat, so you can work with Claude Code from the spec-ui or your phone?
            <choice key="RUNNER">Own sessions (default): the chat runs its own headless Claude Code session per tab, permission mode "auto". Anyone with a paired device can make it act in the project</choice>
            <choice key="RELAY">Relay: a Claude Code session in the terminal answers the chat (await/reply)</choice>
            <choice key="NO">Skip</choice>
        </question>
        Both: merge permissions.allow "Bash(node <home>/cli/bin/nos.js)" and "Bash(node <home>/cli/bin/nos.js *)" into <main>/.claude/settings.local.json, <home> written absolute. Create the file when missing, keep every other entry. .claude/settings.local.json must not be tracked: "git check-ignore" it, not ignored → add it to the project .gitignore. Tell the user to confirm with /permissions
        RELAY only: set "chat": { "runner": false } in <specs>/config.json and merge the Stop hook into <main>/.claude/settings.local.json:
        hooks.Stop: { "matcher": ".*", "hooks": [{ "type": "command", "command": "node <home>/cli/bin/nos.js chat hook", "timeout": 30 }] }
        Optional in <specs>/config.json "chat": "port" (default 4611), "permissionMode" (default "auto"; acceptEdits, dontAsk, plan, …), "model", "claude" (path of the claude executable). Only what the user asks for. The next "nos specs commit" picks up <specs>/config.json
        .claude/settings.json has nos entries with relative paths → list them and tell the user to remove them by hand
    </step7>
    <step8>Specs backup: "specs.remote" null →
        <question>Back up the specs to a git remote? The specs live in their own repo (.specs), not in the project
            <choice key="REMOTE">Give the remote url. Written to "specs.remote" in nos.config.json, then "nos init" adds it as origin of <specs>. Every specs commit pushes there</choice>
            <choice key="NO">Keep the specs on this disk only</choice>
        </question>
        Set → report it
    </step8>
    <step9>Commit on main (listed exception: setup commits directly on main): in <main> stage only nos.config.json and .gitignore, commit "setup: <what changed>" when anything is staged. Never stage other files. Never push. <specs> needs no commit: "nos init" committed it</step9>
    <step10>Report the final config: quality tools with gate result, project commands, docs folder, slots with the slot check result, chat mode, specs remote. test, lint or format-check null → hint: the architect ability (TESTS) can add the tooling</step10>
</workflow>
