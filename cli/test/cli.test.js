import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportError, run } from '../src/cli.js';
import { CONFLICT, FAILED, HELD, NosError } from '../src/exit-codes.js';
import { slash, SPECS_DIR } from '../src/roots.js';
import { makeProject, makeTempRoot, writeFile, readJson, STATUS_XML } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nos.js');

// home defaults to <cwd>/.claude/skills/nos: the home guard stays quiet and tests put templates there.
// env is empty so a NOS_SPECS_ROOT of the shell never leaks in.
function invoke(args, { cwd, stdin = '', env = {}, home } = {}) {
  let out = '';
  let err = '';
  const code = run(args, {
    cwd,
    env,
    home: home ?? path.join(path.resolve(cwd), '.claude', 'skills', 'nos'),
    readStdin: () => stdin,
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
  });
  return { code, out, err, get json() { return JSON.parse(out); } };
}

// absolute path of a file in the specs root, as the CLI prints it
const at = (root, rel) => slash(path.join(root, SPECS_DIR, rel));

const PLAN = {
  name: 'Auth',
  status: 'open',
  labels: [],
  phases: [{ slug: 'setup', name: 'Setup', status: 'open', intent: '', description: '', steps: [{ slug: 'init-repo', intent: 'Init repo', status: 'open', description: '', 'spec-file': '' }] }],
};

test('init creates nos.config.json, .specs/ and its config.json and prints absolute paths', (t) => {
  const root = makeTempRoot(t);

  const { code, json, err } = invoke(['init'], { cwd: root });

  assert.equal(err, '');
  assert.equal(code, 0);
  assert.equal(json.action, 'init');
  assert.equal(json.main, slash(root));
  assert.equal(json.specs, slash(path.join(root, SPECS_DIR)));
  for (const file of [slash(path.join(root, 'nos.config.json')), at(root, ''), at(root, 'config.json'), at(root, '.gitignore')]) {
    assert.ok(json.created.includes(file.replace(/\/$/, '')), `created lists ${file}`);
  }
  assert.deepEqual(json.existing, []);
  assert.deepEqual(json.gitignoreAdded, [], 'no project .gitignore without git');
  assert.deepEqual(readJson(root, '.specs/config.json'), { 'id-counters': { domain: 1, phase: 1, step: 1 } });
  assert.equal(readJson(root, 'nos.config.json').specs.dir, '.specs');
});

test('init leaves an existing config.json untouched', (t) => {
  const root = makeTempRoot(t);
  const existing = { 'id-counters': { domain: 9, phase: 2, step: 3 }, chat: { port: 4700 } };
  writeFile(root, '.specs/config.json', existing);

  const { code, json } = invoke(['init'], { cwd: root });

  assert.equal(code, 0);
  assert.ok(json.existing.includes(at(root, 'config.json')));
  assert.deepEqual(readJson(root, '.specs/config.json'), existing);
});

test('roots prints home, work, main, specs and inWorktree with forward slashes', (t) => {
  const { root } = makeProject(t);
  const home = path.join(root, '.claude', 'skills', 'nos');

  const { code, json, err } = invoke(['roots'], { cwd: path.join(root), home });

  assert.equal(err, '');
  assert.equal(code, 0);
  assert.deepEqual(json, {
    action: 'roots',
    home: slash(home),
    work: slash(root),
    main: slash(root),
    specs: slash(path.join(root, SPECS_DIR)),
    inWorktree: false,
  });
  assert.ok(!json.specs.includes('\\'));
});

test('NOS_SPECS_ROOT sets the work root, --root wins over it', (t) => {
  const { root } = makeProject(t);
  const other = makeProject(t).root;
  const elsewhere = makeTempRoot(t);

  assert.equal(invoke(['roots'], { cwd: elsewhere, env: { NOS_SPECS_ROOT: root } }).json.work, slash(root));
  assert.equal(invoke(['roots', '--root', other], { cwd: elsewhere, env: { NOS_SPECS_ROOT: root } }).json.work, slash(other));
});

