# Auto decisions
Problems an AUTO run solved without asking, and how. Written by the orchestrator, one section per run, newest at the end.

## quick-12 — YYYY-MM-DD
- step-12 — problem: develop left task A3 (!) (no test hook for the timer) — applied: develop rerun with the (!) as feedback, still (!); implemented with (!) A3, review and finish gate decide (see Dev Log step-12) — revert: -
- step-12 — problem: review-fixing F2 needs a user decision (empty list shows nothing or a hint) — applied: hint, as AC 3 asks for user feedback on empty states (see review Fixes "(auto decision)") — revert: drop the hint in step-12's fix commit
- step-12 — problem: review-fixing F4 out of scope (slow query in another domain) — applied: follow-up, not done in this run — revert: -
- finish — problem: exit 5, untracked test-results/ — applied: ignore pattern in .gitignore, commit "step-12: ignore generated test-results/" — revert: drop the pattern
- finish — problem: gate fail lint — applied: gate fix round 1/2 — revert: -
- finish — problem: merge lock held by plan-3 for 10 min — applied: run ended (waited 10 × 60s) — revert: -

<rules>
    <rule>File: <specs>/<domain>/auto-decisions.md, versioned in the specs repo, committed with the run's next specs commit</rule>
    <rule>Section: "## <run> — <date>". A resumed run appends to its section</rule>
    <rule>Line: "- <where: step-<id> | phase-<id> | integrate | finish | cleanup> — problem: … — applied: … — revert: …". revert: how to undo it, "-" when obvious</rule>
    <rule>Details stay where the abilities write them (Spec Log, Dev Log, review Fixes "(auto decision)"): the line points to them</rule>
    <rule>Only AUTO runs write it. MANUAL asks the user instead</rule>
</rules>
