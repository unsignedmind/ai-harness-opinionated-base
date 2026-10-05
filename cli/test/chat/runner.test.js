import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { agentTracker, argsFor, cleanEnv, createRunner, describeTool } from '../../src/chat/runner.js';

const ID = '3664881e-fbdd-4b6d-942d-14b1ee5ac8be';

test('args: new session by id with a name, later resumed; auto mode and no prompts by default', () => {
  const a = argsFor({ sessionId: ID, resume: false, title: 'Run the tests' });
  assert.deepEqual(a.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none']);
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

function fakeSpawn(lines, code = 0) {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.pid = 4242;
    let input = '';
    child.stdin.on('data', (c) => (input += c));
    calls.push({ bin, args, opts, input: () => input });
    setTimeout(() => {
      for (const l of lines) child.stdout.write(JSON.stringify(l) + '\n');
      child.stdout.end();
      child.exitCode = code;
      setTimeout(() => child.emit('close', code), 5);
    }, 5);
    return child;
  };
  return { fn, calls };
}

test('run: prompt on stdin in the project root, tool calls as activity, result as text', async () => {
  const { fn, calls } = fakeSpawn([
    { type: 'system', subtype: 'init', session_id: ID },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All pass.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'All pass.' },
  ]);
  const seen = [];
  const r = createRunner({ root: '/proj', spawnFn: fn, env: { CLAUDECODE: '1', PATH: 'p' } }).run({
    sessionId: ID,
    resume: false,
    prompt: 'run the tests',
    onActivity: (t) => seen.push(t),
  });
  const out = await r.done;
  assert.deepEqual(out, { created: true, stopped: false, text: 'All pass.' });
  assert.deepEqual(seen, ['Bash: npm test']);
  assert.equal(calls[0].bin, 'claude');
  assert.equal(calls[0].opts.cwd, '/proj');
  assert.equal(calls[0].opts.env.CLAUDECODE, undefined);
  assert.equal(calls[0].input(), 'run the tests');
});

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
const toolResult = (id, is_error = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'x' }] },
});

test('agents: an Agent call starts one, its own tool calls are its activity, its result ends it', () => {
  let t = 1000;
  const tr = agentTracker(() => t);
  assert.equal(tr.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } }), false);
  assert.equal(tr.line(spawnAgent('a1', { subagent_type: 'Explore', description: 'Find routes', prompt: 'long' })), true);
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
  });
  assert.equal(a2.type, 'general-purpose');
  t = 5000;
  tr.line(toolResult('a1'));
  tr.line(toolResult('a2', true));
  [a1, a2] = tr.list();
  assert.equal(a1.status, 'done');
  assert.equal(a1.activity, null);
  assert.equal(a1.endedAt, 5000);
  assert.equal(a2.status, 'failed');
  // late lines do not revive an ended agent
  assert.equal(tr.line(childTool('a1', 'Bash', { command: 'ls' })), false);
  assert.equal(tr.list()[0].tools, 2);
});

test('agents: paths in the project root show relative to it', () => {
  const tr = agentTracker(() => 0, 'D:\\proj');
  tr.line(spawnAgent('a', {}));
  tr.line(childTool('a', 'Read', { file_path: 'D:\\proj\\src\\x.ts' }));
  assert.equal(tr.list()[0].activity, 'Read: src\\x.ts');
  tr.line(childTool('a', 'Bash', { command: 'ls D:/proj/test D:/other' }));
  assert.equal(tr.list()[0].activity, 'Bash: ls test D:/other');
});

test('agents: a background agent runs past its launch result until its task ends or the run does', () => {
  const tr = agentTracker(() => 0);
  tr.line(spawnAgent('bg', { description: 'Watch', run_in_background: true }));
  tr.line(spawnAgent('bg2', { description: 'Other', run_in_background: true }));
  tr.line(toolResult('bg'));
  assert.equal(tr.list()[0].status, 'running');
  tr.line({ type: 'system', subtype: 'task_started', task_id: 'task1', tool_use_id: 'bg' });
  tr.line({ type: 'system', subtype: 'task_progress', task_id: 'task1', last_tool_name: 'Bash', usage: { tool_uses: 7 } });
  assert.equal(tr.list()[0].activity, 'Bash');
  assert.equal(tr.list()[0].tools, 7);
  tr.line({ type: 'system', subtype: 'task_notification', task_id: 'task1', status: 'failed' });
  assert.equal(tr.list()[0].status, 'failed');
  assert.equal(tr.finish(true), true);
  assert.deepEqual(tr.list().map((a) => a.status), ['failed', 'stopped']);
  assert.equal(tr.finish(false), false);
});

test('run: subagents reach onAgents, their text is not the reply, the run end closes them', async () => {
  const { fn } = fakeSpawn([
    spawnAgent('a1', { subagent_type: 'Explore', description: 'Look' }),
    { type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'text', text: 'sub says' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '' },
  ]);
  const seen = [];
  const out = await createRunner({ root: '/p', spawnFn: fn }).run({
    sessionId: ID,
    prompt: 'x',
    onAgents: (l) => seen.push(l.map((a) => a.status)),
  }).done;
  assert.equal(out.text, '(no answer)');
  assert.deepEqual(seen, [['running'], ['done']]);
});

test('run: an error result or a crash becomes an error', async () => {
  const bad = fakeSpawn(
    [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'auto mode unavailable' }],
    1,
  );
  const out = await createRunner({ root: '/p', spawnFn: bad.fn }).run({ sessionId: ID, resume: true, prompt: 'x' }).done;
  assert.equal(out.error, 'auto mode unavailable');
  const none = fakeSpawn([], 2);
  const crash = await createRunner({ root: '/p', spawnFn: none.fn }).run({ sessionId: ID, prompt: 'x' }).done;
  assert.match(crash.error, /code 2/);
});
