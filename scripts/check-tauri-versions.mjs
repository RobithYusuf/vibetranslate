#!/usr/bin/env node
// Fail if the Rust `tauri` crate and the `@tauri-apps/api` npm package are on different
// minor releases.
//
// Why this exists: `tauri build` refuses to run when they disagree, but nothing else does.
// CI runs tsc, vite build and `cargo check` — none of which look at this — so a Dependabot
// bump of @tauri-apps/api sailed through CI, got merged, and only failed at release time,
// on all three platforms at once, after the tag was already public.
//
//   node scripts/check-tauri-versions.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const jsRange = pkg.dependencies?.['@tauri-apps/api'] ?? pkg.devDependencies?.['@tauri-apps/api'];
if (!jsRange) {
  console.error('@tauri-apps/api is not a dependency — this check assumes it is');
  process.exit(1);
}

// Cargo.lock is the resolved truth; Cargo.toml only says "2.0".
const lock = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
const crate = lock.match(/\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/);
if (!crate) {
  console.error('could not find the resolved `tauri` crate version in src-tauri/Cargo.lock');
  process.exit(1);
}

const minor = (v) => v.replace(/^[^\d]*/, '').split('.').slice(0, 2).join('.');
const js = minor(jsRange);
const rs = minor(crate[1]);

if (js !== rs) {
  console.error(
    `Tauri version mismatch: crate tauri ${crate[1]} vs @tauri-apps/api ${jsRange}.\n` +
      'They must share a major.minor. Fix with ONE of:\n' +
      `  cd src-tauri && cargo update -p tauri --precise <${js}.x>\n` +
      `  pnpm add @tauri-apps/api@~${rs}`,
  );
  process.exit(1);
}

console.log(`tauri crate ${crate[1]} and @tauri-apps/api ${jsRange} agree on ${rs}`);
