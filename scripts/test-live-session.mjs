#!/usr/bin/env node
/**
 * Regression test for LiveSession's audio pump.
 *
 * Exists because of a defect that reached users: `drain()` reset its own in-flight promise
 * from INSIDE the async body. An async IIFE runs synchronously up to its first await, so on
 * every call made while the model was still loading — queue empty, nothing to drain — the
 * body set `drainPromise = null` BEFORE the outer assignment overwrote it with the resolved
 * promise. The guard at the top of `drain()` then returned that stale promise forever and
 * `pushLive` was never called again. Live dictation recorded normally, showed no live text,
 * and came back empty every single time.
 *
 * The shape of the trap matters more than the line, and TypeScript cannot see it, so this
 * asserts the observable contract rather than the implementation: every fed chunk must reach
 * the recogniser, including chunks fed before startLive() resolves.
 *
 * Runs the REAL module with its Rust bridge swapped for counting stubs. No test framework —
 * the project has none, and Node strips the types itself. Run: node scripts/test-live-session.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'livesession-'));

try {
  // Node's resolver wants explicit extensions; the app's bundler does not.
  const source = readFileSync(join(root, 'src/services/liveSession.ts'), 'utf8')
    .replace("from './sttStream'", "from './sttStream.ts'");
  writeFileSync(join(dir, 'liveSession.ts'), source);

  writeFileSync(join(dir, 'sttStream.ts'), `
let pushes = 0;
export const getPushes = (): number => pushes;
export const startLive = async (): Promise<void> => { await new Promise(r => setTimeout(r, 60)); };
export const pushLive = async (_pcm: Int16Array): Promise<void> => { pushes++; };
export const finishLive = async (): Promise<string> => 'ok';
export const cancelLive = async (): Promise<void> => {};
// commit() must drain the queue BEFORE freezing the segment, or the words said just before a
// Backspace would land in the next segment (or be lost). Record how many chunks had been
// pushed at the moment the recogniser was asked to commit.
let pushesAtCommit = -1;
export const getPushesAtCommit = (): number => pushesAtCommit;
export const commitLive = async (): Promise<{ text: string; seg: number }> => {
  pushesAtCommit = pushes;
  return { text: 'ok', seg: 1 };
};
`);

  writeFileSync(join(dir, 'run.ts'), `
import { LiveSession } from './liveSession.ts';
import { getPushes, getPushesAtCommit } from './sttStream.ts';

const CHUNKS = 12;
const session = new LiveSession();
// Not awaited, exactly as the overlay does it: recording starts before the model is ready,
// which is precisely the window the original defect lived in.
session.begin(() => { console.log('FAIL: session reported itself unavailable'); process.exit(1); });

let fed = 0;
const timer = setInterval(() => {
  session.feed(new Int16Array(3200));
  if (++fed >= CHUNKS) clearInterval(timer);
}, 20);

setTimeout(async () => {
  // A live edit mid-dictation: everything fed so far must be pushed before the commit.
  await session.commit();
  if (getPushesAtCommit() !== CHUNKS) {
    console.log(\`FAIL: commit ran after \${getPushesAtCommit()} of \${CHUNKS} chunks; queued audio was not drained first\`);
    process.exit(1);
  }
  // The dictation goes on after the edit.
  for (let i = 0; i < 3; i++) session.feed(new Int16Array(3200));
  await session.finish();
  const pushed = getPushes();
  if (pushed !== CHUNKS + 3) {
    console.log(\`FAIL: fed \${CHUNKS + 3} chunks, only \${pushed} reached the recogniser\`);
    process.exit(1);
  }
  console.log(\`ok - all \${CHUNKS + 3} chunks reached the recogniser, including those fed during model load and after a live edit\`);
}, 600);
`);

  const out = execFileSync(process.execPath, [join(dir, 'run.ts')], { encoding: 'utf8' });
  process.stdout.write(out);
  if (!out.startsWith('ok')) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