test('the home guard warns on stderr when this nos is not the project nos, the result still comes', (t) => {
  const { root } = makeProject(t);
  writeFile(root, '.claude/skills/nos/SKILL.md', '# nos');
  const otherHome = path.join(makeTempRoot(t), 'nos');

  const { code, json, err } = invoke(['roots'], { cwd: root, home: otherHome });

  assert.equal(code, 0);
  assert.equal(json.main, slash(root));
  assert.match(err, /warning: running .*but the project's nos is/);
  assert.equal(err.trim().split('\n').length, 1, 'one warning line per invocation');
});

test('create-domain reads the idea from a file and prints JSON', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, 'my-idea.md', '# Search Feature\n');

  const { code, json, err } = invoke(['create-domain', '--idea', 'my-idea.md', '--slug', 'search'], { cwd: root });

  assert.equal(err, '');
  assert.equal(code, 0);
  assert.deepEqual(json, {
    action: 'create-domain',
    id: 1,
    folder: 'domain-1-search',
    path: at(root, 'domain-1-search'),
    idea: at(root, 'domain-1-search/idea.md'),
    domain: at(root, 'domain-1-search/domain.json'),
  });
  assert.ok(existsSync(path.join(root, '.specs/domain-1-search/idea.md')));
  assert.deepEqual(readJson(root, '.specs/domain-1-search/domain.json'), {
    name: 'Search Feature',
    labels: [],
    'cross-cutting': false,
  });
});

test('create-domain takes --name and comma separated --labels', (t) => {
  const root = makeTempRoot(t);
  const { code } = invoke(
    ['create-domain', '--idea', '-', '--slug', 'search', '--name', 'Search', '--labels', 'ui, api'],
    { cwd: root, stdin: '# Idea: Search everything\n' },
  );
  assert.equal(code, 0);
  assert.deepEqual(readJson(root, '.specs/domain-1-search/domain.json'), {
    name: 'Search',
    labels: ['ui', 'api'],
    'cross-cutting': false,
  });
});

test('create-domain reads the idea from stdin with --idea -', (t) => {
  const root = makeTempRoot(t);
  const { code, json } = invoke(['create-domain', '--idea', '-', '--slug', 'from-stdin'], { cwd: root, stdin: '# Whatever\n' });
  assert.equal(code, 0);
  assert.equal(json.folder, 'domain-1-from-stdin');
});

test('--root overrides the working directory', (t) => {
  const root = makeTempRoot(t);
  const elsewhere = makeTempRoot(t);
  const { code } = invoke(['create-domain', '--idea', '-', '--slug', 'x', '--root', root], { cwd: elsewhere, stdin: '# X' });
  assert.equal(code, 0);
  assert.ok(existsSync(path.join(root, '.specs/domain-1-x')));
  assert.equal(existsSync(path.join(elsewhere, '.specs')), false);
});

test('create-plan reads plan.json from a file and prints created structure', (t) => {
  const root = makeTempRoot(t);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth'], { cwd: root, stdin: '# Auth' });
  writeFile(root, 'plan.json', PLAN);

  const { code, json, err } = invoke(['create-plan', '--domain', 'domain-1-auth', '--plan', 'plan.json'], { cwd: root });

  assert.equal(err, '');
  assert.equal(code, 0);
  assert.deepEqual(json, {
    action: 'create-plan',
    domain: 'domain-1-auth',
    plan: at(root, 'domain-1-auth/plan.json'),
    phases: [
      {
        id: 1,
        folder: 'phase-1-setup',
        path: at(root, 'domain-1-auth/phases/phase-1-setup'),
        steps: [{ id: 1, file: 'step-1-init-repo.md', path: at(root, 'domain-1-auth/phases/phase-1-setup/step-1-init-repo.md') }],
      },
    ],
  });
  assert.equal(readJson(root, '.specs/config.json')['id-counters'].step, 2);
});

test('create-plan reads plan.json from stdin', (t) => {
  const root = makeTempRoot(t);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth'], { cwd: root, stdin: '# Auth' });
  const { code } = invoke(['create-plan', '--domain', 'domain-1-auth', '--plan', '-'], { cwd: root, stdin: JSON.stringify(PLAN) });
  assert.equal(code, 0);
});

test('missing required options exit with code 2 and a request for the input', (t) => {
  const root = makeTempRoot(t);
  const a = invoke(['create-domain', '--slug', 'x'], { cwd: root });
  assert.equal(a.code, 2);
  assert.match(a.err, /missing input: --idea/i);

  const s = invoke(['create-domain', '--idea', '-'], { cwd: root, stdin: '# Idea' });
  assert.equal(s.code, 2);
  assert.match(s.err, /missing input: --slug/i);
  assert.equal(existsSync(path.join(root, '.specs')), false);

  const b = invoke(['create-plan', '--domain', 'domain-1-x'], { cwd: root });
  assert.equal(b.code, 2);
  assert.match(b.err, /missing input: --plan/i);
});

