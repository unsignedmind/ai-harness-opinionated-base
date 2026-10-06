import { test, expect } from 'vitest';

import { docsFolderOf, locateSpecs, readDocs, readSpecsFolder, type DirLike } from '../src/folder';

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

// a specs root: domains plus local state that is never read
const specs: Tree = {
  'config.json': '{}',
  '.chat': { 'sessions.json': '{}' },
  '.runs': { 'quick-2.json': '{}' },
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

const ALL = {
  'domain-1-i18n/idea.md': '# Idea: i18n',
  'domain-1-i18n/domain.json': '{}',
  'domain-1-i18n/plan.json': '{}',
  'domain-1-i18n/phases/phase-1-x/step-1-a.md': '# A',
  'domain-1-i18n/quick-steps/quick-steps.json': '[]',
  'domain-1-i18n/quick-steps/step-2-q.md': '# Q',
  'domain-2-dark/idea.md': '# Idea: dark',
};

test('reads idea.md, domain.json, plan.json, phase markdown and quick steps, keyed relative to the specs root', async () => {
  expect(await readSpecsFolder(dir('.specs', specs))).toStrictEqual(ALL);
});

test('accepts the project folder (nos.config.json) and descends into its .specs/ folder', async () => {
  const project = dir('moodo', { 'nos.config.json': '{"specs":{"dir":".specs"}}', src: {}, '.specs': specs });
  expect(await readSpecsFolder(project)).toStrictEqual(ALL);
  expect((await locateSpecs(project)).root?.name).toBe('moodo');
});

test('the project folder without nos.config.json still finds .specs/', async () => {
  expect(await readSpecsFolder(dir('moodo', { src: {}, '.specs': specs }))).toStrictEqual(ALL);
});

test('specs.dir of nos.config.json names the specs root', async () => {
  const project = dir('p', { 'nos.config.json': '{"specs":{"dir":"plans/specs"}}', plans: { specs } });
  expect(await readSpecsFolder(project)).toStrictEqual(ALL);
});

test('a project whose specs root is missing says so', async () => {
  await expect(readSpecsFolder(dir('p', { 'nos.config.json': '{"specs":{"dir":"plans"}}' }))).rejects.toThrow(
    /no plans\/ folder: run nos init/,
  );
});

test('the default specs root is the sibling folder: the project folder names the folder to pick instead', async () => {
  for (const config of ['{}', '{"specs":{"dir":null}}', '{"specs":{"dir":"../moodo.specs"}}']) {
    await expect(readSpecsFolder(dir('moodo', { 'nos.config.json': config, src: {} }))).rejects.toThrow(
      /lies outside it \(\.\.\/moodo\.specs\).*pick the specs folder moodo\.specs\/ instead/,
    );
  }
});

test('the sibling specs root picked on its own: read, and named as the project sees it via its back-pointer', async () => {
  const sibling = dir('moodo.specs', { ...specs, 'config.json': '{"project":"../moodo","id-counters":{}}' });
  expect(await readSpecsFolder(sibling)).toStrictEqual(ALL);
  expect(await locateSpecs(sibling)).toMatchObject({ root: null, rel: '../moodo.specs' });
  // no domains yet: the name or the id-counters mark it as a specs root
  expect((await locateSpecs(dir('moodo.specs', { 'config.json': '{"project":"../moodo"}' }))).rel).toBe(
    '../moodo.specs',
  );
  expect((await locateSpecs(dir('plans', { 'config.json': '{"id-counters":{}}' }))).rel).toBe('plans');
  // a back-pointer deeper down ("../../x/p") or none at all: its own name
  const deep = dir('s', { ...specs, 'config.json': '{"project":"../../x/p"}' });
  expect((await locateSpecs(deep)).rel).toBe('s');
  expect((await locateSpecs(dir('specs', { ...specs, 'config.json': '{"project":"../a/b"}' }))).rel).toBe(
    '../../specs',
  );
});

test('a folder without domain-* folders, nos.config.json or .specs/ is rejected', async () => {
  await expect(readSpecsFolder(dir('src', { 'a.ts': '' }))).rejects.toThrow(/"src\/" has no domain-\* folders/);
});

test('an empty .specs/ folder is fine and yields no files', async () => {
  expect(await readSpecsFolder(dir('.specs', { 'config.json': '{}' }))).toStrictEqual({});
});

// ── docs: spec-ui.docs-folder of the project's nos.config.json ──

const repo = (config: object | null) =>
  dir('repo', {
    ...(config && { 'nos.config.json': JSON.stringify(config) }),
    '.specs': specs,
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
  const expected = { folder: 'docs', files: { 'guides/setup.md': '# Setup', 'index.md': '# Docs' } };
  expect(await docsOf(repo(null))).toStrictEqual(expected);
  expect(await docsOf(repo({ specs: { dir: '.specs' } }))).toStrictEqual(expected);
});

test('spec-ui.docs-folder names the folder, nested and with either slash', async () => {
  expect(await docsOf(repo({ 'spec-ui': { 'docs-folder': './handbook\\team/' } }))).toStrictEqual({
    folder: 'handbook/team',
    files: { 'rules.txt': 'be nice' },
  });
});

test('docsFolderOf reads the project config, default docs', async () => {
  expect(await docsFolderOf(repo({ 'spec-ui': { 'docs-folder': 'wiki' } }))).toBe('wiki');
  expect(await docsFolderOf(repo(null))).toBe('docs');
});

test('the docs-folder of .specs/config.json (old place) is ignored', async () => {
  const project = dir('p', {
    'nos.config.json': '{}',
    '.specs': { ...specs, 'config.json': JSON.stringify({ 'spec-ui': { 'docs-folder': 'handbook' } }) },
    docs: { 'a.md': '# A' },
  });
  expect((await docsOf(project)).folder).toBe('docs');
});

test('a missing docs folder is reported, not thrown', async () => {
  const d = await docsOf(repo({ 'spec-ui': { 'docs-folder': 'wiki' } }));
  expect(d.files).toStrictEqual({});
  expect(d.error).toMatch(/No wiki\/ folder in repo\/.*nos\.config\.json/);
});

test('docs-folder may not leave the project', async () => {
  const d = await docsOf(repo({ 'spec-ui': { 'docs-folder': '../other' } }));
  expect(d.error).toMatch(/inside the project/);
});

test('with the specs root picked on its own the docs are out of reach', async () => {
  expect((await docsOf(dir('.specs', specs))).error).toMatch(/docs are out of its reach.*npm run dev/);
});

test('a broken nos.config.json falls back to docs/ and .specs', async () => {
  const project = dir('p', { 'nos.config.json': '{nope', '.specs': specs, docs: { 'a.md': '# A' } });
  expect(await readSpecsFolder(project)).toStrictEqual(ALL);
  const d = await docsOf(project);
  expect(d.folder).toBe('docs');
  expect(d.error).toBeUndefined();
});

test('locateSpecs names the specs root as the project sees it', async () => {
  expect(
    (await locateSpecs(dir('p', { 'nos.config.json': '{"specs":{"dir":"plans/specs"}}', plans: { specs } }))).rel,
  ).toBe('plans/specs');
  expect((await locateSpecs(dir('p', { '.specs': specs }))).rel).toBe('.specs');
  expect((await locateSpecs(dir('.specs', specs))).rel).toBe('.specs');
});

test('docs-folder may not name a hidden folder', async () => {
  for (const bad of ['.git', 'docs/.private', '.specs']) {
    const d = await docsOf(repo({ 'spec-ui': { 'docs-folder': bad } }));
    expect(d.files).toStrictEqual({});
    expect(d.error).toMatch(/no part starting with "\."/);
  }
});
