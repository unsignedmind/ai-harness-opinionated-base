import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { argsFor, cleanEnv, createRunner, describeTool } from '../../src/chat/runner.js';

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
