# Test types

Catalog for the architect task TESTS. A type is missing only when it would catch real problems in this project.

| Group        | Covers                                                        | Adds value when                                                  | Tooling examples                                                    |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| unit logic   | pure functions, rules, parsing, state transitions             | logic with branches, calculations, parsing                       | project test runner: vitest, jest, pytest, JUnit                    |
| unit ui      | components render and react to input                          | components with state, conditions, events                        | Testing Library                                                     |
| unit a11y    | roles, accessible names, labels of rendered components        | any user interface. Contrast and focus need a real browser → e2e | axe-core: vitest-axe, jest-axe                                      |
| integration  | modules together, adapters to storage, network, SDKs          | boundaries: persistence, APIs, SDK wrappers                      | runner + fakes or emulators: msw, Firebase emulator, Testcontainers |
| e2e          | critical user flows in a real browser or app, page-level a11y | multi-screen user flows                                          | Playwright (+ @axe-core/playwright), Cypress                        |
| architecture | dependency and structure rules                                | layers or modules that must not mix                              | see below                                                           |

## Architecture rules (inspiration, adapt to the real structure)

Only for folders and layers that exist. Each rule mirrors a Rule in the architecture doc.

1. Module and layer separation
   - no circular dependencies
   - dependencies point inwards: domain logic knows no UI, state or infrastructure
   - modules use each other only through their public entry (index)
   - SDKs and API clients only inside infrastructure. UI calls services, not infrastructure
2. Design patterns
   - global state only through the store's public API. UI does not use the state library directly
   - presentational components have no side effects: no fetching, routing, storage, global state
   - domain logic is framework-free: no UI framework imports, no JSX files
3. Legacy and conventions
   - deprecated libraries are not imported
   - styles use design tokens: no raw colors, no inline styles

## Enforcement (pick per rule)

| Mechanism        | Best for                                              | Examples                                                                     |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| lint rule        | import and syntax bans, feedback while typing         | eslint no-restricted-imports, no-restricted-syntax, eslint-plugin-boundaries |
| dependency graph | cycles, layer direction, entry points                 | dependency-cruiser, import-linter (Python)                                   |
| test             | everything else: file conventions, rules across files | tsarch, ArchUnit (Java), NetArchTest (.NET)                                  |

## Pitfalls

- ESLint flat config: a later block setting no-restricted-imports or no-restricted-syntax replaces the earlier options for those files, it does not merge. Compose rule sets
- tsarch sees only project files, not node_modules. Package rules need an import scanner, e.g. ts.preProcessFile
- Exclude test and story files from architecture rules
- Count type-only imports too, e.g. dependency-cruiser tsPreCompilationDeps
