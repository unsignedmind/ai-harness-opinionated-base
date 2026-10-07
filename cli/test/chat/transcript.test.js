import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentFile, createCondenser, MAX_FIELD, projectSlug, tailTranscript, transcriptFile } from '../../src/chat/transcript.js';
import { makeTempRoot } from '../helpers.js';

const SID = '76275042-a4c6-49b2-847a-44d65cf907b9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// lines in the shapes Claude Code 2.1.291 writes
const L = {
  prompt: { type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: 'Develop step 67' } },
  command: { type: 'user', uuid: 'u2', message: { role: 'user', content: '<command-message>nos</command-message>\n<command-name>/nos</command-name>' } },
  skill: { type: 'user', uuid: 'u3', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: …' }] } },
  reminder: { type: 'user', uuid: 'u4', isMeta: true, message: { role: 'user', content: '<system-reminder>\nbe brief\n</system-reminder>' } },
  thinking: { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] } },
  bash: { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'npm test' } }] } },
  bashOk: { type: 'user', uuid: 'u5', message: { content: [{ type: 'tool_result', tool_use_id: 'tb', content: 'ok 42' }] } },
  agent: { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'tool_use', id: 'ta', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Develop', prompt: 'long' } }] } },
  launched: { type: 'user', uuid: 'u6', message: { content: [{ type: 'tool_result', tool_use_id: 'ta', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a796 (internal)' }] }] } },
  text: { type: 'assistant', uuid: 'a4', message: { content: [{ type: 'text', text: 'Started the build.' }] } },
  notify: { type: 'user', uuid: 'u7', message: { content: '<task-notification>\n<task-id>a796</task-id>\n<status>completed</status>\n<summary>Agent "Develop" finished</summary>\n</task-notification>' } },
  handback: { type: 'user', uuid: 'u8', isMeta: true, message: { content: 'Another Claude session sent a message:\n<agent-message from="a796">\n[Subagent hand-back] done' } },
  interrupted: { type: 'user', uuid: 'u9', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  noise: { type: 'attachment', uuid: 'x1', attachment: { type: 'environment' } },
};

test('condenser: prompts, texts, tools paired with their results, agents with their agentId, notices; noise skipped', () => {
  const c = createCondenser();
  const all = [];
  const feed = (j) => {
    const out = c.feed(j);
    all.push(...out);
    return out;
  };
  for (const k of ['prompt', 'command', 'skill', 'reminder', 'thinking', 'noise']) feed(L[k]);
  assert.deepEqual(
    all.map((i) => [i.kind, i.text]),
    [
      ['user', 'Develop step 67'],
      ['user', '/nos'],
    ],
  );
  const [tool] = feed(L.bash);
  assert.deepEqual([tool.kind, tool.summary, tool.state, tool.output], ['tool', 'Bash: npm test', 'running', null]);
  const [done] = feed(L.bashOk);
  assert.equal(done.id, 'tb');
  assert.deepEqual([done.state, done.output], ['ok', 'ok 42']);

  const [agent] = feed(L.agent);
  assert.deepEqual([agent.kind, agent.type, agent.description, agent.agentId], ['agent', 'general-purpose', 'Develop', null]);
  assert.equal(feed(L.launched)[0].agentId, 'a796');
  assert.deepEqual(feed(L.text).map((i) => [i.kind, i.text]), [['text', 'Started the build.']]);
  assert.deepEqual(feed(L.notify).map((i) => i.text), ['Agent "Develop" finished (completed)']);
  assert.deepEqual(feed(L.handback).map((i) => i.text), ['Message from agent a796']);
  assert.deepEqual(feed(L.interrupted).map((i) => i.text), ['Interrupted']);
});

test('condenser: messages that came while Claude worked (queued_command): the user, Claude to a subagent, notifications', () => {
  const c = createCondenser();
  const q = (prompt, kind) => ({ type: 'attachment', uuid: `q-${kind}`, attachment: { type: 'queued_command', prompt, origin: kind && { kind } } });
  assert.deepEqual(
    c.feed(q('also run lint', 'human')).map((i) => [i.kind, i.label, i.text]),
    [['user', 'You', 'also run lint']],
  );
  assert.deepEqual(
    c.feed(q('count the lines too', 'coordinator')).map((i) => [i.label, i.text]),
    [['From Claude', 'count the lines too']],
  );
  assert.deepEqual(
    c.feed(q('<task-notification>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>')).map((i) => i.kind),
    ['notice'],
  );
});

test('condenser: a subagent transcript starts with its task; long fields are cut; failed tools', () => {
  const c = createCondenser({ rel: (t) => t.replace('D:/p/', '') });
  const [task] = c.feed({ type: 'user', uuid: 's1', isSidechain: true, message: { content: 'You run the nos ability "develop".' } });
  assert.deepEqual([task.kind, task.label], ['user', 'Task']);
  const [read] = c.feed({ type: 'assistant', uuid: 's2', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'D:/p/src/x.ts' } }] } });
  assert.equal(read.summary, 'Read: src/x.ts');
  const [failed] = c.feed({ type: 'user', uuid: 's3', message: { content: [{ type: 'tool_result', tool_use_id: 'r', is_error: true, content: 'x'.repeat(MAX_FIELD + 10) }] } });
  assert.deepEqual([failed.state, failed.output.length, failed.outputCut], ['error', MAX_FIELD, true]);
});

test('paths: project slug, main transcript (also in another project folder), subagent by agentId or tool id', (t) => {
  const home = makeTempRoot(t);
  const env = { CLAUDE_CONFIG_DIR: home };
  assert.equal(projectSlug('D:\\development\\repos\\moodo-poc'), 'D--development-repos-moodo-poc');
  const own = path.join(home, 'projects', projectSlug('D:\\proj'), `${SID}.jsonl`);
  assert.equal(transcriptFile('D:\\proj', SID, env), own);
  mkdirSync(path.join(home, 'projects', 'other'), { recursive: true });
  writeFileSync(path.join(home, 'projects', 'other', `${SID}.jsonl`), '');
  assert.equal(transcriptFile('D:\\proj', SID, env), path.join(home, 'projects', 'other', `${SID}.jsonl`));
  assert.equal(transcriptFile('D:\\proj', '../etc', env), null);

  const main = path.join(home, 'projects', 'other', `${SID}.jsonl`);
  const sub = path.join(home, 'projects', 'other', SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, 'agent-a796.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_1' }));
  assert.equal(agentFile(main, { agentId: 'a796' }), path.join(sub, 'agent-a796.jsonl'));
  assert.equal(agentFile(main, { toolUseId: 'toolu_1' }), path.join(sub, 'agent-a796.jsonl'));
  assert.equal(agentFile(main, { toolUseId: 'nope' }), null);
  assert.equal(agentFile(main, { agentId: '../x' }), null);
});

