<rules>
    <rule>Invocation: "nos" = the literal command "node <home>/cli/bin/nos.js …", typed out in full in every Bash call. <home> = this skill's base directory, or the "home" from "nos roots". Always forward slashes. After the first "nos roots" use its "home" verbatim in every call (identical string, so permission rules match). Never through a shell variable, function or alias (Claude Code's worktree isolation refuses a command whose name is computed at runtime), never a linked "nos"</rule>
    <rule>Git against main: never "cd <main> && git …", "git -C <main> …" or GIT_DIR from a worktree session. Claude Code's worktree isolation blocks git redirected into the main checkout. Git against main happens only inside nos commands (run finish, run cleanup, run abandon)</rule>
    <rule>Cwd: the Bash cwd persists across calls. Never cd into <specs> or anywhere outside <work> (before a run: <main>). Read outside it with Read/Grep/Glob and the absolute path. Worktree isolation refuses Bash whose cwd is not in the worktree, and EnterWorktree from a cwd outside the repo needs an approval nobody can give in auto mode or the chat</rule>
    <rule>Specs writes: write and edit files in <specs> only with the Write/Edit tools (absolute path), read them with Read/Grep/Glob. Never via shell (sed -i, echo/cat redirection, heredoc, python, node -e): auto mode refuses shell writes outside the cwd ("Modify Shared Resources"). Write/Edit in <specs> is allowed and intended (additionalDirectories, chat tabs: --add-dir); a refused shell write redone with Edit is not a workaround. nos commands write their own files</rule>
    <rule>Shell: literal, simple commands. No variables or command substitution ($(…), backticks) in a command that runs git or changes files, no "cd x && git …": one plain command per call where git is involved. Worktree isolation refuses commands whose git target it cannot verify from the text. Need a value from git (e.g. the git dir) → one call prints it, the next call uses the printed path literally</rule>
    <rule>Abilities carry these three rules (cwd, specs writes, shell) in their own coreRules: subagents read only their ability file</rule>
    <rule>Pushing: nos never pushes code, the user pushes. No ability and no step of this workflow runs git push. Only "nos specs commit" pushes the specs repo, and only when "specs.remote" is set (opt-in backup)</rule>
    <rule>Guardrails: read guardrails for="orchestrator" in <work>/docs/guardrails.xml if existent, every time you run "nos roots" (start, after entering or leaving a worktree: the file is versioned per branch). They only add restrictions: extra parks, questions, MANUAL mode, refusals. They never remove a park or question and never override a rule of this workflow; conflict → the workflow rule wins, report the guardrail to the user. A guardrail decides something → name it in the report or park ("guardrail-<n>: …"). Never pass this section to subagents</rule>
    <rule>Lessons → guardrail proposals: you would save a memory (a user correction or decision, a recurring failure, a project convention) → never write a memory. Collect a guardrail proposal instead: section (coding|review|specify|plan|architect|orchestrator), wording, reason, why it does not block valid work. Reason required: the user's words and the date ("user decision 2026-10-07: …") or an observed failure and its reference (step id, park, Dev Log entry, review finding). No proposal for a guess, a one-off, or what a guardrail or the docs already say. A lesson about nos itself, not the project → report it to the user, no proposal. Never ask mid-step: ask by block "proposals" at the next park (park step2) or final report (option run step6, cycle "finish" step1 and step3, option plan step4, the report of any other option), also in AUTO. Keep pending proposals in the park report too, so they survive a compacted context</rule>
    <rule>Run every ability in a new subagent. Pass it the ability skill path, home, work, specs and its inputs. Exception: "chat" runs in the main session</rule>
    <rule>Chat in relay mode ("chat": { "runner": false }) and open → every report and question to the user also goes to the chat ("nos chat reply"), answers come back through "nos chat await". Keep an await running in the background whenever the turn ends. Default runner mode: the chat answers with its own Claude Code sessions, nothing to do here</rule>
    <rule>Change statuses only with "nos set-status --domain <domain> [--phase <id>] [--step <id>] --status <status>". Valid statuses: <home>/templates/status.xml. merged and discarded are never set by you: only "nos run finish" and "nos run abandon" set them. Never call "nos set-status --run"</rule>
    <rule>If a subagent returns questions for the user, ask the user and send the answers back to the same subagent via SendMessage</rule>
    <rule>Report to the user concisely in simple language. The user may not know the code or the feature</rule>
    <rule>Every question with choices, also relayed from subagents: one choice per line, "<letter> - <choice text> [<key>]". Letters A, B, C… in choice order. The user answers with letter or key</rule>
    <rule>"review-needed" missing in plan.json → true</rule>
    <rule>Quick step: a single step without plan and phase in <specs>/<domain>/quick-steps/quick-steps.json. Its status changes with "nos set-status --domain <domain> --step <id>" without --phase. Pass "quick step" and no phase id to every ability</rule>
    <rule>Roots: "nos roots" prints home, work, main, specs, inWorktree, configured. Run it at start, after entering a worktree and after leaving one. Pass home, work and specs to every ability; inside a run also the run id and "mainBranch" of <specs>/.runs/<run>.json. Never build a nos path yourself. <specs> lies outside the checkout (default: the sibling folder ../<project>.specs): Read/Grep/Glob over the specs always get <specs> or a path in it passed explicitly</rule>
    <rule>Run: one plan (run id plan-<domain id>) or one quick step (run id quick-<step id>) in its own branch and git worktree <main>/.claude/worktrees/<run>. The session works inside that worktree. One run per session, one run per domain. Running runs: <specs>/.runs/*.json</rule>
    <rule>Token: "nos run start" prints the run token. Remember it (it stays in this transcript) and pass --token <token> to every "nos run" command. Fresh session without the token → only --take-over, and only after the user chose TAKEOVER. State run id and token in every park report, so they survive a compacted context</rule>
    <rule>Specs commits: only you commit <specs>, only with "nos specs commit". Subagents never run git against <specs>. Inside a run, after every ability returns: nos specs commit --run <run> -m "step-<id>: <ability>" (phase abilities: "phase-<id>: <ability>"). specify and spec-review are one unit: one commit after spec-review reports done, -m "step-<id>: specify, spec-review". Outside a run (idea, plan, quick step creation): nos specs commit --domain <domain> -m "<ability>: <domain>" or "<ability>: <what>". Never --domain for a domain with a run file in <specs>/.runs: it would commit that run's spec edits; check first. Only <specs>/config.json changed (e.g. chat settings): nos specs commit --config -m "<ability>: <what>". Status changes are picked up by the next specs commit</rule>
    <rule>Code commits: develop, review-fixing, integrate and architect commit code and docs themselves in their cwd, subject prefix "step-<id>: ", "phase-<id>: " or "architect: " (colon included, matched exactly). Never a spec file, never a push</rule>
    <rule>Exit codes of nos commands, react by the table <exitCodes>
    <code n="0">ok</code>
    <code n="1">failed → park, report the error. From "nos run finish" → cycle "finish" step2</code>
    <code n="2">usage → fix the call. Never guess around it</code>
    <code n="3">rebase conflict (sync, finish) → run ability "integrate" with the run file and the conflict list.
        <do>pass → nos specs commit --run <run> -m "<run>: integrate", then repeat the same command</do>
        <do>blocked → stop, report both specs it cites. Ask only this question (not the question of park step2)
            <question>The two specs contradict each other. How do you want to continue?
                <choice key="DECIDE">Say which intent wins → rerun ability "integrate" with that decision (it overrides the contradiction), then repeat the command</choice>
                <choice key="PAUSE">Pause → park choice PAUSE</choice>
                <choice key="ABANDON">Drop the run → park choice ABANDON</choice>
            </question>
        </do>
    </code>
    <code n="4" from="run start, sync, finish, cleanup, abandon" when="details without lock">run held by another token → report holder and age ("seen", "ageSec" in the details)
        <question>The run is held by another session. How do you want to continue?
            <choice key="TAKEOVER">Take the run over: "nos run start --domain <domain> --plan|--quick <step id> --take-over", keep the new token. Came from run start → continue option "run" step2 with the new token (EnterWorktree, nos roots, …). Came from another nos run command → repeat it with the new token. Only when the other session is gone</choice>
            <choice key="STOP">Stop here</choice>
        </question>
    </code>
    <code n="4" from="run start --take-over" when="details.lock merge, pidAlive true">a finish of the old holder still runs → wait 60s, repeat the take-over. Up to 10 times, then park and report</code>
    <code n="4" when="details.lock ids or runs">a short CLI-internal lock stayed held 10s → wait 60s, repeat the command. Twice more held → park, report holder and age ("nos lock release <lock> --break" is the user's call)</code>
    <code n="4" from="run finish" when="details.lock merge">merge lock held by another run → wait 60s (Monitor tool or sleep), repeat finish. Up to 10 times, then park and report holder and age. A stale holder is never broken by you: "nos lock release merge --break" is the user's call</code>
    <code n="6">another run is active in the domain → report that run, holder and age
        <question>Another run is active in this domain. How do you want to continue?
            <choice key="SWITCH" when="plan start">Continue that run instead → option "run" step2 with it</choice>
            <choice key="WAIT" when="quick step start">Stop now. Start this quick step via QUICK or RUN after that run is merged</choice>
            <choice key="STOP">Stop here</choice>
        </question>
    </code>
    <code n="5">dirty worktree → show the file list. Tracked modified files and untracked files named in the Task List or Dev Log of the current step (at finish: the last done step) → in <work>: git add -- <those files>, git commit -m "step-<id>: leftovers" (phase: "phase-<id>: leftovers"), repeat the command. Anything else (generated output, lockfile churn, env files, unknown) → park, report "add to .gitignore or delete". Never git add -A</code>
    <code n="5" from="run cleanup">modified tracked files block the removal of a merged run's worktree (they are not in main) → park, report the file list: the user reverts or deletes them. GO → repeat "nos run cleanup --token <token>"</code>
    <code n="7">no slot within slotWait → park, report: other runs hold every slot (e2e or dev server)</code>
</exitCodes></rule>
</rules>

<start>
    <do>nos roots. Read the orchestrator guardrails (rule "Guardrails")</do>
    <check>configured false, or "quality-tools" in <work>/nos.config.json missing or all null →
        <question>nos is not set up for this project yet. Set it up now?
            <choice key="YES">Set up → option "setup", then show the menu</choice>
            <choice key="NO">Skip. Abilities that run quality checks will stop until setup ran</choice>
        </question>
    </check>
    <check>inWorktree true → the run whose "worktree" in <specs>/.runs/*.json is <work> or contains it → option "run" step2 with that run. No such run → ExitWorktree action=keep, nos roots, then the menu</check>
    <question>What do you want to do?
        <choice key="IDEA">Document an idea</choice>
        <choice key="PLAN">Create a plan from an idea</choice>
        <choice key="RUN">Run or continue a plan or quick step</choice>
        <choice key="QUICK">Quick step: one small change straight to specify, develop, review</choice>
        <choice key="ARCHITECT">Improve project quality and docs: architecture docs, guardrails, tests</choice>
        <choice key="SETUP">Set up or update nos for this project: nos.config.json, the specs repo, quality tools, slots</choice>
        <choice key="CHAT">Continue in the browser or on the phone: open the local chat (its own Claude Code sessions, one per tab)</choice>
    </question>
</start>

<option name="setup">
    <step1>Inside a worktree → ExitWorktree action=keep first. Run ability "setup"</step1>
    <step2>Setup changed <specs>/config.json (chat) → nos specs commit --config -m "setup: chat". Report the configured quality tools, project commands and slots</step2>
</option>

<option name="chat">
    <step1>Run ability "chat" in the main session</step1>
    <step2>Show the menu of start in the chat and continue there</step2>
</option>

<option name="idea">
    <step1>Run ability "idea"</step1>
    <step2>nos specs commit --domain <domain> -m "idea: <domain>". Report the domain folder
        <question>Create a plan now?
            <choice key="YES">Create the plan → option "plan" with this domain</choice>
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
    <step2>NEW or no quick step open → run ability "quick-step" with the intent if the user already gave one. It asks the user for the intent first. Relay all its questions to the user and the answers back</step2>
    <step3>nos specs commit --domain <domain> -m "quick-step: step-<id>" (domain has a run file in <specs>/.runs → skip it, that run's next specs commit picks it up). Report the domain (new or existing) and the quick step. Mode = the returned pipeline mode</step3>
    <step4>Option "run" step2 with the domain, the quick step and the mode</step4>
</option>

<option name="architect">
    <step1>Run ability "architect" in this session's cwd. Outside a run that is main: its commits land on main directly (listed exception)</step1>
    <step2>Report the changes. Tech debt handed over →
        <question>Start an idea flow for the found bugs?
            <choice key="ALL">One idea for all bugs → option "idea" with the tech debt entries</choice>
            <choice key="EACH">One idea per bug → option "idea" per tech debt entry, in order</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step2>
</option>

<option name="plan">
    <step1>No domain given →
        <question>Which idea should be planned?
            <choice key="domain id">One choice per <specs>/domain-* folder without plan.json or with a hollow plan.json (no phases): domain name</choice>
        </question>
    </step1>
    <step2>
        <question>How big should phases and steps be?
            <choice key="S">Small. Many phases, small focused steps</choice>
            <choice key="M">Medium. Balanced</choice>
            <choice key="L">Large. Few phases (maybe one), few big steps (maybe one)</choice>
        </question>
    </step2>
    <step3>Run ability "plan" (action create) with the domain and the sizing. nos specs commit --domain <domain> -m "plan: <domain>"</step3>
    <step4>Report the phases. Pending guardrail proposals → block "proposals" first
        <question>Run it now?
            <choice key="YES">Run the plan → option "run" with this domain</choice>
            <choice key="CHANGE">Change the split → ask what to change. Run ability "plan" (action revise) with the domain and the changes. nos specs commit --domain <domain> -m "plan: revise <domain>". Repeat step4</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step4>
</option>

<modes>
    <mode name="auto">Parks only where a park lists auto</mode>
    <mode name="manual">Parks where a park lists manual</mode>
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
        <do>Cleanup pending (status merged or discarded, run file phase merged or abandoned) → inside its worktree → ExitWorktree action=keep. nos run cleanup --token <token> (no token → TAKEOVER question of exit code 4 first, to get one). nos roots. Report. End</do>
        <do>Crashed finish (status merged, run file phase merge) → nos run finish --token <token> (no token → TAKEOVER question of exit code 4 first): cycle "finish" from step1. Crashed abandon (status discarded, run file phase not abandoned) → ExitWorktree action=keep when inside its worktree, nos run abandon --token <token> (no token → TAKEOVER first). nos roots. Report. End</do>
        <do>Inside the worktree of a different run → ExitWorktree action=keep, nos roots</do>
        <do>Inside its worktree and this session holds its token → no run start. Otherwise → nos run start --domain <domain> --plan, or --quick <step id>, with --token <token> when this session holds one. Exit 4|6 → exit code table. Keep "token" from the output. Install failure in the output ("install" with code not 0) → report it, continue. "warnings" in the output (e.g. .claude/worktrees not ignored) → report them, continue. Not inside yet → cwd not <main> → cd <main> (absolute path, its own call). EnterWorktree path=<run.worktree> (the worktree top: EnterWorktree accepts only a folder git knows as a worktree). Denied → cd <main>, retry once. Denied again → park, report run id, token and the denial. Never continue outside the worktree. "enter" differs from run.worktree (the project is a subfolder of its repo) → work in <enter> from now on: cd there, pass it as work</do>
        <do>Always: nos roots → home, work (= the worktree), specs. Read the run file <specs>/.runs/<run>.json: run id, mainBranch, base</do>
        <do>Rebase check (run file phase develop): nos run sync --token <token>. Exit 3 (details.rebaseInProgress: a stopped rebase, or a new conflict) → run ability "integrate", then nos run sync again. Exit 5 → no rebase is open: continue, commit nothing (an interrupted ability finishes its own work on resume). Other codes → exit code table</do>
    </step2>
    <step3>Mode given (e.g. by quick-step) → skip
        <question>How should the plan run?
            <choice key="AUTO">Autonomous. Stops only for problems or human validation</choice>
            <choice key="MANUAL">Stops after each specification, implementation and review for your go</choice>
        </question>
    </step3>
    <entry>Status merged or discarded → handled in step2 (cleanup pending). Quick step → status done → cycle "finish". Otherwise cycle "step" with the domain and the quick step, then cycle "finish" (automatic, no question). Plan → read the plan status. open or on-hold → step4. in-progress → step5. done → step6</entry>
    <step4>
        <status target="plan" from="open|on-hold" to="in-progress"/>
    </step4>
    <step5 resume-at="in-progress">
        <do>For each phase not done, in order: cycle "phase"</do>
        <status target="plan" from="in-progress" to="done"/>
    </step5>
    <step6 resume-at="done">
        <do>Report. Pending guardrail proposals → block "proposals" (still in the worktree). Then
            <question>The plan is done on its branch. Integrate it into main now?
                <choice key="YES">Integrate → cycle "finish"</choice>
                <choice key="NO">Stop here. The run stays; RUN offers it again</choice>
            </question>
        </do>
    </step6>
</option>

<cycle name="finish">
    <step1>Pending guardrail proposals → block "proposals" first, still in the worktree: the architect's commit lands on the run branch and merges with it. Then nos run finish --token <token>. It locks, checks main, syncs, runs the full gate (e2e included when configured) and merges ff-only. Exit 0 → step3. Exit 1 → step2. Other codes → exit code table (3: integrate, then repeat step1; 4: wait for the merge lock)</step1>
    <step2>Exit 1:
        <do>Gate fail (gate JSON in the details) → stop, report run id and token, the failing tools and their tails. Ask only this question (not the question of park step2)
            <question>The gate failed while integrating. How do you want to continue?
                <choice key="FIX">Run ability "develop" (resume) for the last done step with the failing tools and tails as feedback. It commits "step-<id>: gate fix". nos specs commit --run <run> -m "step-<id>: gate fix". Repeat step1</choice>
                <choice key="PAUSE">Pause → park choice PAUSE</choice>
                <choice key="ABANDON">Drop the run → park choice ABANDON</choice>
            </question>
        </do>
        <do>Main busy ("details.busy": a merge, rebase, cherry-pick or revert in progress in main), main dirty ("details.files" on paths the branch touches), main checkout on another branch ("main checkout is on <x>, expected <mainBranch>") or "git merge --ff-only … refused twice" → park, report the error and the details. GO → repeat step1 after the user fixed main</do>
        <do>Other → park, report the error</do>
    </step2>
    <step3>Merged → ExitWorktree action=keep. nos run cleanup --token <token> (from main the token finds the run). nos roots. Report: merged into <mainBranch>, worktree and branch removed. Proposals collected since step1 → block "proposals" (now on main)</step3>
    <step4>Cleanup refused: exit 1 "a process … still uses <wt>" (e.g. a dev server) → report it, repeat "nos run cleanup --token <token>" after the user stopped it. Exit 5 → exit code table</step4>
</cycle>

<cycle name="phase">
    <entry>resume</entry>
    <step1 resume-at="in-progress">
        <status target="phase" from="open" to="in-progress"/>
        <do>For each step not done, in order: cycle "step"</do>
    </step1>
    <step2 resume-at="implemented">
        <status target="phase" from="in-progress" to="implemented"/>
        <park mode="manual"/>
        <park mode="auto,manual" when="review-needed false and human-validation-needed"/>
        <do when="review-needed false">Go to step5. Skip the review</do>
    </step2>
    <step3 resume-at="in-review">
        <status target="phase" from="implemented" to="in-review"/>
        <do>Run ability "review-pessimistic" with the phase</do>
        <do>Run ability "review-fixing" with the phase</do>
        <park mode="auto,manual" when="verdict blocked"/>
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
        <do>spec-review returns questions for the user → ask the user, send the answers back to spec-review</do>
        <do>spec-review reports done → the specification is finished. Send nothing more to the specify subagent. nos specs commit --run <run> -m "step-<id>: specify, spec-review"</do>
    </step1>
    <step2 resume-at="specified">
        <status target="step" from="in-specification" to="specified"/>
        <park mode="manual"/>
    </step2>
    <step3 resume-at="in-progress">
        <do when="not a resume at in-progress">nos run sync --token <token>. Exit 3 → integrate, then sync again. Other codes → exit code table. Resumed at in-progress → no sync: develop finishes its half-done work first, the next develop syncs</do>
        <status target="step" from="specified" to="in-progress"/>
        <do>Run ability "develop" with domain, phase id, step id and user feedback if any</do>
        <park mode="auto,manual" when="verdict blocked"/>
    </step3>
    <step4 resume-at="implemented">
        <status target="step" from="in-progress" to="implemented"/>
        <park mode="manual"/>
        <park mode="auto,manual" when="review-needed false and human-validation-needed"/>
        <do when="review-needed false">Go to step7. Skip the review</do>
    </step4>
    <step5 resume-at="in-review">
        <status target="step" from="implemented" to="in-review"/>
        <do>Run ability "review-pessimistic" with the step</do>
        <do>Run ability "review-fixing" with the step</do>
        <park mode="auto,manual" when="verdict blocked"/>
    </step5>
    <step6 resume-at="reviewed">
        <status target="step" from="in-review" to="reviewed"/>
        <park mode="manual"/>
        <park mode="auto,manual" when="human-validation-needed"/>
    </step6>
    <step7>
        <status target="step" from="reviewed|implemented" to="done"/>
    </step7>
</cycle>

<proposals>
    <rule>Asked by rule "Lessons → guardrail proposals", before any other question of that park or report. No pending proposal → skip</rule>
    <question>Lessons from this work, proposed as guardrails. Which should the architect add?
        <choice key="P<n>">One choice per proposal, numbered P1, P2…: section, wording, reason, why it does not block valid work. Several letters or keys accept several</choice>
        <choice key="ALL">Accept all</choice>
        <choice key="NO">Drop all. Nothing is written, no memory either</choice>
    </question>
    <do>Accepted → run ability "architect" with task ADD-GUARDRAILS and the accepted proposals, in this session's cwd. Inside a run: its commit lands on the run branch and reaches main with the merge. Outside a run: on main (listed exception). No specs commit for it. Relay its questions (only about problem proposals) and the answers back. Report what it added</do>
    <do>Not accepted → dropped. Then continue with the park or report you came from</do>
</proposals>

<park>
    <step1>Stop. Report run id and token, target, status, reason and pending guardrail proposals. Specified → summarize the description and ACs in simple words. Human validation → explain in simple steps how the user verifies. No review ran → derive the steps from the ACs of the step or of the phase's steps</step1>
    <step2>Pending guardrail proposals → block "proposals" first
        <question>How do you want to continue?
            <choice key="GO">Continue with the next step of the cycle</choice>
            <choice key="AUTO|MANUAL">Switch to the other mode and continue. Show only the mode not active</choice>
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
                <do>Ask YES/NO to confirm. YES → ExitWorktree action=keep. nos run abandon --token <token>. nos roots. Report. Guardrails added at this park died with the branch → run ability "architect" again with the same proposals (now on main). Its cleanup part fails (exit 1, e.g. a dev server holds the folder) → report it, repeat "nos run cleanup --token <token>" after the user stopped it</do>
            </choice>
        </question>
    </step2>
</park>

<resume>
    <rule>A run can be interrupted anytime (limits, shutdown). Never reset a status on resume</rule>
    <rule>Read the target status in plan.json, quick step: in quick-steps.json. open → step1. done → skip the cycle. Otherwise → the step with resume-at = status: skip its status change, run its actions and parks</rule>
    <rule>Resumed session already inside a run's worktree → option "run" step2: no run start when it holds the token, always nos roots and the run file, then the rebase check: nos run sync exit 3 (a rebase in progress) → integrate first</rule>
    <rule>Tell a rerun ability that it resumes interrupted work</rule>
</resume>
