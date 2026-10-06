import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  agentTracker,
  argsFor,
  cleanEnv,
  createRunner,
  describeTool,
  isRunCall,
  runOf,
} from '../../src/chat/runner.js';

const ID = '3664881e-fbdd-4b6d-942d-14b1ee5ac8be';
const tick = () => new Promise((r) => setTimeout(r, 5));

test('args: stream-json in and out, new session by id with a name, later resumed; auto mode, no prompts', () => {
  const a = argsFor({ sessionId: ID, resume: false, title: 'Run the tests' });
  assert.deepEqual(a.slice(0, 8), [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompts',
    'none',
  ]);
  assert.ok(a.join(' ').includes(`--permission-mode auto --session-id ${ID} --name nos chat: Run the tests`));
  const b = argsFor({ sessionId: ID, resume: true, mode: 'acceptEdits', model: 'sonnet' });
  assert.ok(b.join(' ').includes(`--permission-mode acceptEdits --resume ${ID} --model sonnet`));
  assert.ok(!b.includes('--name'));
  assert.ok(argsFor({ sessionId: ID, mode: 'nonsense' }).join(' ').includes('--permission-mode auto'));
  assert.throws(() => argsFor({ sessionId: 'x; rm -rf /' }));
});

test('env: the variables of the calling Claude Code session are dropped', () => {
  const env = cleanEnv({
    PATH: 'p',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 's',
    CLAUDE_CODE_MESSAGING_TOKEN: 't',
    ANTHROPIC_MODEL: 'm',
  });
  assert.deepEqual(env, { PATH: 'p', ANTHROPIC_MODEL: 'm' });
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'Bash: npm test');
});

// a Claude Code process the test drives: emit(lines) writes stdout, exit(code) closes it
function fakeProc() {
  const calls = [];
  let child;
  const fn = (bin, args, opts) => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.pid = 4242;
    let input = '';
    let ended = false;
    child.stdin.on('data', (c) => (input += c));
    child.stdin.on('finish', () => (ended = true));
    calls.push({ bin, args, opts, input: () => input, ended: () => ended });
    return child;
  };
  const emit = async (...lines) => {
    for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
    await tick();
  };
  const exit = async (code = 0, stderr = '') => {
    if (stderr) child.stderr.write(stderr);
    await tick();
    child.exitCode = code;
    child.emit('close', code);
    await tick();
  };
  return { fn, calls, emit, exit };
}

const init = { type: 'system', subtype: 'init', session_id: ID };
const text = (t, parent = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'text', text: t }] },
});
const result = (r, is_error = false) => ({
  type: 'result',
  subtype: is_error ? 'error_during_execution' : 'success',
  is_error,
  result: r,
});

function recorder() {
  const seen = { texts: [], errors: [], busy: [], activity: [], agents: [], exits: [], started: 0 };
  return {
    seen,
    cb: {
      onStarted: () => seen.started++,
      onBusy: (b) => seen.busy.push(b),
      onText: (t) => seen.texts.push(t),
      onError: (t) => seen.errors.push(t),
      onActivity: (t) => seen.activity.push(t),
      onAgents: (l) => seen.agents.push(l.map((a) => a.status)),
      onExit: (r) => seen.exits.push(r),
    },
  };
}

