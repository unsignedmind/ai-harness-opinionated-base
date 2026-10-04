import { test, expect } from 'vitest';

import { locateSpecs, readDocs, readSpecsFolder, type DirLike } from '../src/folder';

// In-memory stand-in for a File System Access directory handle: nested objects are folders,
// strings are files.
type Tree = { [name: string]: Tree | string };
function dir(name: string, tree: Tree): DirLike {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [n, v] of Object.entries(tree))
        yield [
          n,
          typeof v === 'string'
            ? {
                kind: 'file' as const,
                name: n,
                getFile: async () => ({ text: async () => v }),
              }
            : dir(n, v),
        ] as const;
    },
  };
}

const specs: Tree = {
  'config.json': '{}',
  ui: { 'index.html': '<html>' },
  'domain-1-i18n': {
    'idea.md': '# Idea: i18n',
    'domain.json': '{}',
    'plan.json': '{}',
    'notes.txt': 'skip me',
    phases: {
      'phase-1-x': { 'step-1-a.md': '# A', 'draft.txt': 'skip' },
    },
    'quick-steps': {
      'quick-steps.json': '[]',
      'step-2-q.md': '# Q',
      'notes.txt': 'skip',
    },
  },
  'domain-2-dark': { 'idea.md': '# Idea: dark' },
};

test('reads idea.md, domain.json, plan.json, phase markdown and quick steps of every domain folder', async () => {
  expect(await readSpecsFolder(dir('specs', specs))).toStrictEqual({
    'specs/domain-1-i18n/idea.md': '# Idea: i18n',
    'specs/domain-1-i18n/domain.json': '{}',
    'specs/domain-1-i18n/plan.json': '{}',
    'specs/domain-1-i18n/phases/phase-1-x/step-1-a.md': '# A',
    'specs/domain-1-i18n/quick-steps/quick-steps.json': '[]',
    'specs/domain-1-i18n/quick-steps/step-2-q.md': '# Q',
    'specs/domain-2-dark/idea.md': '# Idea: dark',
  });
});

test('accepts the repo root and descends into its specs/ folder', async () => {
  const files = await readSpecsFolder(dir('dompaine-gate', { src: {}, specs }));
  expect(Object.keys(files)).toContain('specs/domain-2-dark/idea.md');
});

test('a folder without domain-* folders and without specs/ is rejected', async () => {
  await expect(readSpecsFolder(dir('src', { 'a.ts': '' }))).rejects.toThrow(/"src\/" has no domain-\* folders/);
});

test('an empty specs/ folder is fine and yields no files', async () => {
  expect(await readSpecsFolder(dir('specs', { 'config.json': '{}' }))).toStrictEqual({});
});

// ── docs ──

const repo = (config: object | null) =>
  dir('repo', {
    specs: config ? { ...specs, 'config.json': JSON.stringify(config) } : specs,
    docs: {
      'index.md': '# Docs',
      'logo.png': 'binary',
      '.obsidian': { 'x.json': '{}' },
      node_modules: { 'a.md': '' },
      guides: { 'setup.md': '# Setup', 'diagram.pdf': 'binary' },
      images: { 'a.png': 'binary' },
    },
    handbook: { team: { 'rules.txt': 'be nice' } },
  });
const docsOf = async (picked: DirLike) => {
  const { specs, root } = await locateSpecs(picked);
  return readDocs(specs, root);
};

test('reads the text files under docs/ by default and skips the rest', async () => {
  expect(await docsOf(repo(null))).toStrictEqual({
    folder: 'docs',
    files: { 'guides/setup.md': '# Setup', 'index.md': '# Docs' },
  });
});

test('spec-ui.docs-folder names the folder, nested and with either slash', async () => {
  expect(await docsOf(repo({ 'spec-ui': { 'docs-folder': './handbook\\team/' } }))).toStrictEqual({
    folder: 'handbook/team',
    files: { 'rules.txt': 'be nice' },
  });
});

test('a missing docs folder is reported, not thrown', async () => {
  const d = await docsOf(repo({ 'spec-ui': { 'docs-folder': 'wiki' } }));
  expect(d.files).toStrictEqual({});
  expect(d.error).toMatch(/No wiki\/ folder in repo\//);
});

test('docs-folder may not leave the repo', async () => {
  const d = await docsOf(repo({ 'spec-ui': { 'docs-folder': '../other' } }));
  expect(d.error).toMatch(/inside the repo/);
});

test('with specs/ picked on its own the docs are out of reach', async () => {
  expect((await docsOf(dir('specs', specs))).error).toMatch(/Open the repo root/);
});

test('a broken config.json falls back to docs/', async () => {
  const d = await readDocs(dir('specs', { ...specs, 'config.json': '{nope' }), repo(null));
  expect(d.folder).toBe('docs');
  expect(d.error).toBeUndefined();
});