test('create-plan --hollow saves an empty plan and needs no --plan', (t) => {
  const root = makeTempRoot(t);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth', '--name', 'User auth'], { cwd: root, stdin: '# Auth' });

  const { code, json, err } = invoke(['create-plan', '--domain', 'domain-1-auth', '--hollow'], { cwd: root });

  assert.equal(err, '');
  assert.equal(code, 0);
  assert.deepEqual(json, {
    action: 'create-plan',
    domain: 'domain-1-auth',
    plan: at(root, 'domain-1-auth/plan.json'),
    hollow: true,
    phases: [],
  });
  assert.deepEqual(readJson(root, '.specs/domain-1-auth/plan.json'), { name: 'User auth', status: 'open', phases: [] });

  const again = invoke(['create-plan', '--domain', 'domain-1-auth', '--hollow'], { cwd: root });
  assert.equal(again.code, 1);
  assert.match(again.err, /already has a plan\.json/);

  const filled = invoke(['create-plan', '--domain', 'domain-1-auth', '--plan', '-'], { cwd: root, stdin: JSON.stringify(PLAN) });
  assert.equal(filled.code, 0);
  assert.equal(filled.json.phases.length, 1);
});

test('create-plan --hollow with --plan is a usage error', (t) => {
  const root = makeTempRoot(t);
  const { code, err } = invoke(['create-plan', '--domain', 'domain-1-x', '--hollow', '--plan', '-'], { cwd: root });
  assert.equal(code, 2);
  assert.match(err, /--hollow takes no --plan/);
});

test('an unreadable input file is reported as an error', (t) => {
  const root = makeTempRoot(t);
  const { code, err } = invoke(['create-domain', '--idea', 'nope.md', '--slug', 'x'], { cwd: root });
  assert.equal(code, 1);
  assert.match(err, /nope\.md/);
});

test('an invalid slug is rejected, not rewritten', (t) => {
  const root = makeTempRoot(t);
  const { code, err } = invoke(['create-domain', '--idea', '-', '--slug', 'My Idea'], { cwd: root, stdin: '# Idea' });
  assert.equal(code, 1);
  assert.match(err, /invalid slug/i);
});

test('domain errors exit with code 1 and print to stderr', (t) => {
  const root = makeTempRoot(t);
  const { code, out, err } = invoke(['create-plan', '--domain', 'domain-5-ghost', '--plan', '-'], { cwd: root, stdin: JSON.stringify(PLAN) });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /does not exist/);
});

test('unknown commands and options exit with code 2', (t) => {
  const root = makeTempRoot(t);
  assert.equal(invoke(['explode'], { cwd: root }).code, 2);
  assert.equal(invoke(['create-domain', '--bogus'], { cwd: root }).code, 2);
});

test('general help lists every command and points to command help', () => {
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const { code, out, err } = invoke(args, { cwd: '.' });
    assert.equal(code, 0);
    assert.equal(err, '');
    assert.match(out, /init/);
    assert.match(out, /roots/);
    assert.match(out, /Exit codes: .*3 conflict/s);
    assert.match(out, /create-domain/);
    assert.match(out, /create-plan/);
    assert.match(out, /create-quick-step/);
    assert.match(out, /help <command>/);
  }
});

test('help <command> and <command> --help print the detailed command help', (t) => {
  const root = makeTempRoot(t);
  for (const name of ['init', 'roots', 'create-domain', 'create-plan', 'create-quick-step', 'set-status']) {
    const viaHelp = invoke(['help', name], { cwd: root });
    assert.equal(viaHelp.code, 0);
    assert.match(viaHelp.out, new RegExp(`Usage: nos ${name}`));
    assert.match(viaHelp.out, /Example/);

    for (const flag of ['--help', '-h']) {
      const viaFlag = invoke([name, flag], { cwd: root });
      assert.equal(viaFlag.code, 0);
      assert.equal(viaFlag.out, viaHelp.out);
    }
  }
});

test('create-domain help documents its options and the result', () => {
  const { out } = invoke(['help', 'create-domain'], { cwd: '.' });
  for (const text of ['--idea', '--slug', '--name', '--labels', '--root', 'idea.md', 'domain.json', 'cross-cutting', 'config.json', 'kebab-case']) {
    assert.ok(out.includes(text), `missing "${text}"`);
  }
});