test('tail: the last steps first (cut to the limit), then new and changed steps; a partial line waits', async (t) => {
  const dir = makeTempRoot(t);
  const file = path.join(dir, 't.jsonl');
  const line = (j) => JSON.stringify(j) + '\n';
  writeFileSync(file, line(L.prompt) + line(L.text) + line(L.bash));
  const got = [];
  const tail = tailTranscript(file, (items, info) => got.push({ items, info }), { limit: 2, pollMs: 20 });
  t.after(() => tail.close());
  assert.deepEqual(got[0].info, { initial: true, truncated: true });
  assert.deepEqual(got[0].items.map((i) => i.kind), ['text', 'tool']);

  const result = line(L.bashOk);
  appendFileSync(file, result.slice(0, 20));
  await sleep(60);
  assert.equal(got.length, 1);
  appendFileSync(file, result.slice(20));
  await sleep(60);
  assert.deepEqual(got[1].items.map((i) => [i.id, i.state]), [['tb', 'ok']]);
  assert.equal(got[1].info.initial, false);
});

test('tail: a file that is not there yet starts empty, its steps come when it is written', async (t) => {
  const dir = makeTempRoot(t);
  const file = path.join(dir, 'later.jsonl');
  const got = [];
  const tail = tailTranscript(file, (items, info) => got.push({ items, info }), { pollMs: 20 });
  t.after(() => tail.close());
  assert.deepEqual(got, [{ items: [], info: { initial: true, truncated: false } }]);
  writeFileSync(file, JSON.stringify(L.prompt) + '\n');
  await sleep(80);
  assert.deepEqual(got[1].items.map((i) => i.text), ['Develop step 67']);
});

