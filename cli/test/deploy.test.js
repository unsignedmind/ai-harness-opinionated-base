import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NOT_CONFIGURED, NosError } from '../src/exit-codes.js';
import { runDeploy } from '../src/deploy.js';
import { CommandProvider } from '../src/deploy/command.js';
import { FirebaseHostingProvider } from '../src/deploy/firebase-hosting.js';
import { invokeCli, makeProject, writeFile } from './helpers.js';

// A stand-in for the firebase CLI: appends argv and NOS_DEPLOY_ENV to calls.txt, prints firebase's --json shape
// for hosting:channel:deploy (exit FAKE_EXIT, default 0).
const FAKE_FIREBASE = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.txt', JSON.stringify({ args, env: process.env.NOS_DEPLOY_ENV }) + '\\n');
console.error('i  deploying...');
if (args[0] === 'hosting:channel:deploy') {
  const env = args[1];
  console.log(JSON.stringify({ status: 'success', result: { 'my-site': { site: 'my-site',
    url: 'https://my-site--' + env + '-abc123.web.app', expireTime: '2026-10-17T10:00:00Z' } } }, null, 2));
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

const BUILD = `node -e "require('fs').writeFileSync('built.txt', process.env.NOS_DEPLOY_ENV)"`;

function firebaseProject(t, deploy = {}) {
  const made = makeProject(t, {
    config: {
      deploy: { provider: 'firebase-hosting', build: BUILD, options: { cli: 'node fake-firebase.js' }, ...deploy },
    },
  });
  writeFile(made.root, 'fake-firebase.js', FAKE_FIREBASE);
  return made;
}

const calls = (root) =>
  readFileSync(path.join(root, 'calls.txt'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const code = (c) => (err) => err instanceof NosError && err.code === c;

test('runDeploy firebase-hosting: builds, then deploys a channel per env and returns its url', async (t) => {
  const { root, roots } = firebaseProject(t);

  const result = await runDeploy(roots, { env: 'Quick_7' });

  assert.equal(readFileSync(path.join(root, 'built.txt'), 'utf8'), 'quick-7', 'build first, NOS_DEPLOY_ENV set');
  assert.deepEqual(calls(root), [
    { args: ['hosting:channel:deploy', 'quick-7', '--expires', '7d', '--json'], env: 'quick-7' },
  ]);
  assert.equal(result.action, 'deploy');
  assert.equal(result.provider, 'firebase-hosting');
  assert.equal(result.env, 'quick-7');
  assert.equal(result.url, 'https://my-site--quick-7-abc123.web.app');
  assert.equal(result.expires, '2026-10-17T10:00:00Z');
  assert.match(readFileSync(result.log, 'utf8'), /deploying\.\.\./, 'stderr in the log');
});

test('runDeploy: env defaults to the run id, main outside a run', async (t) => {
  const { roots } = firebaseProject(t);
  assert.equal((await runDeploy(roots)).env, 'main');
});

test('runDeploy firebase-hosting: project and site options, remove and check commands', async (t) => {
  const { root, roots } = firebaseProject(t, {
    build: null,
    options: { cli: 'node fake-firebase.js', project: 'p-1', site: 'my-site', expires: '2w' },
  });

  await runDeploy(roots, { env: 'plan-3' });
  const removed = await runDeploy(roots, { env: 'plan-3', mode: 'remove' });
  const checked = await runDeploy(roots, { mode: 'check' });

  assert.equal(existsSync(path.join(root, 'built.txt')), false, 'no build configured');
  assert.deepEqual(
    calls(root).map((c) => c.args),
    [
      ['hosting:channel:deploy', 'plan-3', '--expires', '2w', '--project', 'p-1', '--only', 'my-site', '--json'],
      ['hosting:channel:delete', 'plan-3', '--project', 'p-1', '--site', 'my-site', '--force'],
      ['login:list'],
    ],
  );
  assert.equal(removed.action, 'deploy-remove');
  assert.equal(removed.removed, true);
  assert.equal(checked.ok, true);
});

test('runDeploy: a failing build stops before the deploy, details carry step, exit, tail and log', async (t) => {
  const { root, roots } = firebaseProject(t, { build: `node -e "console.log('vite broke'); process.exit(3)"` });

  await assert.rejects(runDeploy(roots, { env: 'x' }), (err) => {
    assert.ok(code(FAILED)(err));
    assert.equal(err.report, true);
    assert.equal(err.details.step, 'build');
    assert.equal(err.details.exit, 3);
    assert.match(err.details.tail, /vite broke/);
    return true;
  });
  assert.equal(existsSync(path.join(root, 'calls.txt')), false, 'never deployed');
});

test('runDeploy: firebase error JSON -> FAILED with its message', async (t) => {
  const { root, roots } = firebaseProject(t, { build: null });
  writeFile(root, 'fake-firebase.js', `console.log(JSON.stringify({ status: 'error', error: 'Not logged in' }))`);
  await assert.rejects(runDeploy(roots, { env: 'x' }), (err) => code(FAILED)(err) && /Not logged in/.test(err.message));
});

test('runDeploy: not configured -> NOT_CONFIGURED, unknown provider -> FAILED', async (t) => {
  const { roots } = makeProject(t);
  await assert.rejects(runDeploy(roots), code(NOT_CONFIGURED));

  const other = makeProject(t, { config: { deploy: { provider: 'netlify' } } });
  await assert.rejects(
    runDeploy(other.roots),
    (err) => code(FAILED)(err) && /firebase-hosting, command/.test(err.message),
  );
});

test('runDeploy: legacy project-commands.deploy-test runs as command provider, url = last url printed', async (t) => {
  const { roots } = makeProject(t, {
    config: {
      'project-commands': {
        'deploy-test': `node -e "console.log('see http://a.test then https://b.test/' + process.env.NOS_DEPLOY_ENV)"`,
      },
    },
  });
  const result = await runDeploy(roots, { env: 'quick-2' });
  assert.equal(result.provider, 'command');
  assert.equal(result.url, 'https://b.test/quick-2');
  assert.deepEqual(await runDeploy(roots, { env: 'quick-2', mode: 'remove' }), {
    action: 'deploy-remove',
    provider: 'command',
    env: 'quick-2',
    removed: false,
    reason: 'provider has none',
  });
});

test('FirebaseHostingProvider: refuses live, sanitizes and caps env ids, validates options', () => {
  const provider = new FirebaseHostingProvider();
  assert.throws(() => provider.envId('LIVE'), /production/);
  assert.equal(provider.envId('--Poc/My Slug--'), 'poc-my-slug');
  assert.equal(provider.envId('a'.repeat(50)).length, 40);
  assert.throws(() => provider.envId('***'), /invalid env id/);
  assert.throws(() => new FirebaseHostingProvider({ expires: 'soon' }), /expires/);
  assert.throws(() => new CommandProvider({}), /options.command/);
});

test('nos deploy: JSON result, exit 8 when not configured, 2 for --remove with --check', async (t) => {
  const { root } = firebaseProject(t);
  const ok = await invokeCli(['deploy', '--env', 'quick-9'], { cwd: root });
  assert.equal(ok.code, 0);
  assert.equal(ok.json.url, 'https://my-site--quick-9-abc123.web.app');

  assert.equal((await invokeCli(['deploy', '--remove', '--check'], { cwd: root })).code, 2);

  const bare = makeProject(t);
  const missing = await invokeCli(['deploy'], { cwd: bare.root });
  assert.equal(missing.code, 8);
  assert.equal(missing.json.action, 'deploy');
});
