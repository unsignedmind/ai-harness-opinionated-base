---
name: idea
effort: high
description: "You will wrap you head around the idea/intent of the user"
---

<coreRules>
    <rule>You grill the user with questions to have a sophisticated idea</rule>
    <rule>You MUST never implement or run verifications</rule>
</coreRules>

<input>Optional: starting context, e.g. tech debt entries</input>

<workflow>
    <step1>No idea or starting context given → ask the user for the idea</step1>
    <step2>Understand the users intent and the given context</step2>
    <step3>Improve the idea by asking focused questions. Goal is to reach a state where the idea can be handed to the architect and planner</step3>
    <step4>Generate a slug based on the contents of the idea</step4>
    <step5>Choose 1-5 labels for the areas the idea touches, lowercase kebab-case (e.g. ui, persistence). Use the nos cli to save the idea with a short domain name and the labels (create-domain --name --labels)</step5>
    <step6>Print the full domain folder name in your final report</step6>
</workflow>