test('open: one process, messages as stream-json on stdin, each text block a reply at once, no repeat by the result', async () => {
  const p = fakeProc();
  const { seen, cb } = recorder();
  const proc = createRunner({ root: '/proj', spawnFn: p.fn, env: { CLAUDECODE: '1', PATH: 'p' } }).open({
    sessionId: ID,
    resume: false,
    ...cb,
  });
  assert.equal(proc.send('run the tests'), true);
  assert.equal(proc.busy, true);
  assert.deepEqual(JSON.parse(p.calls[0].input()), {
    type: 'user',
    message: { role: 'user', content: 'run the tests' },
  });
  assert.equal(p.calls[0].bin, 'claude');
  assert.equal(p.calls[0].opts.cwd, '/proj');
  assert.equal(p.calls[0].opts.env.CLAUDECODE, undefined);

  await p.emit(
    init,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    text('Running them.'),
  );
  assert.deepEqual(seen.texts, ['Running them.']);
  await p.emit(text('All pass.'), result('All pass.'));
  assert.deepEqual(seen.texts, ['Running them.', 'All pass.']);
  assert.deepEqual(seen.activity, ['Bash: npm test']);
  assert.equal(seen.started, 1);
  assert.equal(proc.busy, false);
  assert.deepEqual(seen.busy, [true, false]);

  // the next message goes into the same process
  proc.send('and lint');
  assert.equal(p.calls.length, 1);
  assert.match(p.calls[0].input(), /and lint/);
  // a turn without text block: the result is the reply; an empty result is none
  await p.emit(init, result('Lint is clean.'), init, result(''));
  assert.deepEqual(seen.texts.at(-1), 'Lint is clean.');
  assert.equal(seen.texts.length, 3);

  proc.close();
  await tick();
  assert.equal(p.calls[0].ended(), true);
  assert.equal(proc.send('too late'), false);
  await p.exit(0);
  assert.deepEqual(seen.exits, [{ stopped: false, error: null }]);
});

test('open: an error result, a crash in a turn and a missing claude are errors; a stop is no error', async () => {
  const a = fakeProc();
  const r1 = recorder();
  const p1 = createRunner({ root: '/p', spawnFn: a.fn }).open({ sessionId: ID, resume: true, ...r1.cb });
  p1.send('x');
  await a.emit(init, result('auto mode unavailable', true));
  assert.deepEqual(r1.seen.errors, ['auto mode unavailable']);
  p1.send('y');
  await a.exit(2, 'boom');
  assert.deepEqual(r1.seen.exits, [{ stopped: false, error: 'boom' }]);

  const b = fakeProc();
  const r2 = recorder();
  const p2 = createRunner({ root: '/p', spawnFn: b.fn }).open({ sessionId: ID, ...r2.cb });
  p2.send('x');
  p2.stop();
  await b.exit(1);
  assert.deepEqual(r2.seen.exits, [{ stopped: true, error: null }]);

  const missing = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.stdin = new PassThrough();
    setTimeout(() => c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })), 1);
    return c;
  };
  const r3 = recorder();
  createRunner({ root: '/p', spawnFn: missing })
    .open({ sessionId: ID, ...r3.cb })
    .send('x');
  await tick();
  assert.match(r3.seen.exits[0].error, /was not found on the host/);
});

// ---- subagents ----