test('create-plan help documents the expected plan.json shape', () => {
  const { out } = invoke(['help', 'create-plan'], { cwd: '.' });
  for (const text of ['--domain', '--plan', '"slug"', '"phases"', '"steps"', '"spec-file"', 'step-<id>-<slug>.md']) {
    assert.ok(out.includes(text), `missing ${text}`);
  }
});

test('--help wins over other arguments and never touches the filesystem', (t) => {
  const root = makeTempRoot(t);
  const { code } = invoke(['create-domain', '--idea', '-', '--slug', 'x', '--help'], { cwd: root, stdin: '# Idea' });
  assert.equal(code, 0);
  assert.equal(existsSync(path.join(root, '.specs')), false);
});

test('help for an unknown command is a usage error', () => {
  const { code, err } = invoke(['help', 'explode'], { cwd: '.' });
  assert.equal(code, 2);
  assert.match(err, /unknown command "explode"/i);
});

test('usage errors point to the help of the failing command', (t) => {
  const root = makeTempRoot(t);
  const { err } = invoke(['create-plan', '--domain', 'domain-1-x'], { cwd: root });
  assert.match(err, /nos help create-plan/);
});

test('bin/nos.js runs as an executable', (t) => {
  const root = makeTempRoot(t);
  const res = spawnSync(process.execPath, [BIN, 'create-domain', '--idea', '-', '--slug', 'via-binary'], { cwd: root, input: '# Via Binary', encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).folder, 'domain-1-via-binary');
});

test('set-status changes a step status and prints the change', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, '.claude/skills/nos/templates/status.xml', STATUS_XML);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth'], { cwd: root, stdin: '# Auth' });
  invoke(['create-plan', '--domain', 'domain-1-auth', '--plan', '-'], { cwd: root, stdin: JSON.stringify(PLAN) });

  const { code, json, err } = invoke(['set-status', '--domain', 'domain-1-auth', '--step', '1', '--status', 'implemented'], { cwd: root });

  assert.equal(err, '');
  assert.equal(code, 0);
  assert.deepEqual(json, {
    action: 'set-status',
    domain: 'domain-1-auth',
    plan: at(root, 'domain-1-auth/plan.json'),
    target: 'step',
    id: 1,
    slug: 'init-repo',
    previous: 'open',
    status: 'implemented',
  });
  assert.equal(readJson(root, '.specs/domain-1-auth/plan.json').phases[0].steps[0].status, 'implemented');
});

test('set-status reports an invalid status as a failed operation', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, '.claude/skills/nos/templates/status.xml', STATUS_XML);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth'], { cwd: root, stdin: '# Auth' });
  invoke(['create-plan', '--domain', 'domain-1-auth', '--plan', '-'], { cwd: root, stdin: JSON.stringify(PLAN) });

  const { code, err } = invoke(['set-status', '--domain', 'domain-1-auth', '--status', 'finished'], { cwd: root });

  assert.equal(code, 1);
  assert.match(err, /valid statuses: open, in-progress, done/i);
});

test('set-status without --status is a usage error', (t) => {
  const root = makeTempRoot(t);
  const { code, err } = invoke(['set-status', '--domain', 'domain-1-auth'], { cwd: root });
  assert.equal(code, 2);
  assert.match(err, /missing input: --status/i);
  assert.match(err, /nos help set-status/);
});

test('update-plan reads the updated plan and supports --dry-run', (t) => {
  const root = makeTempRoot(t);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth'], { cwd: root, stdin: '# Auth' });
  invoke(['create-plan', '--domain', 'domain-1-auth', '--plan', '-'], { cwd: root, stdin: JSON.stringify(PLAN) });
  const plan = readJson(root, '.specs/domain-1-auth/plan.json');
  plan.phases[0].steps.push({ slug: 'add-ci', status: 'open', 'spec-file': '' });
  writeFile(root, 'plan.json', plan);

  const dry = invoke(['update-plan', '--domain', 'domain-1-auth', '--plan', 'plan.json', '--dry-run'], { cwd: root });
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.json.dryRun, true);
  assert.equal(existsSync(path.join(root, '.specs/domain-1-auth/phases/phase-1-setup/step-2-add-ci.md')), false);

  const { code, json, err } = invoke(['update-plan', '--domain', 'domain-1-auth', '--plan', 'plan.json'], { cwd: root });
  assert.equal(err, '');
  assert.equal(code, 0);
  assert.deepEqual(json, {
    action: 'update-plan',
    domain: 'domain-1-auth',
    plan: at(root, 'domain-1-auth/plan.json'),
    dryRun: false,
    created: { phases: [], steps: [{ id: 2, path: at(root, 'domain-1-auth/phases/phase-1-setup/step-2-add-ci.md'), specFile: 'domain-1-auth/phases/phase-1-setup/step-2-add-ci.md' }] },
    moved: [],
    deleted: { phases: [], steps: [] },
  });
  assert.ok(existsSync(path.join(root, '.specs/domain-1-auth/phases/phase-1-setup/step-2-add-ci.md')));
});

