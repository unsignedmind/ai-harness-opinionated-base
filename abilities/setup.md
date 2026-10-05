---
name: setup
description: You set up nos for the project. Creates the specs folder and config.json, gathers the quality tools, project commands and the docs folder
---

<coreRules>
    <rule>You are the setup agent</rule>
    <rule>Never change production code, package.json or tool configs. You only write specs/config.json, and .claude/settings.json for the chat (step7)</rule>
    <rule>Never change "id-counters" in specs/config.json</rule>
    <rule>Keys, meanings and format: ../templates/quality-tools.md</rule>
    <rule>Only commands that exist in the project. Never invent one. Not found → null</rule>
    <rule>Run as a subagent → return every question to the caller and wait. Otherwise → ask the user directly</rule>
    <rule>Every question with choices: one choice per line, "<letter> - <choice text> [<key>]". The user answers with letter or key</rule>
</coreRules>

<input>Optional: resume</input>

<workflow>
    <step1>Run "nos init" from the project root. Creates specs/ and specs/config.json when missing. Existing config → read its current quality-tools, project-commands and spec-ui</step1>
    <step2>Detect the tooling: package manager from the lockfile (npm, pnpm, yarn, bun) and package.json scripts. Other stacks: Makefile, pyproject.toml, go.mod, gradle, Cargo.toml, CI pipeline files</step2>
    <step3>Map the found commands to the keys. Use the script call of the detected package manager, e.g. "pnpm run lint". Prefer check variants over write variants, e.g. format:check over format. Collect further checks as candidates for "additional"</step3>
    <step4>Propose one table: key, proposed command or "not found", current value if any. List the candidates for "additional" separately. Add the docs folder for the spec UI ("spec-ui" → "docs-folder"): the project's documentation folder relative to the repo root, default "docs". Ask the user to confirm or adjust</step4>
    <step5>Run each confirmed quality-tools command once, except e2e. Report pass or fail per command. A failing command stays configured unless the user removes it</step5>
    <step6>Write only the "quality-tools", "project-commands" and "spec-ui" nodes into specs/config.json. Keep all other keys unchanged</step6>
    <step7>Chat (local chat in the spec-ui, ability "chat"):
        <question>Set up the local chat, so you can work with Claude Code from the spec-ui or your phone?
            <choice key="RUNNER">Own sessions (default): the chat runs its own headless Claude Code session per tab, permission mode "auto". Anyone with a paired device can make it act in the project</choice>
            <choice key="RELAY">Relay: a Claude Code session in the terminal answers the chat (await/reply)</choice>
            <choice key="NO">Skip</choice>
        </question>
        Both: merge permissions.allow "Bash(nos chat)", "Bash(nos chat *)", "Bash(node .claude/skills/nos/cli/bin/nos.js chat *)" into .claude/settings.json. Keep every other entry. Tell the user to confirm with /permissions
        RELAY only: set "chat": { "runner": false } in specs/config.json and merge the Stop hook into .claude/settings.json:
        hooks.Stop: { "matcher": ".*", "hooks": [{ "type": "command", "command": "node .claude/skills/nos/cli/bin/nos.js chat hook", "timeout": 30 }] }
        Optional in specs/config.json "chat": "port" (default 4611), "permissionMode" (default "auto"; acceptEdits, dontAsk, plan, …), "model", "claude" (path of the claude executable). Only what the user asks for
    </step7>
    <step8>Commit specs/config.json (and .claude/settings.json when changed) with prefix "setup". Push if an origin exists</step8>
    <step9>Report the final config. test, lint or format-check null → hint: the architect ability (TESTS) can add the tooling</step9>
</workflow>
