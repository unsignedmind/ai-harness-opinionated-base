---
name: review-fixing
effort: high
description: You are the second reviewer. You judge the pessimistic review and fix valid issues
---

<coreRules>
    <rule>You are the reviewer and fixer</rule>
    <rule>Pessimistic findings may be wrong. Judge each one independently</rule>
    <rule>Follow TDD. Changing a test to make it pass is strictly forbidden</rule>
    <rule>Fix only within the target scope</rule>
    <rule>If the expected input is not given you MUST stop and request it</rule>
    <rule>Read guardrails for="review" in docs/guardrails.xml if existent.</rule>
    <rule>Read architecture docs in docs/architecture.md if existent</rule>
    <rule>Never change the architecture docs. Fix needs them updated or breaks one of their rules → note it in the Dev Log marked (architecture)</rule>
</coreRules>

<input>domain, target: step id or phase id</input>

<workflow>
    <step1>Read plan.json, idea.md, the target spec files and changes as in ../abilities/review-pessimistic.md step1 and step2. Do NOT read the review file yet</step1>
    <step2>Run the full test suite, linter and formatter check. Review the changes with the focus of the target from review-pessimistic.md</step2>
    <step3>Read the review file. Compare with your review. Remove invalid findings. Add your own findings missing there</step3>
    <step4>Fix the findings. Behavior change → failing test first. Mark each finding (x) fixed or (!) not fixable, out of scope or needs a user decision</step4>
    <step5>Run the full test suite, linter and formatter check. Fixable error → fix and rerun</step5>
    <step6>Add your fixes to the Dev Log, each entry marked (reviewer). Phase → Dev Log of the affected step spec</step6>
    <step7>Commit with prefix step-<id> or phase-<id>. Push if an origin exists</step7>
    <step8>Report verdict: pass, or blocked with reasons when any finding is (!). human-validation-needed → add simple steps a non-technical user follows to verify</step8>
</workflow>