const spawnAgent = (id, input) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name: 'Agent', input }] },
});
const childTool = (parent, name, input) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id: `${parent}-${name}`, name, input }] },
});
const toolResult = (id, content = 'x', is_error = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] },
});
const launched = (id, agentId) =>
  toolResult(id, [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)` }]);
const task = (subtype, extra) => ({ type: 'system', subtype, ...extra });

test('agents: a foreground Agent call starts one, its own tool calls are its activity, its result ends it', () => {
  let t = 1000;
  const tr = agentTracker(() => t);
  assert.equal(
    tr.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } }),
    false,
  );
  assert.equal(
    tr.line(spawnAgent('a1', { subagent_type: 'Explore', description: 'Find routes', prompt: 'long' })),
    true,
  );
  tr.line(spawnAgent('a2', { description: 'Write tests' }));
  tr.line(childTool('a1', 'Grep', { pattern: 'route' }));
  tr.line(childTool('a1', 'Read', { file_path: 'src/route.ts' }));
  let [a1, a2] = tr.list();
  assert.deepEqual(a1, {
    id: 'a1',
    type: 'Explore',
    description: 'Find routes',
    status: 'running',
    activity: 'Read: src/route.ts',
    tools: 2,
    startedAt: 1000,
    endedAt: null,
    agentId: null,
  });
  assert.equal(a2.type, 'general-purpose');
  t = 5000;
  tr.line(toolResult('a1'));
  tr.line(toolResult('a2', 'nope', true));
  [a1, a2] = tr.list();
  assert.equal(a1.status, 'done');
  assert.equal(a1.activity, null);
  assert.equal(a1.endedAt, 5000);
  assert.equal(a2.status, 'failed');
  // late lines do not revive an ended agent
  assert.equal(tr.line(childTool('a1', 'Bash', { command: 'ls' })), false);
  assert.equal(tr.list()[0].tools, 2);
  assert.equal(tr.running(), false);
});

test('agents: paths in the project root show relative to it', () => {
  const tr = agentTracker(() => 0, 'D:\\proj');
  tr.line(spawnAgent('a', {}));
  tr.line(childTool('a', 'Read', { file_path: 'D:\\proj\\src\\x.ts' }));
  assert.equal(tr.list()[0].activity, 'Read: src\\x.ts');
  tr.line(childTool('a', 'Bash', { command: 'ls D:/proj/test D:/other' }));
  assert.equal(tr.list()[0].activity, 'Bash: ls test D:/other');
});

// the lines of a real run (claude 2.1.291): a background agent, its Bash calls backgrounded as
// shell tasks of their own, its end as task_notification
test('agents: a background agent runs past its launch until its task_notification; shell tasks are no agents', () => {
  const tr = agentTracker(() => 0);
  tr.line(spawnAgent('tu_a', { subagent_type: 'general-purpose', description: 'sleeper' }));
  tr.line(
    task('task_started', { task_id: 'a1d6', tool_use_id: 'tu_a', task_type: 'local_agent', description: 'sleeper' }),
  );
  tr.line(launched('tu_a', 'a1d6'));
  assert.equal(tr.list()[0].status, 'running');
  tr.line(childTool('tu_a', 'Bash', { command: 'node wait.js' }));
  tr.line(
    task('task_progress', {
      task_id: 'a1d6',
      tool_use_id: 'tu_a',
      description: 'Running Wait',
      usage: { tool_uses: 3 },
    }),
  );
  tr.line(
    task('task_started', { task_id: 'bx', tool_use_id: 'tu_bash', task_type: 'local_bash', description: 'Wait' }),
  );
  tr.line(task('task_notification', { task_id: 'bx', tool_use_id: 'tu_bash', status: 'completed' }));
  assert.equal(tr.list().length, 1);
  assert.deepEqual(
    [tr.list()[0].status, tr.list()[0].activity, tr.list()[0].tools],
    ['running', 'Bash: node wait.js', 3],
  );
  assert.equal(tr.running(), true);
  tr.line(task('task_notification', { task_id: 'a1d6', tool_use_id: 'tu_a', status: 'completed' }));
  assert.equal(tr.list()[0].status, 'done');
  assert.equal(tr.running(), false);
});

test('agents: SendMessage resumes an ended agent; an agent of an earlier process shows up by task_started', () => {
  const tr = agentTracker(() => 0);
  tr.line(spawnAgent('tu_a', { description: 'Develop' }));
  tr.line(launched('tu_a', 'a796'));
  tr.line(task('task_notification', { task_id: 'a796', status: 'stopped' }));
  assert.equal(tr.list()[0].status, 'stopped');
  tr.line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 's1', name: 'SendMessage', input: { to: 'a796' } }] },
  });
  assert.equal(tr.list()[0].status, 'running');
  // unknown so far: added from the task event
  tr.line(
    task('task_started', {
      task_id: 'b222',
      tool_use_id: 'tu_old',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'Older',
    }),
  );
  assert.deepEqual(
    tr.list().map((a) => [a.id, a.type, a.status]),
    [
      ['tu_a', 'general-purpose', 'running'],
      ['tu_old', 'Explore', 'running'],
    ],
  );
  // the process ends: what still runs went down with it
  assert.equal(tr.finish(), true);
  assert.deepEqual(
    tr.list().map((a) => a.status),
    ['stopped', 'stopped'],
  );
  assert.equal(tr.finish(), false);
});

// as it happened live: a new process resumes the develop agent of an earlier one by SendMessage;
// the agent's events and tool calls come under the SendMessage id, its "Resuming agent" ack is no end
test('agents: an agent resumed by SendMessage in a new process runs until its notification', () => {
  const tr = agentTracker(() => 0);
  tr.line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_send', name: 'SendMessage', input: { to: 'a796' } }] },
  });
  tr.line(
    task('task_started', {
      task_id: 'a796',
      tool_use_id: 'tu_send',
      task_type: 'local_agent',
      description: 'Develop quick step 67',
    }),
  );
  tr.line(
    toolResult('tu_send', [
      { type: 'text', text: '{"success":true,"message":"Resuming agent a796","resumedAgentId":"a796"}' },
    ]),
  );
  assert.equal(tr.list()[0].status, 'running');
  tr.line(childTool('tu_send', 'Bash', { command: 'npm test' }));
  assert.deepEqual([tr.list()[0].activity, tr.list()[0].tools], ['Bash: npm test', 1]);
  // resumed once more within the same process: same entry, now also under the new id
  tr.line(task('task_notification', { task_id: 'a796', tool_use_id: 'tu_send', status: 'completed' }));
  tr.line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_send2', name: 'SendMessage', input: { to: 'a796' } }] },
  });
  tr.line(toolResult('tu_send2', 'Resuming agent a796'));
  tr.line(childTool('tu_send2', 'Edit', { file_path: 'src/x.ts' }));
  assert.equal(tr.list().length, 1);
  assert.deepEqual([tr.list()[0].status, tr.list()[0].activity], ['running', 'Edit: src/x.ts']);
});

test('open: subagents reach onAgents, their text is no reply, the process end stops them', async () => {
  const p = fakeProc();
  const { seen, cb } = recorder();
  const proc = createRunner({ root: '/p', spawnFn: p.fn }).open({ sessionId: ID, ...cb });
  proc.send('x');
  await p.emit(init, spawnAgent('tu_a', { subagent_type: 'Explore', description: 'Look' }), launched('tu_a', 'ag1'));
  await p.emit(text('Started it.'), result('Started it.'), text('sub says', 'tu_a'));
  assert.deepEqual(seen.texts, ['Started it.']);
  assert.equal(proc.busy, false);
  assert.equal(proc.agentsRunning, true);
  await p.exit(0);
  assert.deepEqual(seen.agents, [['running'], ['stopped']]);
});

test('env: NOS_SPECS_ROOT and NOS_RUN_TOKEN never reach a tab session', () => {
  assert.deepEqual(cleanEnv({ PATH: 'p', NOS_SPECS_ROOT: 'D:/x', NOS_RUN_TOKEN: 't', NOS_CHAT_PORT: '1' }), {
    PATH: 'p',
    NOS_CHAT_PORT: '1',
  });
});

// ---- the nos run of a tab, from the tool results (D-8) ----

const START = {
  action: 'run-start',
  run: {
    kind: 'quick',
    id: 'quick-7',
    domain: 'domain-3-x',
    branch: 'quick-7',
    worktree: 'D:/p/.claude/worktrees/quick-7',
    phase: 'develop',
  },
  token: 'secret-token',
  roots: {
    home: 'D:/p/.claude/skills/nos',
    work: 'D:/p/.claude/worktrees/quick-7',
    main: 'D:/p',
    specs: 'D:/p/.specs',
  },
  enter: 'D:/p/.claude/worktrees/quick-7',
};
const RUN = {
  kind: 'quick',
  id: 'quick-7',
  domain: 'domain-3-x',
  branch: 'quick-7',
  worktree: 'D:/p/.claude/worktrees/quick-7',
};

test('runOf: run-start gives the run without the token; cleanup and abandon give null; anything else undefined', () => {
  // a string, single line or pretty-printed between other output
  assert.deepEqual(runOf(JSON.stringify(START)), RUN);
  assert.deepEqual(runOf(`nos: warning: something\n${JSON.stringify(START, null, 2)}\nInstalled.`), RUN);
  // a content array with text items
  assert.deepEqual(
    runOf([
      { type: 'text', text: 'ok' },
      { type: 'text', text: JSON.stringify(START, null, 2) },
    ]),
    RUN,
  );
  assert.ok(!JSON.stringify(runOf(JSON.stringify(START))).includes('secret'));
  assert.equal(runOf(JSON.stringify({ action: 'run-cleanup', run: 'quick-7', removed: true })), null);
  assert.equal(runOf(JSON.stringify({ action: 'run-abandon', run: 'quick-7' }, null, 2)), null);
  // the last one wins
  assert.equal(runOf(JSON.stringify(START) + '\n' + JSON.stringify({ action: 'run-abandon' })), null);
  // no run result
  assert.equal(runOf('All 42 tests pass.'), undefined);
  assert.equal(runOf(JSON.stringify({ action: 'run-finish', merged: true })), undefined);
  assert.equal(runOf(''), undefined);
  assert.equal(runOf(undefined), undefined);
  assert.equal(runOf([{ type: 'image', source: {} }]), undefined);
  // an error report (held, domain running) is no start; partial or broken JSON is ignored
  assert.equal(runOf(JSON.stringify({ action: 'run-start', error: 'lock held', exit: 4, details: {} })), undefined);
  assert.equal(runOf(JSON.stringify({ action: 'run-cleanup', error: 'inside the worktree', exit: 1 })), undefined);
  assert.equal(runOf(JSON.stringify(START, null, 2).slice(0, 120)), undefined);
  assert.equal(runOf('{"action": "run-start", "run": {"kind": "quick", '), undefined);
  // braces in strings and stray braces around do not confuse it
  const odd = { ...START, run: { ...START.run, branch: 'a}{"b' } };
  assert.deepEqual(runOf(`if (x) { y } ${JSON.stringify(odd)} {`), { ...RUN, branch: 'a}{"b' });
});

test('isRunCall: a shell call of nos run start|cleanup|abandon, by alias or by path', () => {
  assert.equal(isRunCall('Bash', { command: 'node D:/x/cli/bin/nos.js run start --domain d --quick 7' }), true);
  assert.equal(isRunCall('Bash', { command: 'nos run cleanup --token t' }), true);
  assert.equal(isRunCall('PowerShell', { command: 'node "D:/x/nos/cli/bin/nos.js" run abandon --token t' }), true);
  assert.equal(isRunCall('Bash', { command: 'node D:/x/cli/bin/nos.js run finish --token t' }), false);
  assert.equal(isRunCall('Bash', { command: 'cat docs/run start.md' }), false);
  assert.equal(isRunCall('Read', { file_path: 'nos run start' }), false);
  assert.equal(isRunCall('Bash', {}), false);
});

test('open: only the results of the session own nos run calls count; cleanup clears; errors, reads, subagents do not', async () => {
  const p = fakeProc();
  const runs = [];
  createRunner({ root: '/proj', spawnFn: p.fn }).open({ sessionId: ID, resume: false, onRun: (r) => runs.push(r) });
  const call = (id, name, input, parent = null) => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
  const result = (id, content, extra = {}, parent = null) => ({
    type: 'user',
    parent_tool_use_id: parent,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
  });
  const nos = (args) => ({ command: 'node D:/x/cli/bin/nos.js ' + args });
  const json = JSON.stringify(START, null, 2);
  await p.emit(
    init,
    // a Read or a cat of a file holding run-start JSON: no run
    call('t1', 'Read', { file_path: 'D:/x/fixture.json' }),
    result('t1', json),
    call('t2', 'Bash', { command: 'cat fixture.json' }),
    result('t2', json),
    // a subagent running nos run start: no run
    call('t3', 'Bash', nos('run start --domain d --quick 7'), 'toolu_agent'),
    result('t3', json, {}, 'toolu_agent'),
    // a failed start (held): no run
    call('t4', 'Bash', nos('run start --domain d --quick 7')),
    result('t4', JSON.stringify({ action: 'run-start', error: 'held', exit: 4 }), { is_error: true }),
    // the session's own start
    call('t5', 'Bash', nos('run start --domain d --quick 7')),
    result('t5', 'Installing…\n' + json),
    // its result counts once
    result('t5', JSON.stringify({ action: 'run-cleanup' })),
    { type: 'user', message: { role: 'user', content: 'a plain user message {"action":"run-start"}' } },
    call('t6', 'Bash', nos('run cleanup --token t')),
    result('t6', [{ type: 'text', text: JSON.stringify({ action: 'run-cleanup', run: 'quick-7' }) }]),
  );
  assert.deepEqual(runs, [RUN, null]);
});
