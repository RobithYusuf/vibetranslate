// Copies Silero VAD + onnxruntime-web WASM assets into public/ so they are
// served from the app origin ('self') inside the Tauri webview — no CDN, fully
// offline, and CSP-safe. Run via predev/prebuild hooks. Idempotent.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
mkdirSync(pub, { recursive: true });

const vad = join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist');
const ort = join(root, 'node_modules', 'onnxruntime-web', 'dist');

const assets = [
  // Silero VAD worklet + model (v5 = current Silero)
  [join(vad, 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
  [join(vad, 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
  // onnxruntime-web WASM runtime (CPU loader + binary only — no WebGPU/jsep,
  // which would add ~26MB we never use for Silero inference).
  [join(ort, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
  [join(ort, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
];

let copied = 0;
for (const [src, name] of assets) {
  if (!existsSync(src)) {
    console.warn(`[copy-vad-assets] missing source, skipped: ${src}`);
    continue;
  }
  const dst = join(pub, name);
  // Skip if up-to-date (same size) to keep the hook fast.
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  copied++;
}
console.log(`[copy-vad-assets] ready (${copied} file(s) updated) in ${pub}`);
