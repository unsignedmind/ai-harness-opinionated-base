import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CHAT_HELP } from './chat/commands.js';
import { ensureSpecs } from './config.js';
import { createDomain } from './domain.js';
import { createPlan } from './plan.js';
import { createQuickStep } from './quick-step.js';
import { setStatus } from './status.js';
import { updatePlan } from './update-plan.js';

export const USAGE = `nos - file manager for the nos harness

Usage: nos <command> [options]

Commands:
  init               Create specs/ and specs/config.json if missing
  create-domain      Reserve a domain id and create specs/domain-<id>-<slug>/idea.md
  create-plan        Save a plan.json in a domain and create its phase folders and step files
                     (--hollow: an empty plan.json, promotes the domain unplanned)
  update-plan        Save an updated plan.json and create, move or delete phase folders and step files
  create-quick-step  Add a quick step (no plan) to specs/<domain>/quick-steps/
  set-status         Change the status of a plan, phase, step or quick step
  chat <command>     Local chat with this Claude Code session (nos chat --help)
  help <command>     Show detailed help for a command

Options:
  -h, --help         Show help (after a command: help for that command)

Slugs are never generated: they must be lowercase kebab-case (e.g. user-auth).
Pass "-" to read an input from stdin. Results are printed as JSON.
Exit codes: 0 ok, 1 operation failed, 2 usage error / missing input.`;

const INIT_HELP = `Usage: nos init [--root <dir>]

Set up the specs folder of a project.

  1. Creates specs/ if missing
  2. Creates specs/config.json if missing (copied from
     .claude/skills/nos/templates/config.json when present)
  An existing config.json is never changed.

Options:
  --root <dir>     Project root containing specs/ (default: current directory)

Example:
  nos init
  {
    "action": "init",
    "specs": "specs",
    "config": "specs/config.json",
    "createdConfig": true
  }`;

const CREATE_DOMAIN_HELP =`Usage: nos create-domain --idea <file|-> --slug <slug> [--name <name>] [--labels <a,b>] [--root <dir>]

Create a new domain for an idea.

  1. Creates specs/ and specs/config.json if missing (config.json is copied from
     .claude/skills/nos/templates/config.json when present)
  2. Takes the next domain id from specs/config.json and increases the counter
  3. Creates specs/domain-<id>-<slug>/ and saves the idea as idea.md in it
  4. Saves domain.json in it: { "name", "labels", "cross-cutting": false }

Options:
  --idea <file|->  Idea markdown file, or "-" to read it from stdin   (required)
  --slug <slug>    Slug for the folder name, lowercase kebab-case     (required)
  --name <name>    Domain name (default: first "# " heading of the idea without "Idea:")
  --labels <a,b>   Comma separated labels, lowercase kebab-case (default: none)
  --root <dir>     Project root containing specs/ (default: current directory)

Example:
  nos create-domain --idea idea.md --slug user-auth --labels auth,ui
  {
    "action": "create-domain",
    "id": 1,
    "folder": "domain-1-user-auth",
    "path": "specs/domain-1-user-auth",
    "idea": "specs/domain-1-user-auth/idea.md",
    "domain": "specs/domain-1-user-auth/domain.json"
  }`;

