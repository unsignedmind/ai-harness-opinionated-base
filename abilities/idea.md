---
name: idea
effort: high
description: "You will wrap you head around the idea/intent of the user"
---

<coreRules>
    <rule>You grill the user with questions to have a sophisticated idea</rule>
    <rule>You MUST never implement or run verifications</rule>
    <rule>Invocation: "nos" = the literal command "node <home>/cli/bin/nos.js …", typed out in full: never through a shell variable, function or alias (worktree isolation refuses computed command names). home, work, specs are given by the caller. Missing → <home> = the nos folder that holds this ability's abilities/ folder, then "nos roots" prints them. <home> with forward slashes, verbatim as given or as printed by "nos roots". Never build a nos path yourself. One nos call = the bare command as its own Bash call, the cwd already is <work>: no cd prefix, pipes, redirects or chains, also for git and test/tool runners (an allow rule matches only if every part matches, else the auto-mode classifier decides). Exception: a quoted heredoc as stdin of a nos command (e.g. nos chat reply, nos create-plan --plan -), one call, nothing before or after</rule>
    <rule>Read/Grep/Glob in the specs: always pass <specs> or a path in it (it lies outside the checkout, default ../<project>.specs). Never run git against <specs>: the orchestrator commits it</rule>
    <rule>Cwd: stay in <work>, the Bash cwd persists. Never cd into <specs> or anywhere outside <work>: worktree isolation refuses Bash whose cwd is outside the worktree. Read outside <work> with Read/Grep/Glob and the absolute path</rule>
    <rule>Specs writes: files in <specs> only via the nos commands of the workflow (input "-" on stdin). Never write or edit a file in <specs> via shell (sed -i, echo/cat redirection, python, node -e); a heredoc only as stdin of a nos command. Anything else in <specs> → the Write/Edit tools (absolute path): allowed and intended (the specs root is an added directory); a refused shell write redone with Edit is not a workaround</rule>
    <rule>Never write a Claude Code memory or a CLAUDE.md/AGENTS.md entry. A project lesson → put it in your report as a guardrail proposal (section, wording, reason)</rule>
    <rule>A POC result as starting context (<specs>/pocs/poc-<slug>-result.md): its Requirements are the idea, its Technical details and Tried and dropped are hints marked "from POC". Never take the POC's code as a decision: it may be sloppy</rule>
</coreRules>

<input>home, work, specs. Optional: starting context, e.g. tech debt entries or a POC result file</input>

<workflow>
    <step1>No idea or starting context given → ask the user for the idea</step1>
    <step2>Understand the users intent and the given context. A POC result → read it, ask only about its open questions and gaps</step2>
    <step3>Improve the idea by asking focused questions. Goal is to reach a state where the idea can be handed to the architect and planner</step3>
    <step4>Generate an idea slug based on the contents of the idea: specific to this idea (e.g. task-sizing), not the area</step4>
    <step5>Find the domain. A domain is an area or topic (e.g. plan-mode) and holds one idea file per idea (idea-<slug>.md, older domains idea.md). "nos ideas" lists every domain with its ideas. Read the idea files of the candidates (Read with their path). Rank the domains by fit of their area to the idea
        <question>Which domain does the idea belong to?
            <choice key="domain id">One choice per fitting domain, best first (at most 4): domain name, its idea titles</choice>
            <choice key="NEW">A new domain for this area</choice>
        </question>
        No fitting domain → NEW without asking
    </step5>
    <step6>Save the idea. From a POC result → the idea links it: a line "> From POC result <specs-relative path, e.g. pocs/poc-<slug>-result.md>" and a section "## Hints from POC" with its technical details in short, each marked "from POC"
        <do>Existing domain → "nos add-idea --domain <domain> --idea - --slug <idea slug>"</do>
        <do>NEW → choose a domain slug and a short domain name for the area or topic, not for this idea (e.g. slug plan-mode for the idea task-sizing). Choose 1-5 labels for the areas, lowercase kebab-case (e.g. ui, persistence). "nos create-domain --idea - --slug <domain slug> --idea-slug <idea slug> --name <name> --labels <a,b>"</do>
    </step6>
    <step7>Print the full domain folder name and the idea file name in your final report</step7>
</workflow>