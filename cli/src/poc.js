import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError, USAGE } from './exit-codes.js';
import { writeFileAtomic } from './fs-atomic.js';
import { git, NO_PROMPT_ENV } from './git.js';
import { slash } from './roots.js';
import { runPath } from './runs.js';
import { assertSlug } from './slug.js';

// POC results: <specs>/pocs/poc-<slug>-result.md, written by the poc ability at the end of a POC and versioned in
// the specs repo. Front matter { poc: poc-<slug>, created, processed }; processed: no | quick <step id> |
// idea <domain> | dropped. The idea and quick step workflows offer the committed unprocessed ones as input.
export const POCS_DIR = 'pocs';
// a POC slug is part of a branch, a worktree folder and file names: kept short
export const POC_SLUG_MAX = 40;
const RESULT_FILE = /^poc-([a-z0-9]+(?:-[a-z0-9]+)*)-result\.md$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const PROCESSED = /^(no|dropped|quick [1-9]\d*|idea domain-[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const BOM = /^﻿/;

// <specs>-relative path of a POC's result file, forward slashes (the pathspec of nos specs commit --run poc-<slug>)
export const resultRel = (slug) => `${POCS_DIR}/poc-${slug}-result.md`;
export const resultPath = (roots, slug) => path.join(roots.specs, POCS_DIR, `poc-${slug}-result.md`);

// A POC slug: lowercase kebab-case, at most POC_SLUG_MAX characters, else a usage error
export function pocSlug(value, label = '<slug>') {
  try {
    assertSlug(value, label);
  } catch (err) {
    throw new NosError(USAGE, err.message);
  }
  if (value.length > POC_SLUG_MAX) {
    throw new NosError(USAGE, `Slug for ${label} is too long (${value.length}): at most ${POC_SLUG_MAX} characters`);
  }
  return value;
}

// "key: value  # comment" lines of the front matter -> { key: value }; quotes around a value are dropped
export function frontMatter(text) {
  const match = FRONT_MATTER.exec(text.replace(BOM, ''));
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = unquote(field[2].replace(/\s+#.*$/, '').trim());
  }
  return fields;
}

const unquote = (value) => {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m ? m[2].trim() : value;
};

// "# POC result: <title>" -> <title>; the first H1 after the front matter
function titleOf(text) {
  const body = text.replace(BOM, '').replace(FRONT_MATTER, '');
  const h1 = /^#\s+(.+)$/m.exec(body);
  return h1 ? h1[1].replace(/^POC result:\s*/i, '').trim() : '';
}

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// The result files git sees as changed (untracked, modified, staged) in the specs repo: a Set of names under
// pocs/, or null when the specs root is not the top of its own git repo (state unknown)
function changedResults(roots) {
  if (!existsSync(roots.specs)) return null;
  const top = git(['rev-parse', '--show-toplevel'], { cwd: roots.specs, env: NO_PROMPT_ENV });
  if (top.code !== 0 || !samePath(real(top.stdout.trim()), real(roots.specs))) return null;
  const res = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', POCS_DIR], {
    cwd: roots.specs,
    env: NO_PROMPT_ENV,
  });
  if (res.code !== 0) return null;
  const names = new Set();
  const parts = res.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    names.add(path.posix.basename(entry.slice(3)));
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return names;
}

// nos poc results: every result file, sorted by name.
// { action: 'poc-results', results: [{ slug, run, title, processed, state, runExists, file }], warnings? }
// state: "committed" (tracked, clean), "draft" (untracked or changed), null (no specs repo to ask)
export function listResults(roots) {
  let names = [];
  try {
    names = readdirSync(path.join(roots.specs, POCS_DIR));
  } catch {
    // no pocs folder: no results
  }
  const results = [];
  const warnings = [];
  const files = names.sort().filter((name) => RESULT_FILE.test(name));
  const changed = files.length ? changedResults(roots) : null;
  for (const name of files) {
    const slug = RESULT_FILE.exec(name)[1];
    const file = resultPath(roots, slug);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      warnings.push(`skipped ${slash(file)}: ${err.message}`);
      continue;
    }
    const fields = frontMatter(text) ?? {};
    results.push({
      slug,
      run: `poc-${slug}`,
      title: titleOf(text),
      processed: fields.processed || 'no',
      state: changed === null ? null : changed.has(name) ? 'draft' : 'committed',
      runExists: existsSync(runPath(roots, `poc-${slug}`)),
      file: slash(file),
    });
  }
  return { action: 'poc-results', results, ...(warnings.length && { warnings }) };
}

// nos poc processed <slug> --as <no|dropped|quick <id>|idea <domain>>: sets "processed" in the front matter
// (replaces the line, or adds it before the closing ---; no front matter -> one is prepended), line endings kept,
// a leading BOM dropped. The orchestrator commits it.
// { action: 'poc-processed', slug, run, file, previous, processed }
export function markProcessed(roots, { slug, as } = {}) {
  pocSlug(slug);
  const value = String(as ?? '').trim();
  if (!PROCESSED.test(value)) {
    throw new NosError(
      USAGE,
      `Invalid --as "${as ?? ''}". Use dropped, "quick <step id>", "idea <domain-<id>-<slug>>" or no`,
    );
  }
  const file = resultPath(roots, slug);
  let text;
  try {
    text = readFileSync(file, 'utf8').replace(BOM, '');
  } catch (err) {
    if (err.code === 'ENOENT') throw new NosError(FAILED, `No POC result ${slash(file)}`);
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const match = FRONT_MATTER.exec(text);
  const lines = match ? match[1].split(/\r?\n/) : [];
  const at = lines.findIndex((line) => /^processed\s*:/.test(line));
  const previous =
    at < 0
      ? null
      : unquote(
          lines[at]
            .replace(/^processed\s*:\s*/, '')
            .replace(/\s+#.*$/, '')
            .trim(),
        );
  if (at < 0) lines.push(`processed: ${value}`);
  else lines[at] = `processed: ${value}`;
  const front = `---${eol}${lines.join(eol)}${eol}---${eol}`;
  writeFileAtomic(file, front + text.slice(match ? match[0].length : 0));
  return { action: 'poc-processed', slug, run: `poc-${slug}`, file: slash(file), previous, processed: value };
}
