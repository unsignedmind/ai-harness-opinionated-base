import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureSpecs, reserveIds } from './config.js';
import { assertSlug } from './slug.js';

export const IDEA_FILE = 'idea.md';
export const DOMAIN_FILE = 'domain.json';

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
function defaultName(idea, slug) {
  const heading = /^#\s+(.+)$/m.exec(idea)?.[1].replace(/^idea:\s*/i, '').trim();
  return heading || slug.replaceAll('-', ' ');
}

export function createDomain(root, { idea, slug, name, labels } = {}) {
  if (typeof idea !== 'string' || !idea.trim()) {
    throw new Error('Missing input: idea. create-domain requires the idea content');
  }
  assertSlug(slug, 'domain slug');
  const domain = {
    name: name?.trim() || defaultName(idea, slug),
    labels: parseLabels(labels),
    'cross-cutting': false,
  };

  const { specsDir } = ensureSpecs(root);
  const [id] = reserveIds(root, 'domain');
  const folder = `domain-${id}-${slug}`;
  const domainPath = path.join(specsDir, folder);

  if (existsSync(domainPath)) {
    throw new Error(`Domain folder ${domainPath} already exists`);
  }
  mkdirSync(domainPath);
  const ideaPath = path.join(domainPath, IDEA_FILE);
  writeFileSync(ideaPath, idea);
  const domainFilePath = path.join(domainPath, DOMAIN_FILE);
  writeFileSync(domainFilePath, JSON.stringify(domain, null, 2) + '\n');

  return { id, folder, path: domainPath, ideaPath, domainFilePath };
}
