import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';
import { noEval } from './vite.no-eval.ts';

export default defineConfig({
  base: './',
  // no runtime code generation in opencv.js (and none in heic-to's CSP build), so the CSP needs no 'unsafe-eval' (see vite.no-eval.ts)
  plugins: [noEval()],
  worker: { format: 'es', plugins: () => [noEval()] },
  // onnxruntime-web without its ~30 MB wasm bundled: src/vision/model.ts loads it from jsDelivr instead
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  // three.js alone is ~550 kB minified; it is one cacheable chunk on purpose
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { main: 'index.html', privacy: 'privacy.html' } },
  },
  preview: { port: 4175, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
