---
name: quick-dev
description: Fast proof-of-concept flow. Worktree, implement, preview locally or on test, iterate, distill the idea and learnings. Works standalone or via the nos orchestrator
---

<coreRules>
    <rule>Speed over rigor. No reviews, no specify, no TDD, no plan.json, no nos statuses</rule>
    <rule>All code changes only inside the worktree</rule>
    <rule>Read guardrails for="coding" in docs/guardrails.xml and docs/architecture.md if existent. Never block on them</rule>
    <rule>Commands come from specs/config.json by ../../templates/quality-tools.md: "project-commands" install, dev, deploy-test and "quality-tools" typecheck. Null → skip what needs it. Never invent a command</rule>
    <rule>Never change package.json scripts or deploy config. Use deploy-test as it is</rule>
    <rule>Keep a running log outside the worktree: each user change request, what changed, what was learned</rule>
    <rule>Run as a subagent → return every question and the final verdict to the caller and wait. Otherwise → ask the user directly</rule>
    <rule>Every question with choices: one choice per line, "<letter> - <choice text> [<key>]". The user answers with letter or key</rule>
</coreRules>

<input>idea. Optional: resume with worktree path</input>

<workflow>
    <step1>Understand the idea. Ask 1-2 questions only if it cannot be implemented otherwise. Generate a short slug → branch poc/<slug></step1>
    <step2>From the main repo root: git worktree add ../<repo>-worktrees/poc-<slug> -b poc/<slug> main. Copy untracked env files (.env*, *.local) into it. Run install in the worktree. .claude/ is gitignored → keep skill paths pointing to the main repo</step2>
    <step3>
        <question>How do you want to preview?
            <choice key="LOCAL" when="dev configured">Local dev server. You work on this machine</choice>
            <choice key="REMOTE" when="deploy-test configured">Deploy to test. You work remotely and need a public url</choice>
        </question>
        <do>Neither configured → no preview. Tell the user to check the worktree themselves</do>
    </step3>
    <step4>Implement the idea in the worktree. typecheck must pass when configured. Lint and tests optional. Commit with prefix "poc:"</step4>
    <step5>Preview
        <do when="LOCAL">Dev server not running → start dev in the worktree in the background. Report the local url. Hot reload picks up later changes, if the dev server supports it</do>
        <do when="REMOTE">Run deploy-test in the worktree. Report the url from its output</do>
    </step5>
    <step6>
        <question>What next?
            <choice key="CHANGE">Request a change</choice>
            <choice key="SWITCH" when="other mode configured">Switch to the other preview mode. Show only the mode not active</choice>
            <choice key="END">End the loop</choice>
        </question>
        <do when="CHANGE">Implement the change, typecheck, commit, log the request and learning → step5 → step6</do>
        <do when="SWITCH">Switch mode. Stop the dev server if leaving LOCAL → step5 → step6</do>
    </step6>
    <step7>Stop the dev server if running. Write one markdown doc outside the worktree (scratch dir): original idea, final shaped idea, what was tried, user feedback per iteration, learnings and decisions, key files and code changes (git diff main...poc/<slug> --stat), open questions</step7>
    <step8>Show the doc summary
        <question>What should happen with the idea?
            <choice key="SAVE">Save it via the idea ability</choice>
            <choice key="DROP">Drop it</choice>
        </question>
    </step8>
    <step9>Regardless of the choice: git worktree remove the worktree (--force if needed). Keep the branch poc/<slug></step9>
    <step10>Only after step9
        <do when="SAVE and subagent">Return verdict save and the doc path</do>
        <do when="SAVE and standalone">Run ability ../idea.md with the doc as starting context. Report the domain folder</do>
        <do when="DROP">Delete the doc. Report verdict drop</do>
    </step10>
</workflow>

<output>verdict (save|drop), doc path, branch name, last preview url</output>