const CREATE_PLAN_HELP = `Usage: nos create-plan --domain <domain-<id>-<slug>> (--plan <file|-> | --hollow) [--root <dir>]

Lay out the spec files for a plan in an existing domain.

  1. For every phase: takes the next phase id and creates
     specs/<domain>/phases/phase-<id>-<slug>/
  2. For every step: reserves a step id and creates an empty
     step-<id>-<slug>.md in its phase folder
  3. Fills each step's "spec-file" and saves plan.json in the domain

Nothing is written when the plan is invalid. A domain can only be planned once.

--hollow promotes a domain without planning it: it saves only
  { "name": <domain.json name>, "status": "open", "phases": [] }
and creates no folders. A hollow plan (no phases, no phase folders) is filled
by a later create-plan with --plan.

Options:
  --domain <name>  Domain folder name, e.g. domain-1-user-auth        (required)
  --plan <file|->  plan.json file, or "-" to read it from stdin       (required unless --hollow)
  --hollow         Save an empty plan.json instead (no --plan)
  --root <dir>     Project root containing specs/ (default: current directory)

plan.json ("phases" and "steps" may be arrays or single objects):
  {
    "name": "User auth",
    "status": "open",
    "phases": [{
      "slug": "data-model",
      "name": "Data model",
      "status": "open",
      "intent": "",
      "description": "",
      "steps": [{
        "slug": "user-table",
        "intent": "Create the user table",
        "status": "open",
        "description": "",
        "spec-file": ""
      }]
    }]
  }
Every phase and step needs a "slug" (lowercase kebab-case). Other fields are kept as-is,
except "labels": labels belong to the domain (domain.json) and are dropped.

Example:
  nos create-plan --domain domain-1-user-auth --plan plan.json
  -> specs/domain-1-user-auth/plan.json
     specs/domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md

  nos create-plan --domain domain-2-dark-mode --hollow
  -> specs/domain-2-dark-mode/plan.json  { "name": "Dark mode", "status": "open", "phases": [] }`;

const UPDATE_PLAN_HELP = `Usage: nos update-plan --domain <domain-<id>-<slug>> --plan <file|-> [--dry-run] [--force] [--root <dir>]

Replace the plan of a domain with an updated plan.json and bring the folders in line with it.
Start from the current specs/<domain>/plan.json and edit it:

  - Existing steps are recognised by their "spec-file". Keep it unchanged.
  - A step with an empty "spec-file" is new: it gets a new id and an empty step file.
  - Existing phases are recognised by their "slug" (phase-<id>-<slug>). A phase with a
    new slug is created with a new id; renaming a phase slug therefore replaces the phase.
  - A kept step whose phase or slug changed is moved/renamed and keeps its id and content.
  - Phase folders and step files that are no longer in the plan are deleted.

Nothing is written when the plan is invalid. Deleting a step file that has content, or a
phase folder containing other files, is refused unless --force is given.
Ids of deleted phases and steps are never reused.

Options:
  --domain <name>  Domain folder name, e.g. domain-1-user-auth        (required)
  --plan <file|->  Updated plan.json file, or "-" to read it from stdin (required)
  --dry-run        Print the changes without writing anything
  --force          Also delete step files and phase folders that have content
  --root <dir>     Project root containing specs/ (default: current directory)

Example:
  nos update-plan --domain domain-1-user-auth --plan plan.json
  {
    "action": "update-plan",
    "domain": "domain-1-user-auth",
    "plan": "specs/domain-1-user-auth/plan.json",
    "dryRun": false,
    "created": {
      "phases": [{ "id": 3, "folder": "phase-3-sessions", "path": "specs/.../phase-3-sessions" }],
      "steps": [{ "id": 5, "path": "specs/.../phase-3-sessions/step-5-session-store.md" }]
    },
    "moved": [],
    "deleted": {
      "phases": [],
      "steps": [{ "id": 2, "path": "specs/.../phase-1-data-model/step-2-hashing.md", "empty": true }]
    }
  }`;

const CREATE_QUICK_STEP_HELP = `Usage: nos create-quick-step --domain <domain-<id>-<slug>> --step <file|-> [--root <dir>]

Add a quick step to an existing domain. A quick step is a single step outside any plan.

  1. Reserves a step id (same counter as plan steps, so ids stay unique)
  2. Creates specs/<domain>/quick-steps/step-<id>-<slug>.md (empty)
  3. Appends the step to specs/<domain>/quick-steps/quick-steps.json with its "spec-file"
     filled and status "open"

Options:
  --domain <name>  Domain folder name, e.g. domain-1-user-auth        (required)
  --step <file|->  Quick step JSON file, or "-" to read it from stdin (required)
  --root <dir>     Project root containing specs/ (default: current directory)

Quick step JSON ("slug" and "intent" required, other fields are kept as-is):
  {
    "slug": "fix-login-typo",
    "intent": "Fix the typo on the login button",
    "description": "",
    "human-validation-needed": false,
    "review-needed": true
  }

Example:
  nos create-quick-step --domain domain-1-user-auth --step -
  {
    "action": "create-quick-step",
    "domain": "domain-1-user-auth",
    "id": 7,
    "path": "specs/domain-1-user-auth/quick-steps/step-7-fix-login-typo.md",
    "quick-steps": "specs/domain-1-user-auth/quick-steps/quick-steps.json"
  }`;

