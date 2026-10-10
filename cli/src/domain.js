import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reserveIds, specsDir } from './config.js';
import { assertSlug } from './slug.js';

// A domain is an area or topic. It holds one idea file per idea: idea-<slug>.md. idea.md is the legacy single idea.
export const LEGACY_IDEA_FILE = 'idea.md';
export const IDEA_PATTERN = /^idea(-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/;
export const DOMAIN_FILE = 'domain.json';
const DOMAIN_FOLDER = /^domain-\d+-[a-z0-9-]+$/;

export const ideaFileName = (slug) => `idea-${slug}.md`;

// the idea files of a domain folder: legacy idea.md first, then idea-*.md by name
export function listIdeaFiles(domainDir) {
  if (!existsSync(domainDir)) return [];
  const files = readdirSync(domainDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IDEA_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  return files.sort((a, b) => (a === LEGACY_IDEA_FILE ? -1 : b === LEGACY_IDEA_FILE ? 1 : a.localeCompare(b)));
}

// "x", "idea-x", "idea-x.md", "idea.md" -> the idea file name
export function normalizeIdeaFile(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Missing input: idea');
  if (IDEA_PATTERN.test(name)) return name;
  const slug = name.replace(/^idea-/, '').replace(/\.md$/, '');
  assertSlug(slug, 'idea');
  return ideaFileName(slug);
}

// "a, b" or ["a", "b"] -> ["a", "b"]; every label lowercase kebab-case
export function parseLabels(labels) {
  if (labels == null) return [];
  const list = Array.isArray(labels) ? labels : String(labels).split(',');
  return list
    .map((label) => String(label).trim())
    .filter(Boolean)
    .map((label) => {
      assertSlug(label, 'label');
      return label;
    });
}

// first "# " heading of the idea without an "Idea:" prefix, else the slug
export function defaultName(idea, slug) {
  const heading = /^#\s+(.+)$/m
    .exec(idea)?.[1]
    .replace(/^idea:\s*/i, '')
    .trim();
  return heading || slug.replaceAll('-', ' ');
}

function assertIdea(idea, command) {
  if (typeof idea !== 'string' || !idea.trim()) {
    throw new Error(`Missing input: idea. ${command} requires the idea content`);
  }
}

// ideaSlug: the slug of the idea file (default: the domain slug). The domain slug names the area, the idea slug the idea
export function createDomain(roots, { idea, slug, ideaSlug, name, labels } = {}) {
  assertIdea(idea, 'create-domain');
  assertSlug(slug, 'domain slug');
  if (ideaSlug != null) assertSlug(ideaSlug, 'idea slug');
  const domain = {
    name: name?.trim() || defaultName(idea, slug),
    labels: parseLabels(labels),
    'cross-cutting': false,
  };

  // the specs root and its config.json come from nos init; reserveIds fails without them
  const [id] = reserveIds(roots, 'domain');
  const folder = `domain-${id}-${slug}`;
  const domainPath = path.join(specsDir(roots), folder);

  if (existsSync(domainPath)) {
    throw new Error(`Domain folder ${domainPath} already exists`);
  }
  mkdirSync(domainPath);
  const ideaFile = ideaFileName(ideaSlug ?? slug);
  const ideaPath = path.join(domainPath, ideaFile);
  writeFileSync(ideaPath, idea);
  const domainFilePath = path.join(domainPath, DOMAIN_FILE);
  writeFileSync(domainFilePath, JSON.stringify(domain, null, 2) + '\n');

  return { id, folder, path: domainPath, ideaFile, ideaPath, domainFilePath };
}

function domainDirOf(roots, domain, command) {
  if (!domain) throw new Error(`Missing input: domain. ${command} requires a "domain-<id>-<slug>" folder name`);
  if (!DOMAIN_FOLDER.test(domain)) throw new Error(`Domain "${domain}" does not match "domain-<id>-<slug>"`);
  const domainDir = path.join(specsDir(roots), domain);
  if (!existsSync(domainDir)) throw new Error(`Domain folder ${domainDir} does not exist`);
  return domainDir;
}

// another idea in an existing domain: <specs>/<domain>/idea-<slug>.md
export function addIdea(roots, { domain, idea, slug } = {}) {
  assertIdea(idea, 'add-idea');
  assertSlug(slug, 'idea slug');
  const domainDir = domainDirOf(roots, domain, 'add-idea');
  const ideaFile = ideaFileName(slug);
  const ideaPath = path.join(domainDir, ideaFile);
  if (existsSync(ideaPath)) throw new Error(`Idea ${domain}/${ideaFile} already exists`);
  writeFileSync(ideaPath, idea);
  return { domain, ideaFile, ideaPath };
}

const readJsonOr = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// The idea files a plan.json covers: its "ideas". A plan with phases from before idea files had no "ideas": it
// covers the legacy idea.md. A hollow plan (no phases) covers none.
export function plannedIdeas(plan) {
  if (!plan || typeof plan !== 'object') return [];
  if (Array.isArray(plan.ideas)) return plan.ideas.filter((file) => typeof file === 'string');
  const phases = plan.phases == null ? [] : Array.isArray(plan.phases) ? plan.phases : [plan.phases];
  return phases.length ? [LEGACY_IDEA_FILE] : [];
}

// Every domain with its ideas: { domain, name, path, ideas: [{ file, path, title, planned }] }
export function listIdeas(roots, { domain, unplanned = false } = {}) {
  const root = specsDir(roots);
  const folders = domain
    ? [path.basename(domainDirOf(roots, domain, 'ideas'))]
    : existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && DOMAIN_FOLDER.test(entry.name))
          .map((entry) => entry.name)
      : [];
  const number = (folder) => Number(/^domain-(\d+)-/.exec(folder)[1]);
  folders.sort((a, b) => number(a) - number(b) || a.localeCompare(b));

  return folders
    .map((folder) => {
      const domainDir = path.join(root, folder);
      const planned = new Set(plannedIdeas(readJsonOr(path.join(domainDir, 'plan.json'), null)));
      const ideas = listIdeaFiles(domainDir)
        .map((file) => {
          const ideaPath = path.join(domainDir, file);
          const slug = file === LEGACY_IDEA_FILE ? folder.replace(/^domain-\d+-/, '') : file.slice(5, -3);
          return {
            file,
            path: ideaPath,
            title: defaultName(readFileSync(ideaPath, 'utf8'), slug),
            planned: planned.has(file),
          };
        })
        .filter((idea) => !unplanned || !idea.planned);
      const meta = readJsonOr(path.join(domainDir, DOMAIN_FILE), {});
      const name = (typeof meta?.name === 'string' && meta.name.trim()) || folder.replace(/^domain-\d+-/, '');
      return { domain: folder, name, path: domainDir, ideas };
    })
    .filter((entry) => !unplanned || entry.ideas.length);
}
