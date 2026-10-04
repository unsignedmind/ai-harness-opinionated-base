// A small specs/ tree as the loader hands it over: repo-relative path -> file text.
export const IDEA_MD = `# Idea: Dark mode

## Intent
App follows the system theme.
Second line of intent.

## Decisions
- none
`;

export const DOMAIN = {
  name: 'Dark mode theme',
  labels: ['ui', 'css'],
  'cross-cutting': false,
};

export const PLAN = {
  name: 'Dark mode',
  status: 'in-progress',
  phases: [
    {
      slug: 'tokens',
      name: 'Colour tokens',
      status: 'done',
      intent: 'Move colours into tokens.',
      'human-validation-needed': false,
      description: 'Tokens first.',
      steps: [
        {
          slug: 'extract-tokens',
          intent: 'Extract every colour.',
          status: 'done',
          'human-validation-needed': false,
          description: '- grep colours',
          'spec-file': 'specs/domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md',
        },
      ],
    },
    {
      slug: 'switch',
      name: 'Theme switch',
      status: 'in-progress',
      intent: 'Toggle theme.',
      'human-validation-needed': true,
      description: '',
      steps: [
        {
          slug: 'media-query',
          intent: 'Follow prefers-color-scheme.',
          status: 'in-review',
          'human-validation-needed': false,
          description: '',
          'spec-file': 'specs/domain-2-dark-mode/phases/phase-2-switch/step-2-media-query.md',
        },
        {
          slug: 'toggle-button',
          intent: 'Manual toggle.',
          status: 'weird',
          'human-validation-needed': true,
          description: '',
          'spec-file': '',
        },
      ],
    },
  ],
};

export const STEP_1_MD = `# Extract tokens
## Description
Pull colours out.

## Acceptance Criteria
(x) All colours are tokens
( ) Dark values exist
- [x] also a markdown checkbox

## Task List
(x) A1: Write test
(X) A2: Implement
( ) A3: Refactor

## Dev Log
( ) not counted
`;

export const fixtureFiles = (): Record<string, string> => ({
  'specs/domain-1-i18n/idea.md': '# Idea: i18n support\n\n## Intent\nTwo languages.\n',
  'specs/domain-2-dark-mode/idea.md': IDEA_MD,
  'specs/domain-2-dark-mode/domain.json': JSON.stringify(DOMAIN),
  'specs/domain-2-dark-mode/plan.json': JSON.stringify(PLAN),
  'specs/domain-2-dark-mode/phases/phase-1-tokens/step-1-extract-tokens.md': STEP_1_MD,
  'specs/domain-2-dark-mode/phases/phase-2-switch/step-2-media-query.md': '',
});

// fixtureFiles plus quick steps: one in the planned idea, one in the idea without a plan
export const QUICK_STEPS = [
  {
    slug: 'fix-contrast',
    intent: 'Raise the contrast of muted text.',
    status: 'in-progress',
    'human-validation-needed': true,
    'review-needed': true,
    description: '',
    'spec-file': 'specs/domain-2-dark-mode/quick-steps/step-4-fix-contrast.md',
  },
];

export const quickFixtureFiles = (): Record<string, string> => ({
  ...fixtureFiles(),
  'specs/domain-2-dark-mode/quick-steps/quick-steps.json': JSON.stringify(QUICK_STEPS),
  'specs/domain-2-dark-mode/quick-steps/step-4-fix-contrast.md':
    '# Fix contrast\n\n## Acceptance Criteria\n(x) Muted text is readable\n( ) Checked in dark mode\n',
  'specs/domain-1-i18n/quick-steps/quick-steps.json': JSON.stringify([
    {
      slug: 'add-german',
      intent: 'Add German.',
      status: 'open',
      'spec-file': 'specs/domain-1-i18n/quick-steps/step-5-add-german.md',
    },
  ]),
});
