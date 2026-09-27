import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureSpecs, reserveIds } from './config.js';
import { assertSlug } from './slug.js';

export const IDEA_FILE = 'idea.md';

export function createDomain(root, { idea, slug } = {}) {
  if (typeof idea !== 'string' || !idea.trim()) {
    throw new Error('Missing input: idea. create-domain requires the idea content');
  }
  assertSlug(slug, 'domain slug');

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

  return { id, folder, path: domainPath, ideaPath };
}
