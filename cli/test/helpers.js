import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function makeTempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'nos-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return full;
}

export function readJson(root, relPath) {
  return JSON.parse(readFileSync(path.join(root, relPath), 'utf8'));
}

export const STATUS_XML = `<valid-statuses>
    <plans>
        <status><name>open</name><description>not started</description></status>
        <status>
            <name>in-progress</name>
            <description>being worked on</description>
        </status>
        <status><name>done</name><description>finished</description></status>
    </plans>
    <phases>
        <status><name>open</name><description>not started</description></status>
        <status><name>implemented</name><description>implemented</description></status>
        <status><name>in-review</name><description>under review</description></status>
    </phases>
    <steps>
        <status><name>open</name><description>not started</description></status>
        <status><name>in-specification</name><description>being specified</description></status>
        <status><name>specified</name><description>specified</description></status>
        <status><name>implemented</name><description>implemented</description></status>
        <status><name>in-review</name><description>under review</description></status>
    </steps>
</valid-statuses>`;