const WT = 'D:/proj/.claude/worktrees/quick-68';
const jsonl = (j) => JSON.stringify(j) + '\n';
// a fake claude dir with the main project's and a worktree's project folder
function claudeHome(t) {
  const home = makeTempRoot(t);
  const projects = path.join(home, 'projects');
  const main = path.join(projects, projectSlug('D:/proj'), `${SID}.jsonl`);
  const wt = path.join(projects, projectSlug(WT), `${SID}.jsonl`);
  mkdirSync(path.dirname(main), { recursive: true });
  mkdirSync(path.dirname(wt), { recursive: true });
  return { env: { CLAUDE_CONFIG_DIR: home }, main, wt };
}
const age = (f, s) => utimesSync(f, new Date(Date.now() - s * 1000), new Date(Date.now() - s * 1000));

test('paths: the newest copy of a session transcript wins, the own folder on a tie', (t) => {
  const { env, main, wt } = claudeHome(t);
  writeFileSync(main, '');
  writeFileSync(wt, '');
  age(main, 10);
  assert.equal(transcriptFile('D:/proj', SID, env), wt);
  age(wt, 20);
  assert.equal(transcriptFile('D:/proj', SID, env), main);
  const at = new Date(Date.now() - 5000);
  utimesSync(main, at, at);
  utimesSync(wt, at, at);
  assert.equal(transcriptFile('D:/proj', SID, env), main);
});

for (const watch of [false, true])
  test(`tail (watch: ${watch}): a transcript Claude Code moves to another project folder (Enter/ExitWorktree) is followed, its steps come again as an initial list`, async (t) => {
    const { env, main, wt } = claudeHome(t);
    writeFileSync(main, jsonl(L.prompt));
    const got = [];
    const tail = tailTranscript(main, (items, info) => got.push({ items, info }), {
      pollMs: 20,
      watch,
      locate: () => transcriptFile('D:/proj', SID, env),
    });
    t.after(() => tail.close());
    appendFileSync(main, jsonl(L.bash));
    await sleep(80);
    assert.deepEqual(
      got.map((g) => g.info.initial),
      [true, false],
    );

    // EnterWorktree: the file moves to the worktree's folder, then grows there
    renameSync(main, wt);
    appendFileSync(wt, jsonl(L.bashOk));
    await sleep(200);
    const entered = got.slice(2);
    assert.equal(entered.length, 1);
    assert.deepEqual(entered[0].info, { initial: true, truncated: false });
    assert.deepEqual(
      entered[0].items.map((i) => [i.id, i.state ?? null]),
      [
        ['u1', null],
        ['tb', 'ok'],
      ],
    );
    appendFileSync(wt, jsonl(L.text));
    await sleep(80);
    assert.deepEqual(
      got.at(-1).items.map((i) => i.id),
      ['a4-0'],
    );
    assert.equal(got.at(-1).info.initial, false);

    // ExitWorktree: back to the main folder
    const n = got.length;
    renameSync(wt, main);
    appendFileSync(main, jsonl(L.notify));
    await sleep(200);
    assert.equal(got.length, n + 1);
    assert.equal(got.at(-1).info.initial, true);
    assert.deepEqual(
      got.at(-1).items.map((i) => i.id),
      ['u1', 'tb', 'a4-0', 'u7'],
    );
  });

test('tail: a copy newer than the followed file (a move that failed halfway, copy then delete) is switched to once', async (t) => {
  const { env, main, wt } = claudeHome(t);
  writeFileSync(main, jsonl(L.prompt));
  age(main, 10);
  const got = [];
  const tail = tailTranscript(main, (items, info) => got.push({ items, info }), {
    pollMs: 20,
    locateMs: 40,
    locate: () => transcriptFile('D:/proj', SID, env),
  });
  t.after(() => tail.close());
  // the copy appears while the old file is still there; later the old one goes
  writeFileSync(wt, jsonl(L.prompt) + jsonl(L.text));
  await sleep(200);
  assert.deepEqual(
    got.map((g) => [g.info.initial, g.items.map((i) => i.id)]),
    [
      [true, ['u1']],
      [true, ['u1', 'a4-0']],
    ],
  );
  rmSync(main);
  appendFileSync(wt, jsonl(L.bash));
  await sleep(200);
  assert.deepEqual(
    got.slice(2).map((g) => [g.info.initial, g.items.map((i) => i.id)]),
    [[false, ['tb']]],
  );
});