test('create-quick-step reads the step from stdin and set-status finds it', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, '.claude/skills/nos/templates/status.xml', STATUS_XML);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth'], { cwd: root, stdin: '# Auth' });

  const created = invoke(['create-quick-step', '--domain', 'domain-1-auth', '--step', '-'], {
    cwd: root,
    stdin: JSON.stringify({ slug: 'fix-typo', intent: 'Fix the typo' }),
  });

  assert.equal(created.err, '');
  assert.equal(created.code, 0);
  assert.deepEqual(created.json, {
    action: 'create-quick-step',
    domain: 'domain-1-auth',
    id: 1,
    path: at(root, 'domain-1-auth/quick-steps/step-1-fix-typo.md'),
    'quick-steps': at(root, 'domain-1-auth/quick-steps/quick-steps.json'),
  });

  const set = invoke(['set-status', '--domain', 'domain-1-auth', '--step', '1', '--status', 'in-review'], { cwd: root });
  assert.equal(set.code, 0);
  assert.deepEqual(set.json, {
    action: 'set-status',
    domain: 'domain-1-auth',
    plan: at(root, 'domain-1-auth/quick-steps/quick-steps.json'),
    target: 'step',
    id: 1,
    slug: 'fix-typo',
    previous: 'open',
    status: 'in-review',
    quick: true,
  });
});

test('create-quick-step without --step is a usage error', (t) => {
  const root = makeTempRoot(t);
  const { code, err } = invoke(['create-quick-step', '--domain', 'domain-1-auth'], { cwd: root });
  assert.equal(code, 2);
  assert.match(err, /missing input: --step/i);
});

test('a NosError with code 3-7 exits with its code and prints { action, error, exit, details } on stdout', () => {
  let out = '';
  let err = '';
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } };

  const code = reportError('run-start', new NosError(HELD, 'run quick-7 is held', { holder: { pid: 1 } }), io);

  assert.equal(code, HELD);
  assert.deepEqual(JSON.parse(out), { action: 'run-start', error: 'run quick-7 is held', exit: HELD, details: { holder: { pid: 1 } } });
  assert.equal(err, 'nos: run quick-7 is held\n');

  out = '';
  assert.equal(reportError('x', new NosError(CONFLICT, 'conflict'), io), CONFLICT);
  assert.equal(JSON.parse(out).exit, CONFLICT);
  out = '';
  assert.equal(reportError('x', new NosError(FAILED, 'failed'), io), FAILED);
  assert.equal(reportError('x', new Error('plain'), io), FAILED);
  assert.equal(out, '', 'codes 1 and plain errors print nothing on stdout');
});

test('a legacy spec-file makes the command fail with exit 1 and the migration hint', (t) => {
  const root = makeTempRoot(t);
  writeFile(root, '.claude/skills/nos/templates/status.xml', STATUS_XML);
  invoke(['create-domain', '--idea', '-', '--slug', 'auth'], { cwd: root, stdin: '# Auth' });
  invoke(['create-quick-step', '--domain', 'domain-1-auth', '--step', '-'], { cwd: root, stdin: JSON.stringify({ slug: 'a', intent: 'A' }) });
  const file = '.specs/domain-1-auth/quick-steps/quick-steps.json';
  const steps = readJson(root, file);
  assert.equal(steps[0]['spec-file'], 'domain-1-auth/quick-steps/step-1-a.md', 'spec-file is relative to the specs root');
  steps[0]['spec-file'] = `specs/${steps[0]['spec-file']}`;
  writeFile(root, file, steps);

  const { code, out, err } = invoke(['set-status', '--domain', 'domain-1-auth', '--step', '1', '--status', 'implemented'], { cwd: root });

  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /legacy spec-file.*run the migration/);
});
