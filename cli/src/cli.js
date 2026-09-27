import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDomain } from './domain.js';
import { createPlan } from './plan.js';
import { setStatus } from './status.js';
import { updatePlan } from './update-plan.js';

export const USAGE = `nos - file manager for the n_os harness

Usage: nos <command> [options]

Commands:
  create-domain   Reserve a domain id and create specs/domain-<id>-<slug>/idea.md
  create-plan     Save a plan.json in a domain and create its phase folders and step files
  update-plan     Save an updated plan.json and create, move or delete phase folders and step files
  set-status      Change the status of a plan, phase or step in plan.json
  help <command>  Show detailed help for a command

Options:
  -h, --help      Show help (after a command: help for that command)

Slugs are never generated: they must be lowercase kebab-case (e.g. user-auth).
Pass "-" to read an input from stdin. Results are printed as JSON.
Exit codes: 0 ok, 1 operation failed, 2 usage error / missing input.`;

const CREATE_DOMAIN_HELP = `Usage: nos create-domain --idea <file|-> --slug <slug> [--root <dir>]

Create a new domain for an idea.

  1. Creates specs/ and specs/config.json if missing (config.json is copied from
     .claude/skills/n_os/templates/config.json when present)
  2. Takes the next domain id from specs/config.json and increases the counter
  3. Creates specs/domain-<id>-<slug>/ and saves the idea as idea.md in it

Options:
  --idea <file|->  Idea markdown file, or "-" to read it from stdin   (required)
  --slug <slug>    Slug for the folder name, lowercase kebab-case     (required)
  --root <dir>     Project root containing specs/ (default: current directory)

Example:
  nos create-domain --idea idea.md --slug user-auth
  {
    "action": "create-domain",
    "id": 1,
    "folder": "domain-1-user-auth",
    "path": "specs/domain-1-user-auth",
    "idea": "specs/domain-1-user-auth/idea.md"
  }`;

const CREATE_PLAN_HELP = `Usage: nos create-plan --domain <domain-<id>-<slug>> --plan <file|-> [--root <dir>]

Lay out the spec files for a plan in an existing domain.

  1. For every phase: takes the next phase id and creates
     specs/<domain>/phases/phase-<id>-<slug>/
  2. For every step: reserves a step id and creates an empty
     step-<id>-<slug>.md in its phase folder
  3. Fills each step's "spec-file" and saves plan.json in the domain

Nothing is written when the plan is invalid. A domain can only be planned once.

Options:
  --domain <name>  Domain folder name, e.g. domain-1-user-auth        (required)
  --plan <file|->  plan.json file, or "-" to read it from stdin       (required)
  --root <dir>     Project root containing specs/ (default: current directory)

plan.json ("phases" and "steps" may be arrays or single objects):
  {
    "name": "User auth",
    "status": "open",
    "labels": [],
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
Every phase and step needs a "slug" (lowercase kebab-case). Other fields are kept as-is.

Example:
  nos create-plan --domain domain-1-user-auth --plan plan.json
  -> specs/domain-1-user-auth/plan.json
     specs/domain-1-user-auth/phases/phase-1-data-model/step-1-user-table.md`;

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

const SET_STATUS_HELP = `Usage: nos set-status --domain <domain-<id>-<slug>> [--phase <id>] [--step <id>] --status <status> [--root <dir>]

Change a status in specs/<domain>/plan.json.

  --domain only           sets the status of the plan
  --phase <id>            sets the status of that phase
  --step <id>             sets the status of that step (ids are unique, --phase is optional;
                          when given, the step must belong to that phase)

The status must be listed in .claude/skills/n_os/templates/status.xml:
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
  'create-domain': {
    help: CREATE_DOMAIN_HELP,
    options: { idea: { type: 'string' }, slug: { type: 'string' }, root: { type: 'string' } },
    required: ['idea', 'slug'],
    execute(values, io, root) {
      const result = createDomain(root, { idea: readInput(values.idea, io), slug: values.slug });
      return {
        action: 'create-domain',
        id: result.id,
        folder: result.folder,
        path: rel(root, result.path),
        idea: rel(root, result.ideaPath),
      };
    },
  },
  'create-plan': {
    help: CREATE_PLAN_HELP,
    options: { domain: { type: 'string' }, plan: { type: 'string' }, root: { type: 'string' } },
    required: ['domain', 'plan'],
    execute(values, io, root) {
      const result = createPlan(root, { domain: values.domain, plan: readInput(values.plan, io) });
      return {
        action: 'create-plan',
        domain: result.domain,
        plan: rel(root, result.planPath),
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
      stdout.write(lookupCommand(args[0]).help + '\n');
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
