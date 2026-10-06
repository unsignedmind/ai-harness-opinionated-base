<rules>
    <rule>Invocation: "nos" = "node <home>/cli/bin/nos.js". <home> = this skill's base directory, or the "home" from "nos roots". Never rely on a linked "nos"</rule>
    <rule>Run every ability in a new subagent. Pass it the ability skill path, home, work, specs and its inputs. Exception: "chat" runs in the main session</rule>
    <rule>Roots: "nos roots" prints home, work, main, specs, inWorktree, configured. Run it at start, after entering a worktree and after leaving one. Pass home, work and specs to every ability; inside a run also the run id and "mainBranch" of <specs>/.runs/<run>.json. Never build a nos path yourself. Grep/Glob over the specs: always pass <specs> as the path (hidden folder)</rule>
    <rule>Run: one plan (run id plan-<domain id>) or one quick step (run id quick-<step id>) in its own branch and git worktree <main>/.claude/worktrees/<run>. The session works inside that worktree. One run per session, one run per domain. Running runs: <specs>/.runs/*.json</rule>
    <rule>Token: "nos run start" prints the run token. Remember it (it stays in this transcript) and pass --token <token> to every "nos run" command. Fresh session without the token → only --take-over, and only after the user chose TAKEOVER</rule>
    <rule>Specs commits: only you commit <specs>, only with "nos specs commit". Subagents never run git against <specs>. Inside a run, after every ability returns: nos specs commit --run <run> -m "step-<id>: <ability>" (phase abilities: "phase-<id>: <ability>"). Outside a run (idea, plan, quick step creation): nos specs commit --domain <domain> -m "<ability>: <domain>". Status changes are picked up by the next specs commit</rule>
    <rule>Code commits: develop, review-fixing, integrate and architect commit code and docs themselves in their cwd, subject prefix "step-<id>: ", "phase-<id>: " or "architect: " (colon included, matched exactly). Never a spec file</rule>
    <rule>Exit codes of nos commands, react by the table <exitCodes></rule>
    <rule>Chat in relay mode ("chat": { "runner": false }) and open → every report and question to the user also goes to the chat ("nos chat reply"), answers come back through "nos chat await". Keep an await running in the background whenever the turn ends. Default runner mode: the chat answers with its own Claude Code sessions, nothing to do here</rule>
    <rule>Change statuses only with "nos set-status". Valid statuses: ./templates/status.xml. merged and discarded are set only by "nos run finish" and "nos run abandon"</rule>
    <rule>If a subagent returns questions for the user, ask the user and send the answers back to the same subagent via SendMessage</rule>
    <rule>Report to the user concisely in simple language. The user may not know the code or the feature</rule>
    <rule>Every question with choices, also relayed from subagents: one choice per line, "<letter> - <choice text> [<key>]". Letters A, B, C… in choice order. The user answers with letter or key</rule>
    <rule>"review-needed" missing in plan.json → true</rule>
    <rule>Quick step: a single step without plan and phase in <specs>/<domain>/quick-steps/quick-steps.json. Its status changes with "nos set-status --domain --step" without --phase. Pass "quick step" and no phase id to every ability</rule>
</rules>

<exitCodes>
    <code n="0">ok</code>
    <code n="1">failed → park, report the error. Gate fail: the failing tools and their tail. Main busy or main dirty (finish): the details list</code>
    <code n="2">usage → fix the call. Never guess around it</code>
    <code n="3">rebase conflict (sync, finish) → run ability "integrate" with the run file and the conflict list. pass → nos specs commit, then repeat the same command. blocked (contradicting specs, gate fail) → park, report both specs it cites</code>
    <code n="4|6">held by another token (4) or another run in the domain (6) → report the holder: run, age since "seen" or "taken" from the details
        <question>The run is held by another session. How do you want to continue?
            <choice key="TAKEOVER" when="4 from run start">Take the run over: repeat "nos run start" with --take-over. Only when the other session is gone</choice>
            <choice key="SWITCH" when="6">Continue the running run of this domain instead → option "run" step2 with it</choice>
            <choice key="STOP">Stop here</choice>
        </question>
        Lock held (finish: merge lock of another run) → park: another run is merging, retry later. Stale holder → tell the user: "nos lock release <name> --break" is their call, never yours</code>
    <code n="5">dirty worktree → details list the files. Leftover work of the current step (its ability did not commit) → in <work>: git add -A, git commit -m "step-<id>: leftovers" (phase: "phase-<id>: leftovers"), repeat the command. Unclear origin → park, report the files</code>
    <code n="7">no slot within slotWait → park, report: other runs hold every slot (e2e or dev server)</code>
</exitCodes>

<start>
    <do>nos roots</do>
    <check>configured false, or "quality-tools" in <work>/nos.config.json missing or all null →
        <question>nos is not set up for this project yet. Set it up now?
            <choice key="YES">Set up → option "setup", then show the menu</choice>
            <choice key="NO">Skip. Abilities that run quality checks will stop until setup ran</choice>
        </question>
    </check>
    <check>inWorktree true and this session holds the run of that worktree → option "run" step2 with that run</check>
    <question>What do you want to do?
        <choice key="IDEA">Document an idea</choice>
        <choice key="PLAN">Create a plan from an idea</choice>
        <choice key="RUN">Run or continue a plan or quick step</choice>
        <choice key="QUICK">Quick step: one small change straight to specify, develop, review</choice>
        <choice key="ARCHITECT">Improve project quality and docs: architecture docs, guardrails, tests</choice>
        <choice key="SETUP">Set up or update nos for this project: nos.config.json, .specs repo, quality tools, slots</choice>
        <choice key="CHAT">Continue in the browser or on the phone: open the local chat (its own Claude Code sessions, one per tab)</choice>
    </question>
</start>

<option name="setup">
    <step1>Inside a worktree → ExitWorktree (keep) first. Run ability "setup"</step1>
    <step2>Report the configured quality tools, project commands and slots</step2>
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
    <step1>Quick steps in <specs>/domain-*/quick-steps/quick-steps.json with status not done, merged or discarded →
        <question>Continue a quick step or create a new one?
            <choice key="step id">One choice per such quick step: domain name, intent, status, "running" when <specs>/.runs/quick-<id>.json exists → option "run" step2 with this quick step</choice>
            <choice key="NEW">Create a new quick step</choice>
        </question>
    </step1>
    <step2>NEW or no quick step open → run ability "quick-step" with the intent if the user already gave one. It asks the user for the intent first. Relay all its questions to the user and the answers back</step2>
    <step3>nos specs commit --domain <domain> -m "quick-step: step-<id>". Report the domain (new or existing) and the quick step. Mode = the returned pipeline mode</step3>
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
    <step4>Report the phases
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
            <choice key="domain id">One choice per plan in <specs>/domain-*/plan.json with at least one phase and status not done, merged or discarded: plan name and status. <specs>/.runs/plan-<domain id>.json exists → add "running", its phase and age; done plans with a run file are listed too (not integrated yet)</choice>
            <choice key="step id">One choice per quick step in <specs>/domain-*/quick-steps/quick-steps.json with status not done, merged or discarded: "<domain name> › Quick › <intent>" and status. <specs>/.runs/quick-<id>.json exists → add "running"; done ones with a run file are listed too</choice>
        </question>
    </step1>
    <step2>Enter the run:
        <do>Already inside its worktree (nos roots: work = the run's worktree) → skip to the rebase check</do>
        <do>Otherwise: nos run start --domain <domain> --plan, or --quick <step id>. Add --token <token> when this session holds one. Exit 4|6 → exit code table. Keep "token" from the output. Install failure in the output → report it, continue</do>
        <do>EnterWorktree path=<enter>. nos roots → home, work (= the worktree), specs. Read "mainBranch" from <specs>/.runs/<run>.json</do>
        <do>Rebase check: a rebase is in progress in <work> (git status says so) → run ability "integrate" first, then nos run sync --token <token></do>
    </step2>
    <step3>Mode given (e.g. by quick-step) → skip
        <question>How should the plan run?
            <choice key="AUTO">Autonomous. Stops only for problems or human validation</choice>
            <choice key="MANUAL">Stops after each specification, implementation and review for your go</choice>
        </question>
    </step3>
    <entry>Quick step → status done → cycle "finish". Otherwise cycle "step" with the domain and the quick step, then cycle "finish" (automatic, no question). Plan → read the plan status. open or on-hold → step4. in-progress → step5. done → step6</entry>
    <step4>
        <status target="plan" from="open|on-hold" to="in-progress"/>
    </step4>
    <step5 resume-at="in-progress">
        <do>For each phase not done, in order: cycle "phase"</do>
        <status target="plan" from="in-progress" to="done"/>
    </step5>
    <step6 resume-at="done">
        <do>Report. Then
            <question>The plan is done on its branch. Integrate it into main now?
                <choice key="YES">Integrate → cycle "finish"</choice>
                <choice key="NO">Stop here. The run stays; RUN offers it again</choice>
            </question>
        </do>
    </step6>
</option>

<cycle name="finish">
    <step1>nos run finish --token <token>. It locks, checks main, syncs, runs the full gate (e2e included when configured) and merges ff-only. Exit 3 → integrate, then repeat step1. Other codes → exit code table</step1>
    <step2>Merged → ExitWorktree (keep). nos run cleanup --token <token>. nos roots. Report: merged into <mainBranch>, worktree and branch removed</step2>
    <step3>Cleanup refused (a process holds the folder, e.g. a dev server) → report it. Repeat "nos run cleanup --token <token>" after the user stopped it</step3>
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
        <do>spec-review reports done → the specification is finished. Send nothing more to the specify subagent</do>
    </step1>
    <step2 resume-at="specified">
        <status target="step" from="in-specification" to="specified"/>
        <park mode="manual"/>
    </step2>
    <step3 resume-at="in-progress">
        <do>nos run sync --token <token>. Exit 3 → integrate, then sync again. Other codes → exit code table</do>
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

<park>
    <step1>Stop. Report target, status and reason. Specified → summarize the description and ACs in simple words. Human validation → explain in simple steps how the user verifies. No review ran → derive the steps from the ACs of the step or of the phase's steps</step1>
    <step2>
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
                <do>ExitWorktree (keep). End. The run, its worktree and branch stay. A quick step keeps its status and continues via QUICK or RUN</do>
            </choice>
            <choice key="ABANDON">Drop the plan or quick step: its branch and worktree are deleted, the specs stay as history with status discarded
                <do>Ask YES/NO to confirm. YES → ExitWorktree (keep). nos run abandon --token <token>. nos roots. Report</do>
            </choice>
        </question>
    </step2>
</park>

<resume>
    <rule>A run can be interrupted anytime (limits, shutdown). Never reset a status on resume</rule>
    <rule>Read the target status in plan.json, quick step: in quick-steps.json. open → step1. done → skip the cycle. Otherwise → the step with resume-at = status: skip its status change, run its actions and parks</rule>
    <rule>Resumed session already inside a run's worktree → no run start. A rebase is in progress there → run ability "integrate" first</rule>
    <rule>Tell a rerun ability that it resumes interrupted work</rule>
</resume>
