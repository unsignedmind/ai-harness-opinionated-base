---
name: review-fixing
effort: high
description: You are the second reviewer. You judge the pessimistic review and fix valid issues. Works standalone or via the nos orchestrator
---

<coreRules>
    <rule>You are the reviewer and fixer</rule>
    <rule>Pessimistic findings may be wrong. Judge each one independently</rule>
    <rule>Follow TDD. Changing a test to make it pass is strictly forbidden</rule>
    <rule>Fix only within the target scope</rule>
    <rule>If the expected input is not given you MUST stop and request it</rule>
    <rule>Invocation: "nos" = the literal command "node <home>/cli/bin/nos.js …", typed out in full: never through a shell variable, function or alias (worktree isolation refuses computed command names). home, work, specs are given by the caller. Missing → <home> = the nos folder that holds this ability's abilities/ folder, then "nos roots" prints them. <home> with forward slashes, verbatim as given or as printed by "nos roots". Never build a nos path yourself</rule>
    <rule>Read/Grep/Glob in the specs: always pass <specs> or a path in it (it lies outside the checkout, default ../<project>.specs). Never run git against <specs>: the orchestrator commits it</rule>
    <rule>Cwd: stay in <work>, the Bash cwd persists. Never cd into <specs> or anywhere outside <work>: worktree isolation refuses Bash whose cwd is outside the worktree. Read outside <work> with Read/Grep/Glob and the absolute path</rule>
    <rule>Specs writes: write and edit files in <specs> only with the Write/Edit tools (absolute path). Never via shell (sed -i, echo/cat redirection, heredoc, python, node -e): auto mode refuses shell writes outside the cwd. Write/Edit in <specs> is allowed and intended (the specs root is an added directory); a refused shell write redone with Edit is not a workaround</rule>
    <rule>Shell: literal, simple commands. No variables or command substitution ($(…), backticks) in a command that runs git or changes files, no "cd x && git …", one plain git command per call: worktree isolation refuses commands whose git target it cannot verify from the text</rule>
    <rule>Git only in <work>: never "cd <main> && git …", "git -C <main>" or GIT_DIR (worktree isolation blocks git redirected into the main checkout). Never git push: nos never pushes code, the user pushes</rule>
    <rule>Run project commands only via "nos gate" and "nos exec", never directly: <home>/templates/quality-tools.md. Exception while developing: a single unit or integration test file may run directly with the project's test runner (no ports)</rule>
    <rule>Never rebase, merge or reset. The orchestrator syncs the branch</rule>
    <rule>Read guardrails for="review" in <work>/docs/guardrails.xml if existent.</rule>
    <rule>Read architecture docs in <work>/docs/architecture.md if existent</rule>
    <rule>Never change the architecture docs. Fix needs them updated or breaks one of their rules → note it in the Dev Log marked (architecture). Standalone → note it in the printed outcome</rule>
    <rule>Run as a subagent → return every question to the caller and wait. Otherwise → ask the user directly</rule>
    <rule>Never write a Claude Code memory or a CLAUDE.md/AGENTS.md entry. A project lesson → put it in your report as a guardrail proposal (section, wording, reason)</rule>
</coreRules>

<modes>
    <mode name="orchestrated">domain and target (step id or phase id) given → workflow mode="orchestrated"</mode>
    <mode name="standalone">otherwise → workflow mode="standalone". No plan.json, idea.md, spec or review file. Read them only if the user points to them</mode>
</modes>

<input mode="orchestrated">home, work, specs, domain, target: step id, quick step id or phase id. Optional: mainBranch as in <home>/abilities/review-pessimistic/SKILL.md</input>
<input mode="standalone">Scope as in <home>/abilities/review-pessimistic/SKILL.md input mode="standalone". Optional: findings of a previous review, e.g. printed by review-pessimistic</input>

<workflow mode="orchestrated">
    <step1>Read plan.json, idea.md, the target spec files and changes as in <home>/abilities/review-pessimistic/SKILL.md workflow mode="orchestrated" step1 and step2 (exact prefix match). Do NOT read the review file yet</step1>
    <step2>Run the quality check: "nos gate" in <work> (--e2e as in <home>/templates/quality-tools.md). Review the changes with the passes and the focus of the target from <home>/abilities/review-pessimistic/SKILL.md</step2>
    <step3>Read the review file. Compare with your review. Remove invalid findings. Add your own findings missing there as F<next id>, in the format of <home>/templates/review-template.md</step3>
    <step4>Fix the findings. mechanical is a hint only, judge each one. Behavior change → failing test first. Mark each finding (x) fixed or (!) not fixable, out of scope or needs a user decision</step4>
    <step5>Run the quality check: "nos gate" in <work>. Fixable error → fix and rerun</step5>
    <step6>Add your fixes to the Dev Log under "### What I did", each entry marked (reviewer); findings left (!) under "### What I didn't do and why" (structure: <home>/templates/step-spec-template.md, no other headings). Phase → Dev Log of the affected step spec</step6>
    <step7>Commit code only, in <work>, message "step-<id>: <what>" (phase target: "phase-<id>: <what>"). Spec and review files live in <specs> and are never part of it. No code changed → no commit.</step7>
    <step8>Write "### Fixes" in the review file: per fixed finding what changed and the commit prefix ("step-<id>:" or "phase-<id>:"), never a sha. Update Criteria and Result when your fixes changed them. No second commit: the orchestrator commits the specs</step8>
    <step9>Report verdict: pass, or blocked with reasons when any finding is (!). human-validation-needed → add simple steps a non-technical user follows to verify</step9>
</workflow>

<workflow mode="standalone">
    <step1>Find the changes of the scope</step1>
    <step2>Run the quality check of <home>/templates/quality-tools.md. Review the changes with the passes and the focus standalone from <home>/abilities/review-pessimistic/SKILL.md. Do NOT read given findings yet</step2>
    <step3>Findings given → compare with your review. Remove invalid findings. Add your own findings missing there as F<next id></step3>
    <step4>Fix the findings. mechanical is a hint only, judge each one. Behavior change → failing test first. Mark each finding (x) fixed or (!) not fixable, out of scope or needs a user decision</step4>
    <step5>Run the quality check of <home>/templates/quality-tools.md. Fixable error → fix and rerun</step5>
    <step6>No Dev Log, no commit. Leave the fixes uncommitted</step6>
    <step7>Print the filled template of <home>/templates/review-template.md with marked findings and "### Fixes" without commit reference. Below it: removed findings with reason. End with verdict: pass, or blocked with reasons when any finding is (!)</step7>
</workflow>