const SET_STATUS_HELP = `Usage: nos set-status --domain <domain-<id>-<slug>> [--phase <id>] [--step <id>] --status <status> [--root <dir>]

Change a status in specs/<domain>/plan.json or of a quick step.

  --domain only           sets the status of the plan
  --phase <id>            sets the status of that phase
  --step <id>             sets the status of that step (ids are unique, --phase is optional;
                          when given, the step must belong to that phase)
                          without --phase, a step not in plan.json is looked up in
                          specs/<domain>/quick-steps/quick-steps.json ("quick": true in the result)

The status must be listed in .claude/skills/nos/templates/status.xml:
<plans> for the plan, <phases> for phases, <steps> for steps.
Only the "status" field is changed; the rest of plan.json is kept as-is.

Options:
  --domain <name>    Domain folder name, e.g. domain-1-user-auth      (required)
  --status <status>  New status, e.g. in-review                       (required)
  --phase <id>       Phase id (the number in phase-<id>-<slug>)
  --step <id>        Step id (the number in step-<id>-<slug>.md)
  --root <dir>       Project root containing specs/ (default: current directory)

Example:
  nos set-status --domain domain-1-user-auth --step 3 --status in-review
  {
    "action": "set-status",
    "domain": "domain-1-user-auth",
    "plan": "specs/domain-1-user-auth/plan.json",
    "target": "step",
    "id": 3,
    "slug": "login-endpoint",
    "previous": "implemented",
    "status": "in-review"
  }`;

const COMMANDS = {
  init: {
    help: INIT_HELP,
    options: { root: { type: 'string' } },
    required: [],
    execute(values, io, root) {
      const result = ensureSpecs(root);
      return {
        action: 'init',
        specs: rel(root, result.specsDir),
        config: rel(root, result.configPath),
        createdConfig: result.createdConfig,
      };
    },
  },
  'create-domain': {
    help: CREATE_DOMAIN_HELP,
    options: {
      idea: { type: 'string' },
      slug: { type: 'string' },
      name: { type: 'string' },
      labels: { type: 'string' },
      root: { type: 'string' },
    },
    required: ['idea', 'slug'],
    execute(values, io, root) {
      const result = createDomain(root, {
        idea: readInput(values.idea, io),
        slug: values.slug,
        name: values.name,
        labels: values.labels,
      });
      return {
        action: 'create-domain',
        id: result.id,
        folder: result.folder,
        path: rel(root, result.path),
        idea: rel(root, result.ideaPath),
        domain: rel(root, result.domainFilePath),
      };
    },
  },
  'create-plan': {
    help: CREATE_PLAN_HELP,
    options: {
      domain: { type: 'string' },
      plan: { type: 'string' },
      hollow: { type: 'boolean' },
      root: { type: 'string' },
    },
    required: ['domain'],
    execute(values, io, root) {
      const hollow = values.hollow ?? false;
      if (hollow && values.plan) throw new UsageError('--hollow takes no --plan', 'create-plan');
      if (!hollow && !values.plan) {
        throw new UsageError('Missing input: --plan. Please provide it and retry', 'create-plan');
      }
      const result = createPlan(root, {
        domain: values.domain,
        ...(hollow ? { hollow } : { plan: readInput(values.plan, io) }),
      });
      return {
        action: 'create-plan',
        domain: result.domain,
        plan: rel(root, result.planPath),
        ...(result.hollow && { hollow: true }),
        phases: result.phases.map((phase) => ({
          id: phase.id,
          folder: phase.folder,
          path: rel(root, phase.path),
          steps: phase.steps.map((step) => ({ id: step.id, file: step.file, path: rel(root, step.path) })),
        })),
      };
    },
  },
  'update-plan': {
    help: UPDATE_PLAN_HELP,
    options: {
      domain: { type: 'string' },
      plan: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      root: { type: 'string' },
    },
    required: ['domain', 'plan'],
    execute(values, io, root) {
      const result = updatePlan(root, {
        domain: values.domain,
        plan: readInput(values.plan, io),
        dryRun: values['dry-run'] ?? false,
        force: values.force ?? false,
      });
      return {
        action: 'update-plan',
        domain: result.domain,
        plan: rel(root, result.planPath),
        dryRun: result.dryRun,
        created: result.created,
        moved: result.moved,
        deleted: result.deleted,
      };
    },
  },
  'create-quick-step': {
    help: CREATE_QUICK_STEP_HELP,
    options: { domain: { type: 'string' }, step: { type: 'string' }, root: { type: 'string' } },
    required: ['domain', 'step'],
    execute(values, io, root) {
      const result = createQuickStep(root, { domain: values.domain, step: readInput(values.step, io) });
      return {
        action: 'create-quick-step',
        domain: result.domain,
        id: result.id,
        path: rel(root, result.path),
        'quick-steps': rel(root, result.quickStepsPath),
      };
    },
  },
  'set-status': {
    help: SET_STATUS_HELP,
    options: {
      domain: { type: 'string' },
      phase: { type: 'string' },
      step: { type: 'string' },
      status: { type: 'string' },
      root: { type: 'string' },
    },
    required: ['domain', 'status'],
    execute(values, io, root) {
      const result = setStatus(root, values);
      return {
        action: 'set-status',
        domain: result.domain,
        plan: rel(root, result.planPath),
        target: result.target,
        ...(result.id !== undefined && { id: result.id }),
        ...(result.slug !== undefined && { slug: result.slug }),
        previous: result.previous ?? null,
        status: result.status,
        ...(result.quick && { quick: true }),
      };
    },
  },
};

