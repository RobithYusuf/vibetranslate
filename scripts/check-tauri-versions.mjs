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

// Plugins get the same treatment from `tauri build`: tauri-plugin-http 2.8 against
// @tauri-apps/plugin-http 2.7 stops the release build on every platform. A cargo update can
// pull a plugin minor that has no npm release yet, and nothing before the release catches it.
// The installed npm version is what the CLI compares; the range floor is the fallback when
// node_modules is absent.
const installed = (name) => {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
let bad = 0;
for (const [name, range] of Object.entries(deps)) {
  const m = name.match(/^@tauri-apps\/plugin-(.+)$/);
  if (!m) continue;
  const crateName = `tauri-plugin-${m[1]}`;
  const found = lock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${crateName}"\\nversion = "([^"]+)"`));
  if (!found) continue; // JS-only plugin package
  const jsVer = installed(name) ?? range;
  if (minor(jsVer) !== minor(found[1])) {
    console.error(
      `Tauri plugin mismatch: crate ${crateName} ${found[1]} vs ${name} ${jsVer}.\n` +
        `  cd src-tauri && cargo update -p ${crateName} --precise <${minor(jsVer)}.x>   (or bump ${name})`,
    );
    bad++;
  }
}
if (bad) process.exit(1);
console.log('tauri plugin crates and their npm packages agree');
