<rules>
    <rule>Invocation: "nos" = the literal command "node <home>/cli/bin/nos.js …", typed out in full in every Bash call. <home> = this skill's base directory, or the "home" from "nos roots". Always forward slashes. After the first "nos roots" use its "home" verbatim in every call (identical string, so permission rules match). Never through a shell variable, function or alias (Claude Code's worktree isolation refuses a command whose name is computed at runtime), never a linked "nos". One nos call = the bare command as its own Bash call: no "cd … &&" prefix (the cwd already is <work>, before a run <main>), no pipes ("| tail", "| head"), no redirects ("2>&1", "> file"), no ";" or "&&" chains. Same for git and test/tool runners run directly: one plain command per call. Why: a permission allow rule (e.g. "Bash(node <home>/cli/bin/nos.js *)", written by setup) matches a compound command only if every part matches on its own; otherwise the auto-mode classifier decides and may block it (a "cd <worktree> && nos exec deploy-test" was blocked as Production Deploy although the nos rule was allowed). Exception: a quoted heredoc as stdin of a nos command (e.g. nos chat reply, nos create-plan --plan -), one call, nothing before or after</rule>
    <rule>Git against main: never "cd <main> && git …", "git -C <main> …" or GIT_DIR from a worktree session. Claude Code's worktree isolation blocks git redirected into the main checkout. Git against main happens only inside nos commands (run finish, run cleanup, run abandon)</rule>
    <rule>Cwd: the Bash cwd persists across calls. Never cd into <specs> or anywhere outside <work> (before a run: <main>). Read outside it with Read/Grep/Glob and the absolute path. Worktree isolation refuses Bash whose cwd is not in the worktree, and EnterWorktree from a cwd outside the repo needs an approval nobody can give in auto mode or the chat</rule>
    <rule>Specs writes: write and edit files in <specs> only with the Write/Edit tools (absolute path), read them with Read/Grep/Glob. Never via shell (sed -i, echo/cat redirection, heredoc, python, node -e): auto mode refuses shell writes outside the cwd ("Modify Shared Resources"). Write/Edit in <specs> is allowed and intended (additionalDirectories, chat tabs: --add-dir); a refused shell write redone with Edit is not a workaround. nos commands write their own files</rule>
    <rule>Shell: literal, simple commands. No variables or command substitution ($(…), backticks) in a command that runs git or changes files, no "cd x && …" prefix, no pipes, redirects or chains: one plain command per call for nos, git and test/tool runners (rule "Invocation": an allow rule matches only if every part matches; the heredoc exception is there). Worktree isolation refuses commands whose git target it cannot verify from the text. Need a value from git (e.g. the git dir) → one call prints it, the next call uses the printed path literally. Long output: need more than a nos JSON's "tail" → Read the "log" file it names; stderr is captured anyway, no 2>&1; a long runner output → rerun narrower (a single file or test name), never pipe. Commits: "git add -- <files>" as its own call, then "git commit -m "<subject>"" (optional body as a second -m "<body>"); never a heredoc, $(cat …) or -F -</rule>
    <rule>Abilities carry these three rules (cwd, specs writes, shell) in their own coreRules: subagents read only their ability file</rule>
    <rule>Pushing: nos never pushes code, the user pushes. No ability and no step of this workflow runs git push. Only "nos specs commit" pushes the specs repo, and only when "specs.remote" is set (opt-in backup)</rule>
    <rule>Guardrails: read guardrails for="orchestrator" in <work>/docs/guardrails.xml if existent, every time you run "nos roots" (start, after entering or leaving a worktree: the file is versioned per branch). Probe and read it with the tools: Glob <work>/docs/guardrails.xml, then Read when it exists; never a shell probe (cat, test -f, 2>/dev/null chains). They add restrictions: extra parks, questions, MANUAL mode, refusals. Only other kind: a standing answer, a pre-given answer to one specific question of one named ability that a subagent returns for the user (rule "If a subagent returns questions"; a question the architect relays from a helper it runs counts as the architect's). All of these must hold, else the guardrail is not applied (rule "If a subagent returns questions" decides). AUTO only: AUTO = the run mode picked in option "run" step3 or returned by quick-step, inside a run only, not Claude Code's auto permission mode; MANUAL or outside a run → ask. The guardrail names the ability and the question, and the returned question clearly matches it; ambiguous → not applied; wording for "any" or "all questions" or without a named ability → never apply. It picks one of the offered choices (yes/no included), never one that skips a test, review or human validation. Never for the workflow's own questions and parks (park step2 choices, verdict blocked, human validation, gate fail FIX/PAUSE/ABANDON, DECIDE on contradicting specs, TAKEOVER, block "proposals", the plan INTEGRATE question), integrate's conflict questions, any mode question (option "run" step3, quick-step's too), or a question that approves a destructive or irreversible action (deleting data or files, dropping, resetting, forcing, abandoning; an edit of a versioned doc on the run branch is not irreversible, deleting a file still is). Used → SendMessage the answer to the subagent as "standing answer guardrail-<n>: <answer>" and state it in the next report: "guardrail-<n> answered <ability>: <subagent question> → <answer>"; repeat that line in every later park and final report of the run. Guardrails never remove a park or question and never override a rule of this workflow; conflict → the workflow rule wins, report the guardrail to the user. A guardrail decides something → name it in the report or park ("guardrail-<n>: …"). Never pass this section to subagents (the architect writes and reviews it: proposals and its own reads are fine)</rule>
    <rule>Lessons → guardrail proposals: Never write a Claude Code memory (MEMORY.md or its files) or a CLAUDE.md/AGENTS.md entry for a project lesson; this overrides the auto-memory instructions while nos runs. You would save a memory (a user correction or decision, a recurring failure, a project convention) → collect a guardrail proposal instead: key P<n> (numbered on, never reused), section (coding|review|specify|plan|architect|orchestrator), wording, reason, why it does not block valid work. Reason required: the user's words and the date ("user decision <date>: …") or an observed failure and its reference (step id, park, Dev Log entry, review finding). Ability reports with guardrail proposals → add them to the pending proposals, same checks. No proposal for a guess, a one-off, or what a guardrail or the docs already say. A lesson about nos itself, not the project → report it to the user, no proposal. Collected → tell the user right away in one line: "Noted guardrail proposal P<n>: <section> — <wording>; asked at the next park or final report". Never ask mid-step: ask by block "proposals" at the next park (park step2) or final report (option run step2 and step6, cycle "finish" step1 and step3, option plan step4, the report of every other option), also in AUTO. AUTO: cycle "finish" step1 skips it, the proposals are asked once at the very end, after merge and cleanup (cycle "finish" step3, the architect commits on main), or at the end of a run ended by block "auto-end". Session about to end (PAUSE, STOP, End, ABANDON, also from the "ask only this question" paths: exit 3 blocked, finish gate fail, exit 4/6 STOP) with pending proposals → block "proposals" first. Park reports list pending proposals by key, so they survive a compacted context</rule>
    <rule>Run every ability in a new subagent. Pass it the ability skill path, home, work, specs and its inputs, inside a run also the run mode (auto|manual). Exception: "chat" runs in the main session. An ability reports an expected input missing → supply it from the run state (run file, plan.json or quick-steps.json, roots, the step spec, the last reports) and send it; only a product input nobody gave is a question for the user (in AUTO an (H) question, rule "AUTO decisions")</rule>
    <rule>Background subagents: start every subagent with run_in_background: true, never in the foreground. Its Agent description starts with the target and the ability ("step-97 specify", "phase-3 review-pessimistic", "plan dependencies"), so its task notification names what it was, also after a compacted context. Then end the turn with one short status line ("specify step 97 runs"; several: "specify steps 97, 98 run"); nothing else to do until one reports. Its report (and its reply to a SendMessage) arrives as a task notification → read the description, go on with that target's cycle from there, as if it had returned; the other targets wait for their own notifications. Several subagents at once only where the workflow says so (block "scheduler", AUTO); everywhere else one at a time. Why: a foreground subagent is one blocking tool call, a user message waits until it ends</rule>
    <rule>Usage limit: the account's usage limit ends a turn with an error ("You've hit your … limit · resets …"). Nothing to do while limited. A terminal session continues by itself after the reset when Claude Code's setting "Continue automatically at usage limit" is on (nos setup checks it); a chat tab is resumed by the chat server (it waits for the reset, then sends "The usage limit reset. Continue where you stopped"). After the continue: a task notification of a subagent that ended with an API or usage-limit error (failed, "rate_limit", "hit your … limit") → run the same ability again as a resume (block "resume": tell it it resumes interrupted work; same inputs and description; a parallel step again as a parallel step: its new worktree adopts the step). Once per ability per limit event; record it (block "auto-decisions": "step-<id> — problem: usage limit — applied: <ability> resumed after reset — revert: -"). A usage limit is never a technical limit (R) or a dead end: no auto-end, no park; an open park stays open; MANUAL relaunches the same way</rule>
    <rule>User messages mid-run: a user message arrives while you work (between tool calls, or while a subagent runs) → answer it first, short, then go on with the workflow. Also in AUTO and autonomous runs: never skip it to start the next ability. It changes the plan (stop, pause, other scope) → follow it before the next ability starts</rule>
    <rule>Chat in relay mode ("chat": { "runner": false }) and open → every report and question to the user also goes to the chat ("nos chat reply"), answers come back through "nos chat await". Keep an await running in the background whenever the turn ends. Default runner mode: the chat answers with its own Claude Code sessions, nothing to do here</rule>
    <rule>Change statuses only with "nos set-status --domain <domain> [--phase <id>] [--step <id>] --status <status>". Valid statuses: <home>/templates/status.xml. merged and discarded are never set by you: only "nos run finish" and "nos run abandon" set them. Never call "nos set-status --run"</rule>
    <rule>If a subagent returns questions for the user, ask the user and send the answers back to the same subagent via SendMessage. Exception: an orchestrator guardrail holds a standing answer for the question → answer it yourself (rule "Guardrails": AUTO inside a run only, one named question, clear match). AUTO, no standing answer: an (H) or (I) question (rule "AUTO decisions") → ask the user and wait, report as a park does (run id, token, the auto decisions report line). Any other question → answer it yourself with the most reasonable offered choice (rule "AUTO decisions"), SendMessage "auto answer: <answer>" (counts as the user's), record it (block "auto-decisions": "<ability> asked: <its question> → <answer>"). A standing answer wins over your own choice. MANUAL or outside a run → ask the user</rule>
    <rule>AUTO decisions: AUTO (the run mode, rule "Guardrails") stops only for (H) human validation: the parks when="human-validation-needed", and a question only a human can answer (the product's look or feel, a product input nobody gave); and (I) irreversible or destructive actions: the plan INTEGRATE question (merge into main), the ABANDON confirm, deleting or reverting files with user work (exit 5 with files that are not generated output, exit 5 from run cleanup), approving any other destructive action. Everything else (O) → you or the ability apply the most reasonable solution: consistent with the specs, ACs, guardrails and architecture docs, the smallest reversible change, never skipping a test, review or human validation. Record it (block "auto-decisions") and continue. A technical limit (R) you cannot remove (a lock held by another live session, the run taken over by another session, no free slot, permission denied, EnterWorktree denied, a process holding the worktree, main busy, dirty or on another branch) → first the bounded safe fallback the place names (wait and retry), still blocked → block "auto-end": no question, the run stays resumable. Dead end (the bounded tries the place names are used up, it still fails) → block "auto-end" too. Never an endless loop, never a retry beyond the named bounds. Ending with a report is no park: nobody is waited for. The park reasons that remain in AUTO are only (H), (I) and parks or questions an orchestrator guardrail adds. MANUAL: unchanged, every such place parks or asks as written</rule>
    <rule>Report to the user concisely in simple language. The user may not know the code or the feature</rule>
    <rule>Every question with choices, also relayed from subagents: one choice per line, "<letter> - <choice text> [<key>]". Letters A, B, C… in choice order. The user answers with letter or key</rule>
    <rule>"review-needed" missing in plan.json → true</rule>
    <rule>Quick step: a single step without plan and phase in <specs>/<domain>/quick-steps/quick-steps.json. Its status changes with "nos set-status --domain <domain> --step <id>" without --phase. Pass "quick step" and no phase id to every ability</rule>
    <rule>Roots: "nos roots" prints home, work, main, specs, inWorktree, configured. Run it at start, after entering a worktree and after leaving one. Pass home, work and specs to every ability; inside a run also the run id and "mainBranch" of <specs>/.runs/<run>.json. Never build a nos path yourself. <specs> lies outside the checkout (default: the sibling folder ../<project>.specs): Read/Grep/Glob over the specs always get <specs> or a path in it passed explicitly</rule>
    <rule>Run: one plan (run id plan-<domain id>), one quick step (run id quick-<step id>) or one POC (run id poc-<slug>) in its own branch and git worktree <main>/.claude/worktrees/<run>. The session works inside that worktree. One run per session, one run per domain. Running runs: <specs>/.runs/*.json. A POC has no domain, no statuses, is never merged and is deleted at the end (nos run abandon): option "poc"</rule>
    <rule>Token: "nos run start" prints the run token. Remember it (it stays in this transcript) and pass --token <token> to every "nos run" command. Fresh session without the token → only --take-over, and only after the user chose TAKEOVER. State run id and token in every park report, so they survive a compacted context</rule>
    <rule>Specs commits: only you commit <specs>, only with "nos specs commit". Subagents never run git against <specs>. Inside a run, after every ability returns: nos specs commit --run <run> -m "step-<id>: <ability>" (phase abilities: "phase-<id>: <ability>"). specify and spec-review are one unit: one commit after spec-review reports done, -m "step-<id>: specify, spec-review". Outside a run (idea, plan, quick step creation): nos specs commit --domain <domain> -m "<ability>: <domain>" or "<ability>: <what>". Never --domain for a domain with a run file in <specs>/.runs: it would commit that run's spec edits; check first. Only <specs>/config.json changed (e.g. chat settings): nos specs commit --config -m "<ability>: <what>". Status changes are picked up by the next specs commit. Exception: the architect run by block "proposals" (no specs commit). POC: no specs commit after its turns; only its result file, with nos specs commit --run poc-<slug> -m "poc-<slug>: result" or "poc-<slug>: processed" (commits only <specs>/pocs/poc-<slug>-result.md, also when the run file is gone)</rule>
    <rule>Code commits: develop, review-fixing, integrate and architect commit code and docs themselves in their cwd, subject prefix "step-<id>: ", "phase-<id>: " or "architect: " (colon included, matched exactly). The ability "poc" commits "poc: " on its throwaway branch. Commit form: rule "Shell" (git add -- <files>, then git commit -m "<subject>" [-m "<body>"]; never a heredoc, $(cat …) or -F -). Never a spec file, never a push</rule>
    <rule>Exit codes of nos commands, react by the table 
        <exitCodes>
            <code n="0">ok</code>
            <code n="1">failed → From "nos run finish" → cycle "finish" step2. From "nos run cleanup" "a process … still uses <wt>" → cycle "finish" step4. Otherwise MANUAL → park, report the error. AUTO → it looks transient (timeout, a lock or file in use, network, a crashed child process) → repeat the command once; fails again or not transient → dead end: block "auto-end" with the error</code>
            <code n="2">usage → fix the call. Never guess around it</code>
            <code n="3">rebase conflict (sync, finish) → run ability "integrate" with the run file, the conflict list and the mode.
                <do>pass → AUTO: its auto decisions → block "auto-decisions". Then nos specs commit --run <run> -m "<run>: integrate", then repeat the same command</do>
                <do mode="auto">blocked (AUTO: integrate already decided contradicting specs itself, main wins unless the own spec explicitly replaces it; its auto decisions → block "auto-decisions") → the rebase is done and the gate fails → gate fix rounds as cycle "finish" step2 AUTO (same budget of 2 per run, recorded before each round; develop resume for the step whose code fails, else the last done step), then repeat the command. The rebase is still open (integrate could not resolve it) or the rounds are used up → dead end: block "auto-end" (a resume starts with integrate)</do>
                <do mode="manual">blocked → stop, report both specs it cites. Ask only this question (not the question of park step2)
                    <question>The two specs contradict each other. How do you want to continue?
                        <choice key="DECIDE">Say which intent wins → rerun ability "integrate" with that decision (it overrides the contradiction), then repeat the command</choice>
                        <choice key="PAUSE">Pause → park choice PAUSE</choice>
                        <choice key="ABANDON">Drop the run → park choice ABANDON</choice>
                    </question>
                </do>
            </code>
            <code n="4" from="run start, sync, finish, cleanup, abandon" when="details without lock">run held by another token → report holder and age ("seen", "ageSec" in the details). AUTO and not from run start (another session took the run over mid-run) → no take-back: block "auto-end" (R) with only its final report: no record write, no specs commit, the run file untouched (the other session owns the run now). Otherwise (choosing or starting a run, MANUAL) ask
                <question>The run is held by another session. How do you want to continue?
                    <choice key="TAKEOVER">Take the run over: "nos run start --domain <domain> --plan|--quick <step id> --take-over" (POC: "nos run start --poc <slug> --take-over"), keep the new token. Came from run start → continue option "run" step2 (POC: option "poc" step7) with the new token (EnterWorktree, nos roots, …). Came from another nos run command → repeat it with the new token. Only when the other session is gone</choice>
                    <choice key="STOP">Stop here</choice>
                </question>
            </code>
            <code n="4" from="run start --take-over" when="details.lock merge, pidAlive true">a finish of the old holder still runs → wait 60s, repeat the take-over. Up to 10 times, then park and report (AUTO: block "auto-end", R)</code>
            <code n="4" when="details.lock ids or runs">a short CLI-internal lock stayed held 10s → wait 60s, repeat the command. Twice more held → park, report holder and age ("nos lock release <lock> --break" is the user's call). AUTO: block "auto-end" (R) instead of the park</code>
            <code n="4" from="run finish" when="details.lock merge">merge lock held by another run → wait 60s (Monitor tool or sleep), repeat finish. Up to 10 times, then park and report holder and age (AUTO: block "auto-end", R). A stale holder is never broken by you: "nos lock release merge --break" is the user's call</code>
            <code n="6">another run is active in the domain → report that run, holder and age
                <question>Another run is active in this domain. How do you want to continue?
                    <choice key="SWITCH" when="plan start">Continue that run instead → option "run" step2 with it</choice>
                    <choice key="WAIT" when="quick step start">Stop now. Start this quick step via QUICK or RUN after that run is merged</choice>
                    <choice key="STOP">Stop here</choice>
                </question>
            </code>
            <code n="5">dirty worktree → show the file list. Tracked modified files and untracked files named in the Task List or Dev Log of the current step (at finish: the last done step) → in <work>: git add -- <those files>, git commit -m "step-<id>: leftovers" (phase: "phase-<id>: leftovers"), repeat the command. docs/guardrails.xml modified (an interrupted proposals architect) → rerun ability "architect" (resume) with the same task and proposals, then repeat the command. Files changed by an interrupted docs-update architect (architecture docs, a helper's own files) → rerun ability "architect" UPDATE-DOCS (resume) with the same mode and entries, then repeat the command. AUTO: untracked generated output (build output, test results, coverage, caches) → Edit <work>/.gitignore: add an ignore pattern for it (the narrowest that covers it), git add -- .gitignore, git commit -m "step-<id>: ignore generated <path>" (phase: "phase-<id>: …"; at finish: the last done step), record (block "auto-decisions", revert: drop the pattern), repeat the command. Anything else (MANUAL: generated output too; lockfile churn, env files, tracked files the step does not name, unknown files; also in AUTO: deleting or reverting them is irreversible, (I)) → park, report "add to .gitignore or delete". Never git add -A</code>
            <code n="5" from="run cleanup">modified tracked files block the removal of a merged run's worktree (they are not in main) → park (also in AUTO: (I)), report the file list: the user reverts or deletes them. GO → repeat "nos run cleanup --token <token>"</code>
            <code n="7">no slot within slotWait → MANUAL: park, report: other runs hold every slot (e2e or dev server). AUTO: repeat the command (or rerun the ability that reported "no slot", resume) once, a second full slotWait; still no slot → block "auto-end" (R)</code>
        </exitCodes>
    </rule>
</rules>

<start>
    <do>nos roots. Read the orchestrator guardrails (rule "Guardrails")</do>
    <check>configured false, or "quality-tools" in <work>/nos.config.json missing or all null →
        <question>nos is not set up for this project yet. Set it up now?
            <choice key="YES">Set up → option "setup", then show the menu</choice>
            <choice key="NO">Skip. Abilities that run quality checks will stop until setup ran</choice>
        </question>
    </check>
    <check>inWorktree true → the run whose "worktree" in <specs>/.runs/*.json is <work> or contains it → a plan or quick run: option "run" step2 with that run; a POC run (kind poc): option "poc" step7 with it. No such run → ExitWorktree action=keep, nos roots, then the menu</check>
    <question>What do you want to do?
        <choice key="IDEA">Document an idea</choice>
        <choice key="PLAN">Create a plan from an idea</choice>
        <choice key="RUN">Run or continue a plan or quick step</choice>
        <choice key="QUICK">Quick step: one small change straight to specify, develop, review</choice>
        <choice key="POC">Brainstorm in a throwaway branch: you steer turn by turn, nothing is merged</choice>
        <choice key="ARCHITECT">Improve project quality and docs: architecture docs, guardrails, tests</choice>
        <choice key="SETUP">Set up or update nos for this project: nos.config.json, the specs repo, quality tools, slots</choice>
        <choice key="CHAT">Continue in the browser or on the phone: open the local chat (its own Claude Code sessions, one per tab)</choice>
    </question>
</start>

<option name="setup">
    <step1>Inside a worktree → ExitWorktree action=keep first. Run ability "setup"</step1>
    <step2>Setup changed <specs>/config.json (chat) → nos specs commit --config -m "setup: chat". Report the configured quality tools, project commands and slots. Pending guardrail proposals → block "proposals" first</step2>
</option>

<option name="chat">
    <step1>Run ability "chat" in the main session</step1>
    <step2>Show the menu of start in the chat and continue there</step2>
</option>

<option name="idea">
    <step1>No POC result passed in → block "poc-results" first. Run ability "idea", a POC result as its starting context (the result file path)</step1>
    <step2>nos specs commit --domain <domain> -m "idea: <domain>" (domain has a run file in <specs>/.runs → skip it, that run's next specs commit picks it up). Came from a POC result → option "poc" step6 with that POC and "idea <domain>". Report the domain folder and the idea file (new domain or added to an existing one). Pending guardrail proposals → block "proposals" first
        <question>Create a plan now?
            <choice key="YES">Create the plan → option "plan" with this domain and this idea</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step2>
    <step3>
        <do>When the plan is created and the cli commands are done: in <home>/ui start the dev server via dev-to-lan npm task and provide the network url e.g. 192.168.XXX.XXX:XXXX. The dev server also prints the chat pairing link for the phone (ability "chat")</do>
    </step3>
</option>

<option name="quick">
    <step1>Quick steps in <specs>/domain-*/quick-steps/quick-steps.json with status not done, merged or discarded, or with a run file in <specs>/.runs →
        <question>Continue a quick step or create a new one?
            <choice key="step id">One choice per such quick step: domain name, intent, status, "running" when <specs>/.runs/quick-<id>.json exists ("cleanup pending" when its phase is merged or abandoned) → option "run" step2 with this quick step</choice>
            <choice key="NEW">Create a new quick step</choice>
        </question>
    </step1>
    <step2>NEW or no quick step open → no POC result passed in → block "poc-results" first. Run ability "quick-step" with the intent if the user already gave one (a POC result: the result file path is the intent). It asks the user for the intent first. Relay all its questions to the user and the answers back. It finds a POC result too big for a quick step and the user picks IDEA → option "idea" with the same POC result instead</step2>
    <step3>nos specs commit --domain <domain> -m "quick-step: step-<id>" (domain has a run file in <specs>/.runs → skip it, that run's next specs commit picks it up). Came from a POC result → option "poc" step6 with that POC and "quick <step id>". Report the domain (new or existing) and the quick step. Pending guardrail proposals → block "proposals" first. Mode = the returned pipeline mode</step3>
    <step4>Option "run" step2 with the domain, the quick step and the mode</step4>
</option>

<option name="poc">
    <rule>A POC: a throwaway branch poc-<slug> and worktree where the user steers the ability "poc" turn by turn. No mode question, no statuses, no set-status, no specs commit after a turn, never nos run finish. It ends with the result file <specs>/pocs/poc-<slug>-result.md (template <home>/templates/poc-result.md), which seeds a quick step or an idea. Worktree and branch are deleted (nos run abandon) only once the result is processed (quick step, idea) or the POC is dropped. Notes of the subagent: <specs>/.runs/poc-<slug>.md (deleted with the run)</rule>
    <rule>Guardrail proposals are never applied inside a POC worktree: its branch is never merged. Every block "proposals" of this option runs after ExitWorktree action=keep and nos roots, on main</rule>
    <rule>Subagent gone (SendMessage fails, or a new session without a live "poc" subagent) → run a new "poc" subagent with home, work, specs, run id, mainBranch, "resume" and the message it should have got (turn text, "deploy", "end" or the change)</rule>
    <step1>Inside a worktree → ExitWorktree action=keep, nos roots. POC runs in <specs>/.runs/poc-*.json →
        <question>Continue a POC or start a new one?
            <choice key="slug">One choice per POC run: slug, phase, age, and by "nos poc results": "result ready" (its result committed, processed no), "result draft" (result not committed yet), "processed, cleanup pending" (processed not no), "cleanup pending" when its phase is abandoned → step7 with it</choice>
            <choice key="NEW">Start a new POC</choice>
        </question>
        No POC run → step2
    </step1>
    <step2>NEW: ask for a short name. Make a slug from it (lowercase kebab-case, a-z 0-9, single dashes, at most 40 characters; a result pocs/poc-<slug>-result.md or run file poc-<slug>.json already exists → another slug; nos run start refuses an existing result with exit 1 too). nos run start --poc <slug>. Exit 4 → exit code table. Keep "token" from the output. Install failure or "warnings" in the output → report them, continue. Cwd not <main> → cd <main> (absolute path, its own call). EnterWorktree path=<run.worktree>. Denied → cd <main>, retry once. Denied again → stop, report run id, token and the denial. "enter" differs from run.worktree → work in <enter>. nos roots. Read the orchestrator guardrails (rule "Guardrails"). Read the run file <specs>/.runs/poc-<slug>.json: mainBranch</step2>
    <step3>Turns: no first message yet → ask "What do you want to try?". Run ability "poc" with home, work, specs, run id, mainBranch and the user's message. Keep its subagent alive. Show the turn result of each report, then this question (drop the subagent's own option lines)
        <question>How do you want to continue?
            <choice key="DEPLOY">Deploy to test → SendMessage "deploy" to the subagent. It runs nos deploy (the POC's own env) and reports the url. Show the report, ask this question again</choice>
            <choice key="END">End the POC → step4</choice>
            <choice key="CONTINUE">Continue → ask for the next request</choice>
            <choice key="PAUSE">Pause → ExitWorktree action=keep, nos roots. Pending guardrail proposals → block "proposals". Report run id and token. End. The run, its worktree and branch stay, POC offers it</choice>
            <choice key="ABANDON">Drop the POC: worktree and branch are deleted → ask YES/NO to confirm. YES → step6 with "dropped" (no result file → only the abandon part)</choice>
        </question>
        <do>Reading the answer, in this order: a letter or key of the question, or exactly one word "pause", "abandon" or "drop" (case-insensitive, "drop" = ABANDON) → that choice. Anything else (a question, a change request, a longer text) counts as CONTINUE: forward it verbatim via SendMessage as the next turn, show the turn result, ask this question again</do>
    </step3>
    <step4>End: SendMessage "end" to the subagent. It writes <specs>/pocs/poc-<slug>-result.md and stops what it started (dev server). Show its requirements and technical details
        <question>Is this the result of the POC?
            <choice key="APPROVE">Approve → nos specs commit --run poc-<slug> -m "poc-<slug>: result". Exit 1 "No POC result" → SendMessage "end" again (the file is missing), repeat this question. Step5</choice>
            <choice key="CHANGE">Change it → ask what to change, SendMessage it to the subagent (it edits only the result file). Show the changes, ask this question again</choice>
            <choice key="PAUSE">Pause → as PAUSE of step3. The draft stays, POC lists it as "result draft"</choice>
            <choice key="ABANDON">Drop the POC → ask YES/NO to confirm. YES → step6 with "dropped" (the draft is kept as history)</choice>
        </question>
        <do>Same reading order as step3: a letter, key or one-word "pause", "abandon", "drop" → that choice; any other answer counts as CHANGE with that text</do>
    </step4>
    <step5>Hand-over
        <question>What should happen with the result?
            <choice key="QUICK">Start a quick step from it → ExitWorktree action=keep, nos roots. Option "quick" from step2 with the result file as the intent (POC result passed in). Its step3 continues with step6 here ("quick <step id>"), then option "quick" step3 and step4 (its report asks pending guardrail proposals, on main)</choice>
            <choice key="IDEA">Document an idea from it → ExitWorktree action=keep, nos roots. Option "idea" with the result file as the starting context (POC result passed in). Its step2 continues with step6 here ("idea <domain>"), then the rest of option "idea" step2 (its report asks pending guardrail proposals, on main)</choice>
            <choice key="LATER">Keep it for later → ExitWorktree action=keep, nos roots. Pending guardrail proposals → block "proposals". The result stays unprocessed, worktree and branch stay. POC lists it as "result ready", IDEA and QUICK offer it. Report run id and token. End</choice>
            <choice key="DROP">Drop the POC → step6 with "dropped"</choice>
        </question>
    </step5>
    <step6>Processed, with the POC slug and "<as>" (quick <step id> | idea <domain> | dropped). Called from step3, step4 or step5 (DROP, ABANDON), from option "quick" or "idea" (QUICK, IDEA, block "poc-results"), or from step7:
        <do>Inside the POC's worktree → nos deploy --remove (as in cycle "finish" step3), then ExitWorktree action=keep. Not inside it but its run file exists → nos deploy --remove --env poc-<slug></do>
        <do>Result file exists and processed is no → nos poc processed <slug> --as "<as>". nos specs commit --run poc-<slug> -m "poc-<slug>: processed" (dropped: kept as history)</do>
        <do>Run file <specs>/.runs/poc-<slug>.json exists → a dev server or background task the "poc" subagent started still runs → stop it (TaskStop). Phase abandoned → nos run cleanup --token <token> --run poc-<slug>. Otherwise → nos run abandon --token <token> --run poc-<slug>. No token → TAKEOVER question of exit code 4 first, to get one (phase abandoned: only the token; worktree folder gone and phase not abandoned: the take-over recreates it, abandon deletes it again). It deletes worktree, branch, run file and notes. Its cleanup part fails (exit 1, e.g. a dev server holds the folder) → report it, repeat "nos run cleanup --token <token> --run poc-<slug>" after the user stopped it. No run file (cleaned up by hand) → nothing to abandon</do>
        <do>nos roots. Called from step3, step4, step5 or step7 → pending guardrail proposals → block "proposals" (now on main). Report: result <as>, worktree and branch removed. End. Called from option "quick" or "idea" → continue there (its report asks the proposals)</do>
    </step6>
    <step7>Resume a POC (chosen in step1, or a session that starts inside its worktree):
        <do>Phase abandoned, or its result processed (not no) → step6 with the processed value (only the cleanup or abandon part: the result is already marked). End</do>
        <do>Inside its worktree and this session holds its token → no run start. Otherwise → nos run start --poc <slug>, with --token <token> when this session holds one. Exit 4 → exit code table. Not inside yet → cd <main>, EnterWorktree as in step2. Always: nos roots, the orchestrator guardrails, the run file (mainBranch)</do>
        <do>"nos poc results" lists its result: state committed and processed no → step5. State draft (or null) → show it, step4 question. No result → step3 (no live "poc" subagent → a new one with "resume" and the user's next message)</do>
    </step7>
</option>

<option name="architect">
    <step1>Run ability "architect" in this session's cwd. Outside a run that is main: its commits land on main directly (listed exception)</step1>
    <step2>Report the changes. Pending guardrail proposals → block "proposals" first. Tech debt handed over →
        <question>Start an idea flow for the found bugs?
            <choice key="ALL">One idea for all bugs → option "idea" with the tech debt entries</choice>
            <choice key="EACH">One idea per bug → option "idea" per tech debt entry, in order</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step2>
</option>

<option name="plan">
    <step1>A domain holds one idea file per idea (idea-<slug>.md, older domains idea.md). Each is planned on its own. nos ideas --unplanned → the domains with ideas not planned yet. None → report it, end. Domain given → only it
        <question>Which domain should be planned?
            <choice key="domain id">One choice per such domain (skip when only one or a domain was given): domain name, number of unplanned ideas, "has a plan" when its plan.json has phases (the new phases get appended)</choice>
        </question>
        Ideas given (e.g. by option "idea") → skip
        <question>Which ideas should be planned? (several allowed, e.g. "1,3")
            <choice key="number">One choice per unplanned idea of the domain: idea title, file name. All chosen ideas go into one plan</choice>
            <choice key="ALL">All unplanned ideas of the domain</choice>
        </question>
        Only one unplanned idea → take it without asking
    </step1>
    <step2>No sizing question: the plan ability decides the granularity per step (its rules "granularity" and "dependencies"). The user said how big the steps should be → pass it as the sizing hint</step2>
    <step3>Run ability "plan" (action create) with the domain and the ideas (file names). It reports when it appended to an existing plan and ran the dependency pass. nos specs commit --domain <domain> -m "plan: <domain>"</step3>
    <step4>Report the phases. Pending guardrail proposals → block "proposals" first
        <question>Run it now?
            <choice key="YES">Run the plan → option "run" with this domain</choice>
            <choice key="CHANGE">Change the split → ask what to change. Run ability "plan" (action revise) with the domain and the changes. nos specs commit --domain <domain> -m "plan: revise <domain>". Repeat step4</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step4>
</option>

<modes>
    <mode name="auto">Parks only where a park lists auto: human validation and irreversible actions (rule "AUTO decisions"), plus parks and questions an orchestrator guardrail adds. Every other problem → the most reasonable solution, recorded (block "auto-decisions"), continue; a technical limit or dead end → block "auto-end". A do with mode="auto" runs only in AUTO</mode>
    <mode name="manual">Parks where a park lists manual. A do with mode="manual" runs only in MANUAL. Problems, blocked verdicts and subagent questions go to the user</mode>
    <rule>The user picks the mode in option "run" and can switch anytime. A switch applies from the next park on</rule>
</modes>

<option name="run">
    <step1>No target given →
        <question>Which plan or quick step should run?
            <choice key="domain id">One choice per plan in <specs>/domain-*/plan.json with at least one phase and status not done, merged or discarded, plus every plan with a run file <specs>/.runs/plan-<domain id>.json whatever its status: plan name and status. Run file → add "running", its phase and age; phase merged or abandoned → "cleanup pending"</choice>
            <choice key="step id">One choice per quick step in <specs>/domain-*/quick-steps/quick-steps.json with status not done, merged or discarded, plus every quick step with a run file <specs>/.runs/quick-<id>.json: "<domain name> › Quick › <intent>" and status. Run file → add "running" and its phase; merged or abandoned → "cleanup pending"</choice>
        </question>
    </step1>
    <step2>Enter the run:
        <do>Cleanup pending (status merged or discarded, run file phase merged or abandoned) → inside its worktree → ExitWorktree action=keep. nos run cleanup --token <token> (no token → TAKEOVER question of exit code 4 first, to get one). nos roots. Report. Pending guardrail proposals → block "proposals" first. End</do>
        <do>Crashed finish (status merged, run file phase merge) → nos run finish --token <token> (no token → TAKEOVER question of exit code 4 first): cycle "finish" from step1. Crashed abandon (status discarded, run file phase not abandoned) → ExitWorktree action=keep when inside its worktree, nos run abandon --token <token> (no token → TAKEOVER first). nos roots. Report. Pending guardrail proposals → block "proposals" first. End</do>
        <do>Plan reopened (status open or on-hold: create-plan appended phases of another idea) while its run file phase is merged or abandoned (the earlier run) → that run is over: inside its worktree → ExitWorktree action=keep. nos run cleanup --token <token> (no token → TAKEOVER question of exit code 4 first). nos roots. Continue below with a new run start</do>
        <do>Inside the worktree of a different run → ExitWorktree action=keep, nos roots</do>
        <do>Inside its worktree and this session holds its token → no run start. Otherwise → nos run start --domain <domain> --plan, or --quick <step id>, with --token <token> when this session holds one. Exit 4|6 → exit code table. Keep "token" from the output. Install failure in the output ("install" with code not 0) → report it, continue. "warnings" in the output (e.g. .claude/worktrees not ignored) → report them, continue. Not inside yet → cwd not <main> → cd <main> (absolute path, its own call). EnterWorktree path=<run.worktree> (the worktree top: EnterWorktree accepts only a folder git knows as a worktree). Denied → cd <main>, retry once. Denied again → park, report run id, token and the denial (mode AUTO already given, e.g. by quick-step or a resumed AUTO run: block "auto-end", R). Never continue outside the worktree. "enter" differs from run.worktree (the project is a subfolder of its repo) → work in <enter> from now on: cd there, pass it as work</do>
        <do>Always: nos roots → home, work (= the worktree), specs. Read the run file <specs>/.runs/<run>.json: run id, mainBranch, base</do>
        <do>Rebase check (run file phase develop): nos run sync --token <token>. Exit 3 (details.rebaseInProgress: a stopped rebase, or a new conflict) → exit code table (integrate; pass → its specs commit, then nos run sync again; blocked → its do). Exit 5 → no rebase is open: continue, commit nothing (an interrupted ability finishes its own work on resume). Other codes → exit code table</do>
    </step2>
    <step3>Mode given (e.g. by quick-step) → skip
        <question>How should the plan run?
            <choice key="AUTO">Autonomous. Stops only for human validation and irreversible actions (merging a plan into main, deleting files with your work). Solves every other problem with the most reasonable solution and records problem and solution in auto-decisions.md of the domain. A technical limit (lock, slot, permission) or a dead end ends the run with a report, without a question</choice>
            <choice key="MANUAL">Stops after each specification, implementation and review for your go</choice>
        </question>
    </step3>
    <entry>Status merged or discarded → handled in step2 (cleanup pending). Quick step → status done → cycle "finish". Otherwise cycle "step" with the domain and the quick step, then cycle "finish" (automatic, no question). Plan → read the plan status. open or on-hold → step4. in-progress → step5. done → step6</entry>
    <step4>
        <status target="plan" from="open|on-hold" to="in-progress"/>
    </step4>
    <step5 resume-at="in-progress">
        <do mode="manual">For each phase not done, in order: cycle "phase"</do>
        <do mode="auto">Block "scheduler": the steps by their dependencies, specifications in parallel</do>
        <status target="plan" from="in-progress" to="done"/>
        <do>nos specs commit --run <run> -m "<run>: plan done" (no ability runs for the last status changes, so no other commit would carry them; also before INTEGRATE = NO)</do>
    </step5>
    <step6 resume-at="done">
        <do>Report (with the auto decisions report line, block "auto-decisions"). Pending guardrail proposals → block "proposals" (still in the worktree; also in AUTO: the INTEGRATE question waits for the user anyway). Then
            <question>The plan is done on its branch. Integrate it into main now?
                <choice key="YES">Integrate → cycle "finish"</choice>
                <choice key="NO">Stop here. The run stays; RUN offers it again</choice>
            </question>
        </do>
    </step6>
</option>

<cycle name="finish">
    <step1>MANUAL: pending guardrail proposals → block "proposals" first, still in the worktree: the architect's commit lands on the run branch and merges with it. AUTO: skip it, step3 asks them after merge and cleanup. AUTO, quick run (its finish is automatic, no INTEGRATE question): this run's section in auto-decisions.md (Read it) has a line with "applied: (!) left" → dead end: block "auto-end" before finishing, the run stays unmerged (advice: check the (!), resume in MANUAL to finish anyway, or ABANDON). Then block "docs-update". Then nos run finish --token <token>. It locks, checks main, syncs, runs the full gate (e2e included when configured) and merges ff-only. Exit 0 → step3. Exit 1 → step2. Other codes → exit code table (3: integrate, then repeat step1; 4: wait for the merge lock)</step1>
    <step2>Exit 1:
        <do mode="auto">Gate fail (gate JSON in the details) → FIX by yourself, at most 2 rounds per run, one budget shared with the gate fix rounds of exit code 3 (count the "applied: gate fix round <n>/2" lines of this run after its last "rounds reset by resume" line: Read the file, so a compacted context or a resume keeps the count; a resume the user starts in AUTO resets the budget once: record "finish — problem: gate rounds used up — applied: rounds reset by resume — revert: -"). Per round, first record "finish — problem: gate fail <tools> — applied: gate fix round <n>/2", then run ability "develop" (resume, mode auto) for the last done step with the failing tools and tails as feedback. It commits "step-<id>: gate fix". nos specs commit --run <run> -m "step-<id>: gate fix". Repeat step1. Still failing after round 2 → dead end: block "auto-end", the run stays unmerged; its report advises resuming in MANUAL (FIX, PAUSE or ABANDON)</do>
        <do mode="manual">Gate fail (gate JSON in the details) → stop, report run id and token, the failing tools and their tails. Ask only this question (not the question of park step2)
            <question>The gate failed while integrating. How do you want to continue?
                <choice key="FIX">Run ability "develop" (resume) for the last done step with the failing tools and tails as feedback. It commits "step-<id>: gate fix". nos specs commit --run <run> -m "step-<id>: gate fix". Repeat step1</choice>
                <choice key="PAUSE">Pause → park choice PAUSE</choice>
                <choice key="ABANDON">Drop the run → park choice ABANDON</choice>
            </question>
        </do>
        <do>Main busy ("details.busy": a merge, rebase, cherry-pick or revert in progress in main), main dirty ("details.files" on paths the branch touches), main checkout on another branch ("main checkout is on <x>, expected <mainBranch>") or "git merge --ff-only … refused twice" → park, report the error and the details. GO → repeat step1 after the user fixed main. AUTO (R: main is the user's, you never touch it): wait 60s, repeat step1 once; the same error again → block "auto-end" with the details and the advice below. Main dirty on docs/guardrails.xml (an interrupted proposals architect on main) → same advice in the park report: rerun ability "architect" (resume) on main with the same task and proposals</do>
        <do>Other → park, report the error (AUTO: as exit code 1 AUTO)</do>
    </step2>
    <step3>Merged → still in the worktree: nos deploy --remove (deletes the run's test env; exit 8 → nothing deployed; exit 1 → name it in the report, continue; AUTO: also record it, revert: "nos deploy --remove --env <run>" later). ExitWorktree action=keep. nos run cleanup --token <token> (from main the token finds the run). nos roots. AUTO: an auto decision since the last specs commit (e.g. the cleanup) → no run file for the domain in <specs>/.runs (the run file is gone after cleanup) → nos specs commit --domain <domain> -m "<run>: auto decisions"; another run of the domain has one → skip, that run's next specs commit picks it up. Report: merged into <mainBranch>, worktree and branch removed, the auto decisions report line (block "auto-decisions"; follow-ups listed). Proposals collected since step1 (AUTO: all pending ones) → block "proposals" (now on main, the architect commits there)</step3>
    <step4>Cleanup refused: exit 1 "a process … still uses <wt>" (e.g. a dev server) → MANUAL: report it, repeat "nos run cleanup --token <token>" after the user stopped it. AUTO (R): a dev server or background task this session started → stop it (TaskStop) first; then wait 60s and repeat, up to 3 times; still refused → record, block "auto-end" with "cleanup pending" (the run is merged; RUN offers the cleanup). Exit 5 → exit code table</step4>
</cycle>

<cycle name="phase">
    <entry>resume</entry>
    <step1 resume-at="in-progress">
        <status target="phase" from="open" to="in-progress"/>
        <do>For each step not done, in order: cycle "step" (MANUAL; in AUTO block "scheduler" runs the steps and enters this cycle at step2 once they are all done)</do>
    </step1>
    <step2 resume-at="implemented">
        <status target="phase" from="in-progress" to="implemented"/>
        <park mode="manual"/>
        <park mode="auto,manual" when="review-needed false and human-validation-needed"/>
        <do when="review-needed false">Go to step5. Skip the review</do>
    </step2>
    <step3 resume-at="in-review">
        <status target="phase" from="implemented" to="in-review"/>
        <do>Run ability "review-pessimistic" with the phase and the mode</do>
        <do>Run ability "review-fixing" with the phase and the mode</do>
        <do mode="auto" when="verdict blocked">As cycle "step" step5 AUTO</do>
        <park mode="manual" when="verdict blocked"/>
    </step3>
    <step4 resume-at="reviewed">
        <status target="phase" from="in-review" to="reviewed"/>
        <park mode="manual"/>
        <park mode="auto,manual" when="human-validation-needed"/>
    </step4>
    <step5>
        <status target="phase" from="reviewed|implemented" to="done"/>
    </step5>
</cycle>

<cycle name="step">
    <entry>resume</entry>
    <step1 resume-at="in-specification">
        <status target="step" from="open" to="in-specification"/>
        <do>Run ability "specify" with domain, phase id (quick step: "quick step" instead), step id, mode and user feedback if any. Keep its subagent alive when it reports done</do>
        <do>Run ability "spec-review" with domain, phase id, step id, mode and user feedback if any. Resume and specify not run in this session → tell it the spec author is unavailable</do>
        <do>spec-review returns questions "for-specify" → SendMessage them to the specify subagent. Its answers → SendMessage to the spec-review subagent. specify asks back → relay to spec-review and the reply back</do>
        <do>spec-review returns questions for the user → ask the user, send the answers back to spec-review (AUTO: rule "If a subagent returns questions", only (H) and (I) questions reach the user)</do>
        <do>spec-review reports done → the specification is finished. Send nothing more to the specify subagent. nos specs commit --run <run> -m "step-<id>: specify, spec-review"</do>
    </step1>
    <step2 resume-at="specified">
        <status target="step" from="in-specification" to="specified"/>
        <park mode="manual"/>
    </step2>
    <step3 resume-at="in-progress">
        <do when="not a resume at in-progress">nos run sync --token <token>. Exit 3 → exit code table (integrate; pass → its specs commit, then sync again; blocked → its do). Other codes → exit code table. Resumed at in-progress → no sync: develop finishes its half-done work first, the next develop syncs. Parallel step (block "scheduler") → no sync at all: its agent worktree starts at the run branch tip</do>
        <status target="step" from="specified" to="in-progress"/>
        <do>Run ability "develop" with domain, phase id, step id, mode and user feedback if any</do>
        <do mode="auto" when="verdict blocked">Per reason, each at most once per step (count the lines of this run for the step: Read the file, so a compacted context keeps the count): no ACs → record "step-<id> — problem: no ACs — applied: specify rerun 1/1", run the step1 actions again (specify, spec-review, mode auto; no status change), their specs commit, then develop again; still no ACs → dead end: block "auto-end". (!) tasks → record "step-<id> — problem: (!) <tasks> — applied: develop rerun 1/1", rerun develop (resume) with the (!) reasons as feedback. Still (!) → record "step-<id> — problem: (!) <tasks> <reasons> — applied: (!) left, finish gate decides — revert: -", continue with step4: the Dev Log keeps the (!), the reviews and the finish gate decide (a quick run ends before its finish, cycle "finish" step1). No slot → exit code 7 AUTO. Permission denied → R: block "auto-end"</do>
        <park mode="manual" when="verdict blocked"/>
    </step3>
    <step4 resume-at="implemented">
        <status target="step" from="in-progress" to="implemented"/>
        <park mode="manual"/>
        <park mode="auto,manual" when="review-needed false and human-validation-needed"/>
        <do when="review-needed false">Go to step7. Skip the review</do>
    </step4>
    <step5 resume-at="in-review">
        <status target="step" from="implemented" to="in-review"/>
        <do>Run ability "review-pessimistic" with the step and the mode</do>
        <do>Run ability "review-fixing" with the step and the mode</do>
        <do mode="auto" when="verdict blocked">review-fixing decided user decisions itself (Fixes marked "(auto decision)", recorded by the rule of block "auto-decisions") and left (!) only for not fixable or out of scope findings → record each: not fixable ones "step-<id> — problem: F<n> <finding> — applied: (!) left, finish gate decides — revert: -", out of scope ones "applied: follow-up, not done in this run" (also listed in the final report as follow-ups: a later quick step or a guardrail proposal). Continue. No slot → exit code 7 AUTO. Permission denied → R: block "auto-end". Anything else blocked → record it as "applied: (!) left, finish gate decides", continue (cycle "finish" step1 decides for a quick run)</do>
        <park mode="manual" when="verdict blocked"/>
    </step5>
    <step6 resume-at="reviewed">
        <status target="step" from="in-review" to="reviewed"/>
        <park mode="manual"/>
        <park mode="auto,manual" when="human-validation-needed"/>
    </step6>
    <step7>
        <do>Parallel step → rule "Merge queue" of block "scheduler" first: done only once merged into the run branch</do>
        <status target="step" from="reviewed|implemented" to="done"/>
    </step7>
</cycle>

<scheduler>
    <rule>AUTO only, plans only (option "run" step5). Runs the steps of a plan by their dependencies (plan.json "depends-on", answered by "nos ready") instead of in array order. Specifications run in parallel: up to parallel.specify steps at once ("parallel" in the nos ready output, main's nos.config.json). Development runs in parallel too, up to parallel.develop steps at once, each in its own step worktree (rule "Parallel step"); the merge queue folds them into the run branch (rule "Merge queue"). This worktree (the run's) is touched only by phase reviews, the docs-update architect and the merge queue, one at a time under a hold. Every launched subagent runs in the background (rule "Background subagents"); each step keeps its own cycle "step" position, each phase its cycle "phase" position</rule>
    <rule>Parallel step: a step developed beside others never works in this worktree. Every ability of such a step (develop, review-pessimistic, review-fixing, integrate for its conflicts, a develop rerun) is launched with the Agent tool's isolation "worktree" (plus run_in_background and the "step-<id> <ability>" description): Claude Code gives it a worktree of its own under <main>/.claude/worktrees/. Pass the inputs as usual plus "parallel step: run id <run>, token <token>"; its ability file tells it to call "nos run step-start --step <id> --run <run> --token <token>" first, which adopts that worktree for the step (branch at the step's tip, node_modules moved over, the previous agent worktree removed, a stopped rebase replayed). The task notification names the worktree and branch; the step file <specs>/.runs/<run>.steps/step-<id>.json records them ("nos run status --token <token>"). No "nos run sync" while step files exist (it refuses): the run branch moves only by the merge queue. Statuses change as in cycle "step"; the specs commits stay per step</rule>
    <rule>Merge queue: a parallel step at reviewed (or implemented with review-needed false), after its parks → "nos run step-merge --step <id> --token <token>" (enqueue; the step keeps its status until merged), then "nos run merge-queue --token <token>" (foreground, like run finish). Exit 0 → for every entry of "merged": <status target="step" from="reviewed|implemented" to="done"/>, then nos specs commit --run <run> -m "step-<id>: merged". Exit 3 (details.step) → run ability "integrate" for that step as a parallel step with the details (worktree, branch, mainBranch = the run branch, base, files); it reports pass → step-merge for the step again, then merge-queue. Exit 1 with details.step → "exhausted" false → run ability "review-fixing" for that step as a parallel step with the failing tools and tails as merge gate feedback; pass → step-merge again, merge-queue; "exhausted" true → the step stays blocked: record it (block "auto-decisions": "step-<id> — problem: merge gate failed 2/2 — applied: blocked, user decides"), the other steps go on; MANUAL would park. Exit 4 → held: after the hold's release. Exit 5 (the run worktree has leftovers) → exit code table, then merge-queue again. Call merge-queue again after every integrate or review-fixing report of a queued step and whenever a step was enqueued; a blocked or conflict step is skipped by it until queued again</rule>
    <step1>nos ready --domain <domain>. "dependenciesChecked" false → run ability "plan" (action dependencies) with the domain (description "plan dependencies"); it reports → nos specs commit --run <run> -m "plan: dependencies <domain>", nos ready again. Report in one line which steps are independent (the "specify" list beyond the first) and the parallel caps</step1>
    <step2>Loop until the nos ready output says "done": true. One pass = after every task notification and every user message: nos ready --domain <domain>, then these actions in this order, then end the turn when subagents are still running:
        <do>A step in "specify" or "develop" whose phase is still open → <status target="phase" from="open" to="in-progress"/> once, before the step starts</do>
        <do>"specify": take steps from the top of the list until parallel.specify steps are in-specification (count "running" with status in-specification plus the ones started this pass). For each → cycle "step" step1 (its status change, then specify, then spec-review, both in the background with the step id in their descriptions) and, when its spec-review reports done, its specs commit and step2's status change to specified. Questions of a step (for-specify, or for the user: rule "If a subagent returns questions") are relayed per step: while step A waits for an answer, the notifications of the other steps are handled; end every such turn by re-stating A's open question</do>
        <do>"develop": take steps from the top of the list until parallel.develop steps are in-progress or in-review (count "running" with those statuses plus the ones started this pass). Each → cycle "step" from step3 as a parallel step (rule "Parallel step"): no sync, status in-progress, develop with isolation "worktree"; its later steps 4 to 7 follow its own notifications, each ability again as a parallel step</do>
        <do>"continue": a step implemented → cycle "step" from step4 (its reviews as parallel steps); reviewed → from step6; after step6's parks → step7 is the merge queue (rule "Merge queue"): step-merge, merge-queue, done when merged</do>
        <do>"phasesReviewable": nothing of that phase is still queued or blocked in "nos run status" and no other phase review runs → nos run merge-queue --hold "phase-<id> review" --token <token>, then cycle "phase" from step2 in this worktree (its reviews as today, no isolation); after its step4 (or the answer of its park) → nos run merge-queue --release --token <token>, then merge-queue. A merge-queue exit 4 in the meantime → after the release</do>
        <do>"phasesContinuing": a phase implemented → cycle "phase" from step2; in-review with no live review subagent (resume) → from step3; reviewed → from step4</do>
        <do>Resume (no live subagent for a step in "running"): re-enter that step's cycle at resume-at = its status (block "resume"); a parallel step (it has a step file) → its next ability as a parallel step: the new agent worktree adopts the step, half-done work in the old worktree is lost only when uncommitted (step-start refuses a dirty previous worktree: tell the user). "nos run status --token <token>": steps queued or blocked → merge-queue / their agent (rule "Merge queue"); a hold without a live subagent → nos run merge-queue --release first</do>
        <do>This pass launched nothing, nothing is running (no step in-specification, in-progress or in-review, no phase in-review, no subagent alive) and "done" is false → dead end (a step waits on a dependency that cannot finish): block "auto-end" with the "blocked" list and what each waits on</do>
    </step2>
    <rule>Parks keep their meaning per step: a park (H) of step A (human validation at reviewed) names step A and lists the other live steps with their statuses; GO and REJECT apply to the named step; the other steps go on with their notifications in the meantime, the open question is re-stated at the end of each such turn. PAUSE waits until the running subagents reported (or stops them with TaskStop: their steps resume by status), then parks the plan. ABANDON as in the park</rule>
    <rule>Specs commits stay per step and per ability (rule "Specs commits"); the domain-scoped commit may include another step's half-written spec: harmless, that step's own commit follows</rule>
    <rule>Status changes stay per step via nos set-status; never set a status for a step whose notification has not arrived</rule>
    <rule>A step that happens to run alone (the only step of its phase, or the only one ready) is still a parallel step: same worktree rules, same merge queue. Only MANUAL runs develop in this worktree</rule>
    <rule>Plan done (nos ready "done": true: every phase done, no step files, no hold) → option "run" step5's status change and specs commit, then step6 as usual. ABANDON with step files → "nos run step-abandon --step <id> --token <token>" for each ("nos run status --token <token>" lists them), then the park's ABANDON</rule>
</scheduler>

<poc-results>
    <rule>Asked by option "idea" step1 and option "quick" step2 when no POC result was passed in. nos poc results → the results with state committed and processed no (a draft is not approved yet: POC resumes it). None → skip</rule>
    <question>A proof of concept left a result. Use one as the input?
        <choice key="USE <slug>">One choice per such result: title, slug, "POC still open" when runExists → the result file path is the input of the ability (POC result passed in)</choice>
        <choice key="NO">Start without a POC result</choice>
    </question>
    <do>USE → after the ability created the idea or the quick step and its specs commit: option "poc" step6 with that slug and "idea <domain>" or "quick <step id>" (marks it processed, commits it, removes its run when the run file exists: phase abandoned → nos run cleanup, else nos run abandon; no token → TAKEOVER first). Then continue the option</do>
</poc-results>

<proposals>
    <rule>Asked by rule "Lessons → guardrail proposals", before any other question of that park, report or session end. Its own message: wait for the answer, then the next question. No pending proposal → skip</rule>
    <rule>Never inside a POC worktree: its branch is never merged. Leave it first (ExitWorktree action=keep, nos roots), then ask on main</rule>
    <question>Lessons from this work, proposed as guardrails. Which should the architect add?
        <choice key="P<n>">One choice per proposal, numbered P1, P2…: section, wording, reason, why it does not block valid work. Several letters or keys accept several</choice>
        <choice key="ALL">Accept all</choice>
        <choice key="NO">Drop all. Nothing is written, no memory either</choice>
    </question>
    <do>Accepted → run ability "architect" with task ADD-GUARDRAILS and the accepted proposals, in this session's cwd. Inside a run: its commits land on the run branch and reach main with the merge. Outside a run: on main (listed exception). No specs commit for it. Relay its questions (only about problem proposals) and the answers back, also in AUTO (the block runs only at a park or a run's end, never mid-run). Report one line per applied proposal: key, section, wording ("applied P1: coding — …"). Inside a run repeat these lines in every later park report of the run, so they survive a compacted context (ABANDON needs them)</do>
    <do>Not accepted → dropped. Then continue with the park or report you came from</do>
</proposals>

<docs-update>
    <rule>Asked by cycle "finish" step1: after block "proposals", before nos run finish, still in the worktree. Skip when resuming a crashed finish (status merged: the merge already ran). Never in a POC</rule>
    <rule>Report line: "docs update: <step ids> handled, <n> committed" (handled = every step whose entries went to the architect, answered yes or no). Repeat it in every later park and final report of the run, so a compacted context never asks them again</rule>
    <do>Collect the Dev Log entries marked (architecture) in the run's step spec files: quick step → its "spec-file" in quick-steps.json; plan → the "spec-file" of every step in plan.json (relative to <specs>). Leave out discarded steps and steps already in the report line (step1 repeated after integrate or a gate fix). None → skip</do>
    <do>Run ability "architect" with task UPDATE-DOCS, the run mode (auto|manual) and the entries (step id, spec path and entry text), in this session's cwd. Architecture docs or a helper's files already dirty in <work> (git status) → tell it it resumes interrupted work. Its commits "architect: docs <section> from step-<id> (architecture)" land on the run branch and reach main with the merge. No specs commit</do>
    <do>Relay its questions (rule "If a subagent returns questions"): AUTO and a matching standing answer → answer it (rule "Guardrails"). AUTO otherwise → answer it yourself (an architecture doc change on the run branch is reversible, not (I)): yes when the change matches the entry and the shown diff and breaks no guardrail, else no (you read no code for it); record it. MANUAL → ask the user and wait. Done → the report line. Tech debt the architect hands over → list it in the finish report</do>
</docs-update>

<auto-decisions>
    <rule>AUTO only (rule "AUTO decisions"): the record of every problem solved without the user. File <specs>/<domain>/auto-decisions.md, structure <home>/templates/auto-decisions.md. Write/Edit only (rule "Specs writes"): missing → Write it from the template, else Read, then Edit to append</rule>
    <do>One section per run: "## <run> — <date>" (the date the run's first decision was recorded; missing → add it at the end of the file; a resumed run appends to its section). One line per decision: "- <where: step-<id> | phase-<id> | integrate | finish | cleanup> — problem: … — applied: … — revert: …" (revert: how to undo it, "-" when obvious). An ability's own record (Spec Log, Dev Log "What I didn't do and why", review Fixes "(auto decision)", Dev Log (merge)) → the line points to it ("see Dev Log step-<id>"). A follow-up (out of scope finding) → "applied: follow-up, not done in this run"</do>
    <do>Every ability report in AUTO that lists auto decisions (specify, spec-review, develop, review-fixing, integrate, the docs-update architect, …) → one line each, written before that ability's specs commit, whatever the verdict (pass or blocked)</do>
    <do>Fixed wordings for counted tries, so a count is a Read of the file: "applied: specify rerun 1/1", "applied: develop rerun 1/1", "applied: gate fix round <n>/2", "applied: rounds reset by resume", "applied: (!) left, finish gate decides". After a compacted context or on resume, Read the file to count</do>
    <do>Committed with the next nos specs commit --run <run>: the file lies in the run's domain folder, the domain-scoped commit includes it</do>
    <rule>Report line: "auto decisions this run: <n>" plus the lines of this run, in every park report, every question that waits for the user, and the final report (also block "auto-end"), so a compacted context keeps them. None → "auto decisions this run: 0"</rule>
</auto-decisions>

<auto-end>
    <rule>AUTO only (rule "AUTO decisions"): a technical limit (R) after its bounded fallback, or a dead end. Ending with a report is no park: no question about the run, nobody is waited for. No status change (a plan stays in-progress, not on-hold): the run (status, worktree, branch, an open rebase) stays, RUN lists it as running and resumes it. Exception: taken over by another session (exit code 4 without lock) → only the final report</rule>
    <do>Record the blocker and what was tried (block "auto-decisions": "applied: run ended"). The run file still exists → nos specs commit --run <run> -m "<run>: auto end"</do>
    <do>Final report: run id and token, target, status, "ended (AUTO): <blocker>", what was tried, what the user can do (free the slot, stop the process, fix main, take over), then RUN continues the run. The auto decisions report line, follow-ups, the applied guardrail lines, the docs-update line and the standing answer lines of the run</do>
    <do>Pending guardrail proposals → block "proposals" (the run's end, still in the worktree when inside: the architect's commits land on the run branch). Then end the session's work on the run; stay where you are</do>
</auto-end>

<park>
    <step1>Stop. Report run id and token, target, status and reason (AUTO: only (H) or (I), rule "AUTO decisions"). Other steps live (block "scheduler") → name the parked step and list the other live steps with their statuses; they go on while the question is open. The auto decisions report line (block "auto-decisions"). Pending guardrail proposals by key only ("pending proposals: P1, P2, asked below"), the applied ones of this run by their lines. Specified → summarize the description and ACs in simple words. Human validation → explain in simple steps how the user verifies; a deployed url in the ability report → name it, the user verifies there. No review ran → derive the steps from the ACs of the step or of the phase's steps</step1>
    <step2>Pending guardrail proposals → block "proposals" first
        <question>How do you want to continue?
            <choice key="GO">Continue with the next step of the cycle</choice>
            <choice key="AUTO|MANUAL">Switch to the other mode and continue. Show only the mode not active. To AUTO in a plan run → block "scheduler" takes over (its step1 runs the dependency pass when the plan has none)</choice>
            <choice key="REJECT" when="parked step is specified">Give feedback on the specification
                <status target="step" from="specified" to="in-specification"/>
                <do>Repeat cycle "step" from step1 action with the feedback</do>
            </choice>
            <choice key="REJECT" when="parked step is reviewed, or implemented with review-needed false">Give feedback on what is wrong
                <status target="step" from="reviewed|implemented" to="in-specification"/>
                <do>Repeat cycle "step" from step1 action with the feedback. Pass it to specify and develop</do>
            </choice>
            <choice key="REJECT" when="parked phase is reviewed, or implemented with review-needed false">Give feedback on what is wrong
                <status target="phase" from="reviewed|implemented" to="done"/>
                <do>Turn the feedback into clear issues. Run ability "plan" (action extend) with domain, phase id and issues. Continue the run</do>
            </choice>
            <choice key="PAUSE">Pause the plan or quick step
                <status target="plan" from="in-progress" to="on-hold" when="not a quick step"/>
                <do>nos specs commit --run <run> -m "<run>: pause". ExitWorktree action=keep. End. The run, its worktree and branch stay. A quick step keeps its status and continues via QUICK or RUN</do>
            </choice>
            <choice key="ABANDON">Drop the plan or quick step: its branch and worktree are deleted, the specs stay as history with status discarded
                <do>Ask YES/NO to confirm. YES → nos deploy --remove (as in cycle "finish" step3). ExitWorktree action=keep. nos run abandon --token <token>. nos roots. Report. Guardrails the architect added on this run's branch (every block "proposals" since run start, see the applied lines) die with it → block "proposals" again with those proposals (now applied on main). Its cleanup part fails (exit 1, e.g. a dev server holds the folder) → report it, repeat "nos run cleanup --token <token>" after the user stopped it</do>
            </choice>
        </question>
    </step2>
</park>

<resume>
    <rule>A run can be interrupted anytime (limits, shutdown). Never reset a status on resume</rule>
    <rule>Read the target status in plan.json, quick step: in quick-steps.json. open → step1. done → skip the cycle. Otherwise → the step with resume-at = status: skip its status change, run its actions and parks</rule>
    <rule>Resumed session already inside a POC's worktree → option "poc" step7</rule>
    <rule>Resumed session already inside a run's worktree → option "run" step2: no run start when it holds the token, always nos roots and the run file, then the rebase check: nos run sync exit 3 (a rebase in progress) → integrate first</rule>
    <rule>Tell a rerun ability that it resumes interrupted work</rule>
    <rule>AUTO plan run → block "scheduler" step1: nos ready lists every step by status; steps in "running" without a live subagent are re-entered by their status, one develop or review at a time</rule>
</resume>
