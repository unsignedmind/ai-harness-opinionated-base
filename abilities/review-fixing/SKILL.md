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
    <rule>Read guardrails for="review" in docs/guardrails.xml if existent.</rule>
    <rule>Read architecture docs in docs/architecture.md if existent</rule>
    <rule>Never change the architecture docs. Fix needs them updated or breaks one of their rules → note it in the Dev Log marked (architecture). Standalone → note it in the printed outcome</rule>
    <rule>Run as a subagent → return every question to the caller and wait. Otherwise → ask the user directly</rule>
</coreRules>

<modes>
    <mode name="orchestrated">domain and target (step id or phase id) given → workflow mode="orchestrated"</mode>
    <mode name="standalone">otherwise → workflow mode="standalone". No plan.json, idea.md, spec or review file. Read them only if the user points to them</mode>
</modes>

<input mode="orchestrated">domain, target: step id or phase id</input>
<input mode="standalone">Scope as in ../review-pessimistic/SKILL.md input mode="standalone". Optional: findings of a previous review, e.g. printed by review-pessimistic</input>

<workflow mode="orchestrated">
    <step1>Read plan.json, idea.md, the target spec files and changes as in ../review-pessimistic/SKILL.md workflow mode="orchestrated" step1 and step2. Do NOT read the review file yet</step1>
    <step2>Run the full test suite, linter and formatter check. Review the changes with the passes and the focus of the target from ../review-pessimistic/SKILL.md</step2>
    <step3>Read the review file. Compare with your review. Remove invalid findings. Add your own findings missing there as F<next id>, in the format of ../../templates/review-template.md</step3>
    <step4>Fix the findings. mechanical is a hint only, judge each one. Behavior change → failing test first. Mark each finding (x) fixed or (!) not fixable, out of scope or needs a user decision</step4>
    <step5>Run the full test suite, linter and formatter check. Fixable error → fix and rerun</step5>
    <step6>Add your fixes to the Dev Log, each entry marked (reviewer). Phase → Dev Log of the affected step spec</step6>
    <step7>Commit with prefix step-<id> or phase-<id></step7>
    <step8>Write "### Fixes" in the review file: per fixed finding what changed and the commit sha. Update Criteria and Result when your fixes changed them. Commit with the same prefix. Push if an origin exists</step8>
    <step9>Report verdict: pass, or blocked with reasons when any finding is (!). human-validation-needed → add simple steps a non-technical user follows to verify</step9>
</workflow>

<workflow mode="standalone">
    <step1>Find the changes of the scope</step1>
    <step2>Run the full test suite, linter and formatter check. Review the changes with the passes and the focus standalone from ../review-pessimistic/SKILL.md. Do NOT read given findings yet</step2>
    <step3>Findings given → compare with your review. Remove invalid findings. Add your own findings missing there as F<next id></step3>
    <step4>Fix the findings. mechanical is a hint only, judge each one. Behavior change → failing test first. Mark each finding (x) fixed or (!) not fixable, out of scope or needs a user decision</step4>
    <step5>Run the full test suite, linter and formatter check. Fixable error → fix and rerun</step5>
    <step6>No Dev Log, no commit. Leave the fixes uncommitted</step6>
    <step7>Print the filled template of ../../templates/review-template.md with marked findings and "### Fixes" without sha. Below it: removed findings with reason. End with verdict: pass, or blocked with reasons when any finding is (!)</step7>
</workflow>
