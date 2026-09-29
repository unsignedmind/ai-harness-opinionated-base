## Review
Date: YYYY-MM-DD · Result: passed | failed
One or two sentences: what was checked, what stands out

### Criteria
- AC1 met: where it is built, which test proves it
- AC2 partly: what is missing and why
- AC3 not met: nothing found in the changes

### Findings
- ( ) F1 must-fix · bug · src/cart/total.ts:42: what is wrong and the evidence → suggested fix · mechanical
- ( ) F2 should-fix · quality · src/cart/total.ts:10: what is wrong and the evidence → suggested fix · judgment

### Fixes
- F1: what changed (abc1234)

<rules>
    <rule>ACn is the nth AC of the spec. Phase review → S<step id>-AC<n> across all its steps</rule>
    <rule>Result passed only when every AC is met and no finding is must-fix. Otherwise failed</rule>
    <rule>Finding: marker, id, weight, category (bug|gap|test|quality), file:line, evidence → suggested fix, fix kind</rule>
    <rule>must-fix: wrong behavior, security hole, missing critical validation, error case of an AC untested</rule>
    <rule>should-fix: naming, style, missed optimization, missing non-critical test</rule>
    <rule>mechanical: local fix, no behavior decision. judgment: needs a decision or changes behavior</rule>
    <rule>Findings marked by review-fixing: (x) fixed, (!) not fixable, out of scope or needs a user decision</rule>
    <rule>Leave out Findings when there are none, Criteria when there is no spec, Fixes until review-fixing writes it</rule>
</rules>
