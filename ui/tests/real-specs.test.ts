import { resolve } from 'node:path';
import { test, expect } from 'vitest';

import { readDocs, readSpecsFolder } from '../src/folder';
import { buildModel } from '../src/model';
import { nodeDir } from '../src/serve-specs';

// Reads the real specs/ the same way the dev server does, so a plan.json the viewer cannot parse
// fails here first. specs/ sits at the repo root, five levels above this folder.
const readSpecs = () => readSpecsFolder(nodeDir(resolve(import.meta.dirname, '../../../../../specs')));

test('every idea in specs/ parses without error', async () => {
  const model = buildModel(await readSpecs());
  expect(model.ideas.length).toBeGreaterThan(0);
  for (const idea of model.ideas) expect(idea.error).toBeNull();
});

test('every step names a known status and its spec file exists', async () => {
  const files = await readSpecs();
  for (const s of buildModel(files).steps) {
    expect(s.status.flagged, `${s.idea.folder}/${s.slug}`).toBe(false);
    if (s.specPath) expect(files[s.specPath], s.specPath).toBeDefined();
  }
});

test('the docs folder named in specs/config.json loads', async () => {
  const repo = resolve(import.meta.dirname, '../../../../..');
  const docs = await readDocs(nodeDir(resolve(repo, 'specs')), nodeDir(repo));
  expect(docs.error).toBeUndefined();
  expect(Object.keys(docs.files).length).toBeGreaterThan(0);
});
