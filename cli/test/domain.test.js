import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { addIdea, createDomain, listIdeaFiles, listIdeas } from '../src/domain.js';
import { makeRoots, readJson, writeFile } from './helpers.js';

const IDEA = '# User Authentication\n\nUsers log in with email and password.\n';

test('creates the first domain folder with idea-<slug>.md and advances the domain counter', (t) => {
  const roots = makeRoots(t);

  const result = createDomain(roots, { idea: IDEA, slug: 'user-auth' });

  assert.equal(result.id, 1);
  assert.equal(result.folder, 'domain-1-user-auth');
  assert.equal(result.path, path.join(roots.specs, 'domain-1-user-auth'));
  assert.equal(result.ideaFile, 'idea-user-auth.md');
  assert.equal(readFileSync(path.join(result.path, 'idea-user-auth.md'), 'utf8'), IDEA);
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].domain, 2);
});

test('saves domain.json with the name from the idea heading, no labels and not cross-cutting', (t) => {
  const roots = makeRoots(t);

  const result = createDomain(roots, { idea: '# Idea: Dark mode\n', slug: 'dark-mode' });

  assert.equal(result.domainFilePath, path.join(result.path, 'domain.json'));
  assert.deepEqual(readJson(roots.specs, 'domain-1-dark-mode/domain.json'), {
    name: 'Dark mode',
    labels: [],
    'cross-cutting': false,
  });
});

test('domain.json takes a given name and labels, the slug when the idea has no heading', (t) => {
  const roots = makeRoots(t);
  createDomain(roots, { idea: 'no heading', slug: 'user-auth', labels: ['auth', 'ui'] });
  createDomain(roots, { idea: IDEA, slug: 'named', name: 'Login', labels: 'a, b' });

  assert.deepEqual(readJson(roots.specs, 'domain-1-user-auth/domain.json').name, 'user auth');
  assert.deepEqual(readJson(roots.specs, 'domain-1-user-auth/domain.json').labels, ['auth', 'ui']);
  assert.deepEqual(readJson(roots.specs, 'domain-2-named/domain.json'), {
    name: 'Login',
    labels: ['a', 'b'],
    'cross-cutting': false,
  });
});

test('rejects an invalid label without consuming an id', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'x', labels: 'Bad Label' }), /invalid slug for label/i);
  assert.deepEqual(readdirSync(roots.specs), ['config.json'], 'no domain folder');
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].domain, 1, 'no id consumed');
});

test('assigns increasing ids to subsequent domains', (t) => {
  const roots = makeRoots(t);
  createDomain(roots, { idea: IDEA, slug: 'first' });

  const second = createDomain(roots, { idea: IDEA, slug: 'second' });

  assert.equal(second.folder, 'domain-2-second');
});

test('requires a slug and never derives one from the idea', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: IDEA }), /missing input: domain slug/i);
  assert.deepEqual(readdirSync(roots.specs), ['config.json'], 'no domain folder');
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].domain, 1, 'no id consumed');
});

test('rejects an invalid slug without consuming an id', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'User Auth!' }), /invalid slug/i);
  assert.deepEqual(readdirSync(roots.specs), ['config.json'], 'no domain folder');
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].domain, 1, 'no id consumed');
});

test('rejects a missing or blank idea without touching the filesystem', (t) => {
  const roots = makeRoots(t);
  assert.throws(() => createDomain(roots, { idea: '   ', slug: 'x' }), /missing input: idea/i);
  assert.throws(() => createDomain(roots, { slug: 'x' }), /missing input: idea/i);
  assert.deepEqual(readdirSync(roots.specs), ['config.json'], 'no domain folder');
  assert.equal(readJson(roots.specs, 'config.json')['id-counters'].domain, 1, 'no id consumed');
});

test('refuses to overwrite an existing domain folder', (t) => {
  const roots = makeRoots(t);
  mkdirSync(path.join(roots.specs, 'domain-1-user-auth'), { recursive: true });
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'user-auth' }), /already exists/);
});

test('needs the specs config of nos init and creates nothing without it', (t) => {
  const roots = makeRoots(t, { setUp: false });
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'user-auth' }), /config\.json\. Run nos init first/);
  assert.equal(existsSync(roots.specs), false);
});

// ── several ideas per domain ──

test('--idea-slug names the idea file apart from the domain slug (the area)', (t) => {
  const roots = makeRoots(t);
  const result = createDomain(roots, { idea: IDEA, slug: 'auth', ideaSlug: 'login-form' });
  assert.equal(result.folder, 'domain-1-auth');
  assert.equal(result.ideaPath, path.join(result.path, 'idea-login-form.md'));
  assert.throws(() => createDomain(roots, { idea: IDEA, slug: 'x', ideaSlug: 'Bad' }), /invalid slug for idea slug/i);
});

test('addIdea writes idea-<slug>.md into an existing domain and refuses an existing file or unknown domain', (t) => {
  const roots = makeRoots(t);
  const { folder, path: dir } = createDomain(roots, { idea: IDEA, slug: 'auth', ideaSlug: 'login' });

  const result = addIdea(roots, { domain: folder, idea: '# Reset\n', slug: 'reset' });

  assert.equal(result.ideaPath, path.join(dir, 'idea-reset.md'));
  assert.equal(readFileSync(result.ideaPath, 'utf8'), '# Reset\n');
  assert.deepEqual(listIdeaFiles(dir), ['idea-login.md', 'idea-reset.md']);
  assert.throws(() => addIdea(roots, { domain: folder, idea: 'x', slug: 'reset' }), /already exists/);
  assert.throws(() => addIdea(roots, { domain: 'domain-9-nope', idea: 'x', slug: 'a' }), /does not exist/);
  assert.throws(() => addIdea(roots, { domain: folder, idea: ' ', slug: 'a' }), /missing input: idea/i);
});

test('listIdeas: legacy idea.md first, planned by "ideas" of plan.json, a legacy plan with phases covers idea.md', (t) => {
  const roots = makeRoots(t);
  writeFile(roots.specs, 'domain-1-old/idea.md', '# Old\n');
  writeFile(roots.specs, 'domain-1-old/idea-new.md', '# Idea: New\n');
  writeFile(roots.specs, 'domain-1-old/plan.json', { name: 'Old', phases: [{ slug: 'a', steps: [] }] });
  writeFile(roots.specs, 'domain-2-hollow/idea-x.md', '# X\n');
  writeFile(roots.specs, 'domain-2-hollow/plan.json', { name: 'H', phases: [] });

  const all = listIdeas(roots);
  assert.deepEqual(
    all.map((d) => [d.domain, d.ideas.map((i) => [i.file, i.title, i.planned])]),
    [
      ['domain-1-old', [['idea.md', 'Old', true], ['idea-new.md', 'New', false]]],
      ['domain-2-hollow', [['idea-x.md', 'X', false]]],
    ],
  );
  assert.deepEqual(listIdeas(roots, { unplanned: true }).map((d) => d.ideas.map((i) => i.file)), [['idea-new.md'], ['idea-x.md']]);
  assert.deepEqual(listIdeas(roots, { domain: 'domain-2-hollow' }).map((d) => d.domain), ['domain-2-hollow']);
});