test('tail: an older copy elsewhere, a locate that throws or finds nothing: the tail keeps following its file', async (t) => {
  const { main, wt } = claudeHome(t);
  writeFileSync(main, jsonl(L.prompt));
  writeFileSync(wt, jsonl(L.prompt) + jsonl(L.text));
  age(wt, 10);
  const answers = [wt, null, 'boom', path.join(path.dirname(wt), 'gone.jsonl')];
  let asked = 0;
  const got = [];
  const tail = tailTranscript(main, (items, info) => got.push({ items, info }), {
    pollMs: 20,
    locateMs: 20,
    locate: () => {
      const a = answers[asked++ % answers.length];
      if (a === 'boom') throw new Error('boom');
      return a;
    },
  });
  t.after(() => tail.close());
  await sleep(150);
  assert.ok(asked >= 4);
  appendFileSync(main, jsonl(L.bash));
  await sleep(80);
  assert.deepEqual(
    got.map((g) => [g.info.initial, g.items.map((i) => i.id)]),
    [
      [true, ['u1']],
      [false, ['tb']],
    ],
  );
});

test('tail: a missing file asks locate every 4th poll only', async (t) => {
  const dir = makeTempRoot(t);
  let asked = 0;
  const tail = tailTranscript(path.join(dir, 'x.jsonl'), () => {}, { pollMs: 20, locate: () => (asked++, null) });
  t.after(() => tail.close());
  await sleep(250);
  tail.close();
  assert.ok(asked >= 1 && asked <= 4, `asked ${asked}`);
});

test('tail: a subagent transcript moves with its session folder and is followed', async (t) => {
  const { env, main, wt } = claudeHome(t);
  const a = path.dirname(main);
  const b = path.dirname(wt);
  mkdirSync(path.join(a, SID, 'subagents'), { recursive: true });
  writeFileSync(main, jsonl(L.prompt));
  const task = { type: 'user', uuid: 's1', isSidechain: true, message: { content: 'Do the step' } };
  writeFileSync(path.join(a, SID, 'subagents', 'agent-a796.jsonl'), jsonl(task));
  const locate = () => agentFile(transcriptFile('D:/proj', SID, env), { agentId: 'a796' });
  const got = [];
  // no fs.watch: on Windows it would hold the session folder (the move fails with EPERM)
  const tail = tailTranscript(locate(), (items, info) => got.push({ items, info }), {
    pollMs: 20,
    locate,
    watch: false,
  });
  t.after(() => tail.close());
  assert.deepEqual(
    got[0].items.map((i) => i.label),
    ['Task'],
  );

  renameSync(main, wt);
  renameSync(path.join(a, SID), path.join(b, SID));
  appendFileSync(path.join(b, SID, 'subagents', 'agent-a796.jsonl'), jsonl({ ...L.text, isSidechain: true }));
  await sleep(200);
  assert.equal(got.at(-1).info.initial, true);
  assert.deepEqual(
    got.at(-1).items.map((i) => i.id),
    ['s1', 'a4-0'],
  );
});

test('tail: while the file is where it was, nothing is re-sent', async (t) => {
  const dir = makeTempRoot(t);
  const file = path.join(dir, 't.jsonl');
  writeFileSync(file, JSON.stringify(L.prompt) + '\n');
  let asked = 0;
  const got = [];
  const tail = tailTranscript(file, (items, info) => got.push({ items, info }), {
    pollMs: 20,
    locateMs: 20,
    locate: () => (asked++, file),
  });
  t.after(() => tail.close());
  await sleep(80);
  assert.ok(asked > 0);
  assert.equal(got.length, 1);
});
