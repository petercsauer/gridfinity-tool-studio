import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // onnxruntime-web without its ~30 MB wasm bundled: src/vision/model.ts loads it from jsDelivr instead
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  // three.js alone is ~550 kB minified; it is one cacheable chunk on purpose
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
