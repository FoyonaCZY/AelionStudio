import { fileURLToPath } from 'node:url';

import { aelion } from '@aelionsdk/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [aelion()],
  resolve: {
    alias: {
      '@aelionsdk/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
      '@aelionsdk/project-schema': fileURLToPath(
        new URL('../../packages/project-schema/src/index.ts', import.meta.url),
      ),
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
});