class UsageError extends Error {
  constructor(message, commandName) {
    super(message);
    this.hint = commandName ? `nos help ${commandName}` : 'nos --help';
  }
}

const isHelpFlag = (arg) => arg === '--help' || arg === '-h';

function lookupCommand(name) {
  const command = COMMANDS[name];
  if (!command) throw new UsageError(`Unknown command "${name}"`);
  return command;
}

const rel = (root, target) => path.relative(root, target).split(path.sep).join('/');

function readInput(source, io) {
  if (source === '-') return io.readStdin();
  const file = path.resolve(io.cwd, source);
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read input file ${file}: ${err.message}`);
  }
}

function parseCommand(name, command, args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: command.options, strict: true, allowPositionals: false });
  } catch (err) {
    throw new UsageError(err.message, name);
  }
  const missing = command.required.find((name) => !parsed.values[name]);
  if (missing) {
    throw new UsageError(`Missing input: --${missing}. Please provide it and retry`, name);
  }
  return parsed.values;
}

export function run(argv, io = {}) {
  const {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    readStdin = () => readFileSync(0, 'utf8'),
  } = io;
  const [name, ...args] = argv;

  try {
    if (!name || isHelpFlag(name) || (name === 'help' && args.length === 0)) {
      stdout.write(USAGE + '\n');
      return 0;
    }
    if (name === 'help') {
      stdout.write((args[0] === 'chat' ? CHAT_HELP : lookupCommand(args[0]).help) + '\n');
      return 0;
    }

    const command = lookupCommand(name);
    if (args.some(isHelpFlag)) {
      stdout.write(command.help + '\n');
      return 0;
    }
    const values = parseCommand(name, command, args);
    const root = path.resolve(cwd, values.root ?? '.');
    const result = command.execute(values, { cwd, readStdin }, root);
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    stderr.write(`nos: ${err.message}\n`);
    if (err instanceof UsageError) {
      stderr.write(`Run "${err.hint}" for usage.\n`);
      return 2;
    }
    return 1;
  }
}
