// Extract the release notes for ONE version from src/utils/changelog.ts, for the updater
// manifest (latest.json `notes`). The updating app is the OLD version — its bundled changelog
// doesn't contain the new entry — so the notes must travel inside the manifest.
//
// Usage: node scripts/changelog-notes.mjs 1.0.31 [--json]
//   plain: bullet lines ("• …")     --json: a JSON string literal ready to embed
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const version = process.argv[2];
const asJson = process.argv.includes('--json');
if (!version) {
  console.error('usage: changelog-notes.mjs <version> [--json]');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/utils/changelog.ts'), 'utf8');

// Find this version's entry block, then its changes[] array.
const entryStart = src.indexOf(`version: '${version}'`);
if (entryStart === -1) {
  console.error(`version ${version} not found in changelog.ts`);
  process.exit(2);
}
const changesStart = src.indexOf('changes: [', entryStart);
const changesEnd = src.indexOf(']', changesStart);
const block = src.slice(changesStart, changesEnd);

// Single-quoted TS strings, tolerant of escaped quotes.
const items = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) =>
  m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
);
if (items.length === 0) {
  console.error(`no changes found for ${version}`);
  process.exit(3);
}

const notes = items.map((i) => `• ${i}`).join('\n');
process.stdout.write(asJson ? JSON.stringify(notes) : notes);
