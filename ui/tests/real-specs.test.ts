// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { readDocs, readSpecsFolder } from '../src/folder';
import { buildModel } from '../src/model';
import { nodeDir, specsSetup } from '../src/serve-specs';

// Reads the real specs root of the project this nos sits in the same way the dev server does, so a
// plan.json the viewer cannot parse fails here first. The project comes from the resolver (the walk
// from the ui folder to nos.config.json, or NOS_SPECS_ROOT). Skipped when nos is not set up there
// (a nos checkout of its own, or a project before nos init).
const setup = specsSetup({ cwd: resolve(import.meta.dirname, '..'), env: process.env });
const roots = setup.roots;

describe.skipIf(!roots)('the real specs of the project', () => {
  const readSpecs = () => readSpecsFolder(nodeDir(roots!.specs));

  test('every idea parses without error', async () => {
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

  test('the docs folder named in nos.config.json loads', async () => {
    // like the dev server: the specs root may lie outside main (default ../<project>.specs)
    const docs = await readDocs(nodeDir(roots!.specs), nodeDir(roots!.main));
    expect(docs.error).toBeUndefined();
    expect(Object.keys(docs.files).length).toBeGreaterThan(0);
  });
});
