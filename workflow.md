<rules>
    <rule>Run every ability in a new subagent. Pass it the ability skill path and its inputs</rule>
    <rule>Change statuses only with "nos set-status". Valid statuses: ./templates/status.xml</rule>
    <rule>If a subagent returns questions for the user, ask the user and send the answers back to the same subagent via SendMessage</rule>
    <rule>Report to the user concisely in simple language. The user may not know the code or the feature</rule>
    <rule>Every question with choices, also relayed from subagents: one choice per line, "<letter> - <choice text> [<key>]". Letters A, B, C… in choice order. The user answers with letter or key</rule>
    <rule>"review-needed" missing in plan.json → true</rule>
</rules>

<start>
    <check>specs/config.json missing or without "quality-tools" →
        <question>nos is not set up for this project yet. Set it up now?
            <choice key="YES">Set up → option "setup", then show the menu</choice>
            <choice key="NO">Skip. Abilities that run quality checks will stop until setup ran</choice>
        </question>
    </check>
    <question>What do you want to do?
        <choice key="IDEA">Document an idea</choice>
        <choice key="PLAN">Create a plan from an idea</choice>
        <choice key="RUN">Run or continue a plan</choice>
        <choice key="ARCHITECT">Improve project quality and docs: architecture docs, guardrails, tests</choice>
        <choice key="SETUP">Set up or update nos for this project: specs folder, config, quality tools</choice>
    </question>
</start>

<option name="setup">
    <step1>Run ability "setup"</step1>
    <step2>Report the configured quality tools and project commands</step2>
</option>

<option name="idea">
    <step1>Run ability "idea"</step1>
    <step2>Report the domain folder
        <question>Create a plan now?
            <choice key="YES">Create the plan → option "plan" with this domain</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step2>
    <step3>
        <do>When the plan is created and the cli commands are done: in the spec-ui folder start the dev server via dev-to-lan npm task and provide the network url e.g. 192.168.XXX.XXX:XXXX</do>
    </step3>
</option>

<option name="architect">
    <step1>Run ability "architect"</step1>
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
            <choice key="domain id">One choice per specs/domain-* folder without plan.json: domain name</choice>
        </question>
    </step1>
    <step2>
        <question>How big should phases and steps be?
            <choice key="S">Small. Many phases, small focused steps</choice>
            <choice key="M">Medium. Balanced</choice>
            <choice key="L">Large. Few phases (maybe one), few big steps (maybe one)</choice>
        </question>
    </step2>
    <step3>Run ability "plan" (action create) with the domain and the sizing</step3>
    <step4>Report the phases
        <question>Run it now?
            <choice key="YES">Run the plan → option "run" with this domain</choice>
            <choice key="CHANGE">Change the split → ask what to change. Run ability "plan" (action revise) with the domain and the changes. Repeat step4</choice>
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
    <step1>No domain given →
        <question>Which plan should run?
            <choice key="domain id">One choice per plan in specs/domain-*/plan.json not done: plan name and status</choice>
        </question>
    </step1>
    <step2>
        <question>How should the plan run?
            <choice key="AUTO">Autonomous. Stops only for problems or human validation</choice>
            <choice key="MANUAL">Stops after each specification, implementation and review for your go</choice>
        </question>
    </step2>
    <entry>Read the plan status. open or on-hold → step3. in-progress → step4</entry>
    <step3>
        <status target="plan" from="open|on-hold" to="in-progress"/>
    </step3>
    <step4 resume-at="in-progress">
        <do>For each phase not done, in order: cycle "phase"</do>
    </step4>
    <step5>
        <status target="plan" from="in-progress" to="done"/>
        <do>Report</do>
    </step5>
</option>

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
        <do>Run ability "specify" with domain, phase id, step id, mode and user feedback if any. Keep its subagent alive when it reports done</do>
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
            <choice key="PAUSE">Pause the plan
                <status target="plan" from="in-progress" to="on-hold"/>
                <do>End the run</do>
            </choice>
        </question>
    </step2>
</park>

<resume>
    <rule>A run can be interrupted anytime (limits, shutdown). Never reset a status on resume</rule>
    <rule>Read the target status in plan.json. open → step1. done → skip the cycle. Otherwise → the step with resume-at = status: skip its status change, run its actions and parks</rule>
    <rule>Tell a rerun ability that it resumes interrupted work</rule>
</resume>
