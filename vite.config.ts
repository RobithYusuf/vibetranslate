import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// @ricky0123/vad-web (Silero) is CJS and require()s onnxruntime-web, so both get
// esbuild-prebundled together. onnxruntime-web 1.27 loads its WASM runtime via a
// dynamic import of ort-wasm-simd-threaded.mjs guarded with /*@vite-ignore*/ — but
// prebundling strips that comment, so Vite appends `?import` and the dev fetch fails.
// This dev-only middleware serves those VAD/ORT assets (already copied to public/ by
// scripts/copy-vad-assets.mjs) raw, bypassing Vite's module transform, for ANY query.
// In production (static dist/) the files are served directly and this isn't needed.
function vadAssetPassthrough(): Plugin {
  const MIME: Record<string, string> = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
  const names = new Set([
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
    'silero_vad_v5.onnx',
    'vad.worklet.bundle.min.js',
  ]);
  return {
    name: 'vad-asset-passthrough',
    apply: 'serve',
    configureServer(server) {
      // Registered inside the hook (not the returned post-fn) so it runs BEFORE Vite's
      // internal transform middleware and wins the request.
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] || '';
        const base = url.startsWith('/') ? url.slice(1) : url;
        if (!names.has(base)) return next();
        const file = path.resolve(__dirname, 'public', base);
        if (!fs.existsSync(file)) return next();
        res.setHeader('Content-Type', MIME[path.extname(base)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [vadAssetPassthrough(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    // Use Tauri's default dev port 1420 (5173 is often taken by other dev/Docker apps).
    // 1420 is also in the server's CORS allowlist, so Built-in (Free) models/translate work in dev.
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  // Mark these console methods as side-effect-free so the production minifier DROPS them
  // (release build has no console.log/info/debug noise — nothing to read even if devtools
  // were somehow opened). In dev (no minify) they stay, so debugging still works. console.warn
  // and console.error are kept for real problems.
  esbuild: {
    pure: ['console.log', 'console.info', 'console.debug'],
  },
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
