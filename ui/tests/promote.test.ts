// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { promoteHandler } from '../src/serve-specs';

// tests run inside ui/, the CLI sits next to it
const CLI = resolve('../cli/bin/nos.js');
let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

const nos = (args: string[], input?: string) =>
  JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', input }));

// a project as nos init leaves it (nos.config.json, .specs/ as its own repo) with one unplanned domain
const setup = () => {
  root = mkdtempSync(join(tmpdir(), 'nos-promote-'));
  nos(['init']);
  const domain = nos(
    ['create-domain', '--idea', '-', '--slug', 'dark-mode', '--name', 'Dark mode theme'],
    '# Idea: Dark mode\n',
  );
  expect(domain.folder).toBe('domain-1-dark-mode');
};

// runs the handler like the dev server middleware does (it passes --root <main>)
const call = (method: string, url: string) =>
  new Promise<{ status: number; body: string }>((done) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body = '') {
        done({ status: res.statusCode, body });
      },
    };
    promoteHandler(root, CLI)({ method, url } as never, res);
  });

test('POST /__promote runs nos create-plan --hollow in main, the idea gets an empty open plan in .specs', async () => {
  setup();
  const ok = await call('POST', '/__promote?domain=domain-1-dark-mode');
  expect(ok.status).toBe(200);
  expect(JSON.parse(ok.body)).toMatchObject({ action: 'create-plan', hollow: true, phases: [] });
  expect(JSON.parse(readFileSync(join(root, '.specs/domain-1-dark-mode/plan.json'), 'utf8'))).toStrictEqual({
    name: 'Dark mode theme',
    status: 'open',
    phases: [],
  });
  const again = await call('POST', '/__promote?domain=domain-1-dark-mode');
  expect(again.status).toBe(500);
  expect(again.body).toContain('already has a plan.json');
});

test('/__promote rejects other methods and names that are no domain folder', async () => {
  setup();
  expect((await call('GET', '/__promote?domain=domain-1-dark-mode')).status).toBe(405);
  expect((await call('POST', '/__promote?domain=../etc')).status).toBe(400);
  expect((await call('POST', '/__promote?domain=domain-9-nope')).status).toBe(500);
});
