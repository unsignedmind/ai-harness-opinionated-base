---
name: chat
description: Open the local chat of the project (spec-ui chat button, desktop or phone). The chat answers with its own Claude Code sessions, one per chat tab. Use when the user asks to open the chat or to chat in the browser or on the phone.
---

<coreRules>
    <rule>Invocation: "nos" = the literal command "node <home>/cli/bin/nos.js …", typed out in full: never through a shell variable, function or alias (worktree isolation refuses computed command names). <home> = the given home, or the nos folder that holds this ability's abilities/ folder. Forward slashes, verbatim. Never rely on a linked "nos"</rule>
    <rule>The chat belongs to the project (its main checkout), never to the nos folder. Run it from main or a run's worktree: both resolve to the same chat. State: <specs>/.chat</rule>
    <rule>Default (runner): the chat server starts its own headless Claude Code session per chat tab ("claude -p", permission mode "auto", no permission prompts). This session does not listen and does not answer chat messages</rule>
    <rule>Relay ("chat": { "runner": false } in <specs>/config.json): this session answers instead → section relay</rule>
    <rule>Never write a Claude Code memory or a CLAUDE.md/AGENTS.md entry. A project lesson → put it in your report as a guardrail proposal (section, wording, reason)</rule>
</coreRules>

<workflow>
    <step1>Open: "nos chat open --no-open". It starts the server only when none with this nos code runs (a running one keeps its tabs). Tell the user: chat button in the spec-ui header (start it with "npm run dev" in <home>/ui), or the printed url. Its "next_step" says whether to listen: runner → the chat answers by itself, nothing to run; relay → section relay</step1>
    <step2>On the phone: the user starts the spec-ui with "npm run dev-to-lan" (HTTPS), accepts the certificate once (fingerprint printed in the terminal), and scans the one-time pairing QR code / link printed there (or "Pair a device" in the chat panel). The user allows the device on the PC when both show the same number. Never pair or approve devices for the user</step2>
    <step3>Tell the user: each tab ("+") is its own Claude Code session; "Stop" ends the current run; a tab's tooltip shows "claude --resume <id>" to continue it in a terminal</step3>
</workflow>

<relay>
    <rule>Runs in the main session, never in a subagent: only the main session can keep listening between turns</rule>
    <rule>Treat each chat message exactly as if the user had typed it in the terminal. Every report and question also goes to the chat with "nos chat reply". Choices keep the format "<letter> - <choice text> [<key>]"</rule>
    <rule>Never end your turn while the chat is open and no "nos chat await" is running</rule>
    <step1>Listen: run "nos chat await" as a background task (Bash with run_in_background). It exits when the user writes and prints JSON</step1>
    <step2>Read "items". A leading "[context: …]" line names the spec file the user is looking at</step2>
    <step3>Work longer than a minute → "nos chat typing --state thinking" about once a minute</step3>
    <step4>Answer with a quoted heredoc, so quotes, backticks and dollar signs stay intact:
        nos chat reply <<'EOF'
        your answer
        EOF
    </step4>
    <step5>Start "nos chat await" in the background again at once → step2. Stop when await returns "status": "ended" or "sessionEnded": true</step5>
</relay>

<limits>
    <limit>Runner: nobody can answer permission prompts. Auto mode decides; what it refuses is refused. Allow more in .claude/settings.local.json of the project if needed (absolute paths, never settings.json)</limit>
    <limit>Runner: anyone holding a paired device can make Claude Code act in the project with auto mode. Lost device → "nos chat devices --revoke <id>" or Devices in the chat panel</limit>
    <limit>No streaming: a reply appears whole; the chat shows the current tool call meanwhile</limit>
</limits>
