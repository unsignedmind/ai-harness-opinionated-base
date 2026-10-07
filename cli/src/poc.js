import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAILED, NosError, USAGE } from './exit-codes.js';
import { writeFileAtomic } from './fs-atomic.js';
import { slash } from './roots.js';
import { runPath } from './runs.js';
import { assertSlug } from './slug.js';

// POC results: <specs>/pocs/poc-<slug>-result.md, written by the poc ability at the end of a POC and versioned in
// the specs repo. Front matter { poc: poc-<slug>, created, processed }; processed: no | quick <step id> |
// idea <domain> | dropped. The idea and quick step workflows offer the unprocessed ones as input.
export const POCS_DIR = 'pocs';
const RESULT_FILE = /^poc-([a-z0-9]+(?:-[a-z0-9]+)*)-result\.md$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const PROCESSED = /^(no|dropped|quick [1-9]\d*|idea domain-[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*)$/;

// <specs>-relative path of a POC's result file, forward slashes (the pathspec of nos specs commit --run poc-<slug>)
export const resultRel = (slug) => `${POCS_DIR}/poc-${slug}-result.md`;
export const resultPath = (roots, slug) => path.join(roots.specs, POCS_DIR, `poc-${slug}-result.md`);

function pocSlug(value) {
  try {
    return assertSlug(value, '<slug>');
  } catch (err) {
    throw new NosError(USAGE, err.message);
  }
}

// "key: value  # comment" lines of the front matter -> { key: value }
export function frontMatter(text) {
  const match = FRONT_MATTER.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].replace(/\s+#.*$/, '').trim();
  }
  return fields;
}

// "# POC result: <title>" -> <title>; the first H1 after the front matter
function titleOf(text) {
  const body = text.replace(FRONT_MATTER, '');
  const h1 = /^#\s+(.+)$/m.exec(body);
  return h1 ? h1[1].replace(/^POC result:\s*/i, '').trim() : '';
}

// nos poc results: every result file, sorted by name.
// { action: 'poc-results', results: [{ slug, run, title, processed, runExists, file }], warnings? }
export function listResults(roots) {
  let names = [];
  try {
    names = readdirSync(path.join(roots.specs, POCS_DIR));
  } catch {
    // no pocs folder: no results
  }
  const results = [];
  const warnings = [];
  for (const name of names.sort()) {
    const match = RESULT_FILE.exec(name);
    if (!match) continue;
    const slug = match[1];
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
      runExists: existsSync(runPath(roots, `poc-${slug}`)),
      file: slash(file),
    });
  }
  return { action: 'poc-results', results, ...(warnings.length && { warnings }) };
}

// nos poc processed <slug> --as <no|dropped|quick <id>|idea <domain>>: sets "processed" in the front matter
// (replaces the line, or adds it before the closing ---), line endings kept. The orchestrator commits it.
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
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new NosError(FAILED, `No POC result ${slash(file)}`);
    throw new NosError(FAILED, `Cannot read ${slash(file)}: ${err.message}`);
  }
  const match = FRONT_MATTER.exec(text);
  if (!match) throw new NosError(FAILED, `${slash(file)} has no front matter (--- … ---)`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = match[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^processed\s*:/.test(line));
  const previous =
    at < 0
      ? null
      : lines[at]
          .replace(/^processed\s*:\s*/, '')
          .replace(/\s+#.*$/, '')
          .trim();
  if (at < 0) lines.push(`processed: ${value}`);
  else lines[at] = `processed: ${value}`;
  const front = `---${eol}${lines.join(eol)}${eol}---${eol}`;
  writeFileAtomic(file, front + text.slice(match[0].length));
  return { action: 'poc-processed', slug, run: `poc-${slug}`, file: slash(file), previous, processed: value };
}
