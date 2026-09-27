# Architecture sections

Catalog to derive a project's architecture template. Pick only sections that help an agent place, write and review code. Fewer is better. No empty or obvious sections.

## Core (always)

| Section          | Content                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview         | purpose, users, top 3 quality goals. Max 5 lines                                                                                                          |
| Stack & commands | languages, frameworks, runtime. build, test, lint, format commands                                                                                        |
| Structure        | folders and modules, one line responsibility each. Where new code goes                                                                                    |
| Rules            | checkable invariants: dependency direction, layering, purity. Per rule: `R<n>: <rule>. Why: <reason>. Enforced by: <test/lint rule or review>`            |
| Testing          | test types, tools, location, what each covers, fixtures                                                                                                   |
| Decisions        | append-only: date, decision, reason, rejected alternatives                                                                                                |
| Tech debt        | known bugs and rule violations, not fixed yet. Per entry: `TD<n>: <problem>. Where: <area>. Found: <date>, <how>. Impact: <what goes wrong>`. Removed once fixed |

## Optional

| Section       | Include when                                     | Content                                        |
| ------------- | ------------------------------------------------ | ---------------------------------------------- |
| Context       | external systems, APIs, services                 | who talks to whom, contracts, failure handling |
| Data & state  | persistence, DB, app state                       | models, owner, storage, migrations             |
| Flows         | non-trivial runtime flows, state machines        | short arrow diagrams                           |
| Interface     | public API, CLI, endpoints                       | contract, versioning, compatibility            |
| UI            | user interface                                   | component structure, styling, i18n, a11y       |
| Cross-cutting | auth, security, errors, logging, config, secrets | one line per concern                           |
| Deployment    | deployed or distributed                          | environments, pipeline, release                |
| Glossary      | ambiguous domain terms                           | term: meaning                                  |

## Profiles (start point, adjust to the project)

| Project type    | Optional sections                                           |
| --------------- | ----------------------------------------------------------- |
| web frontend    | UI, Data & state, Flows, Deployment                         |
| backend service | Context, Interface, Data & state, Cross-cutting, Deployment |
| CLI tool        | Interface, Deployment                                       |
| library         | Interface, Deployment                                       |
| mobile app      | UI, Data & state, Flows, Context, Deployment                |
| data pipeline   | Context, Data & state, Flows, Deployment                    |
| monorepo        | Context. Structure and Rules per package                    |

## Template format

```
# Architecture template
Project type: <type>. Derived from: <doc|code|intent>, <date>

## <Section>
> <what belongs here, level of detail>
```
