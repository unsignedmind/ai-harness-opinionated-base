<rules>
    <rule>Run every ability in a new subagent. Pass it the ability skill path and its inputs</rule>
    <rule>Change statuses only with "nos set-status". Valid statuses: ./templates/status.xml</rule>
    <rule>If a subagent returns questions for the user, ask the user and send the answers back to the same subagent via SendMessage</rule>
    <rule>Report to the user concisely in simple language. The user may not know the code or the feature</rule>
    <rule>Every question with choices, also relayed from subagents: one choice per line, "<letter> - <choice text> [<key>]". Letters A, B, C… in choice order. The user answers with letter or key</rule>
</rules>

<start>
    <question>What do you want to do?
        <choice key="IDEA">Document an idea</choice>
        <choice key="PLAN">Create a plan from an idea</choice>
        <choice key="RUN">Run or continue a plan</choice>
        <choice key="ARCHITECT">Improve project quality and docs: architecture docs, guardrails, tests</choice>
    </question>
</start>

<option name="idea">
    <step1>Run ability "idea"</step1>
    <step2>Report the domain folder
        <question>Create a plan now?
            <choice key="YES">Create the plan → option "plan" with this domain</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step2>
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
    <step2>Run ability "plan" (action create) with the domain</step2>
    <step3>Report the phases
        <question>Run it now?
            <choice key="YES">Run the plan → option "run" with this domain</choice>
            <choice key="NO">Stop here</choice>
        </question>
    </step3>
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
        <status target="phase" from="reviewed" to="done"/>
    </step5>
</cycle>

<cycle name="step">
    <entry>resume</entry>
    <step1 resume-at="in-specification">
        <status target="step" from="open" to="in-specification"/>
        <do>Run ability "specify" with domain, phase id, step id, mode and user feedback if any</do>
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
        <status target="step" from="reviewed" to="done"/>
    </step7>
</cycle>

<park>
    <step1>Stop. Report target, status and reason. Specified → summarize the description and ACs in simple words. Human validation → explain in simple steps how the user verifies</step1>
    <step2>
        <question>How do you want to continue?
            <choice key="GO">Continue with the next step of the cycle</choice>
            <choice key="AUTO|MANUAL">Switch to the other mode and continue. Show only the mode not active</choice>
            <choice key="REJECT" when="parked step is specified">Give feedback on the specification
                <status target="step" from="specified" to="in-specification"/>
                <do>Repeat cycle "step" from step1 action with the feedback</do>
            </choice>
            <choice key="REJECT" when="parked step is reviewed">Give feedback on what is wrong
                <status target="step" from="reviewed" to="in-specification"/>
                <do>Repeat cycle "step" from step1 action with the feedback. Pass it to specify and develop</do>
            </choice>
            <choice key="REJECT" when="parked phase is reviewed">Give feedback on what is wrong
                <status target="phase" from="reviewed" to="done"/>
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
