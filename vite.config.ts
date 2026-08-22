import { fileURLToPath } from 'node:url';

import { aelion } from '@aelionsdk/vite-plugin';
import { defineConfig } from 'vite';

const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: '/',
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [aelion()],
  build: { outDir: 'dist', sourcemap: true },
  // Cross-origin isolation lets audio take the SharedArrayBuffer ring path.
  // Without it playback falls back to postMessage, so serve the built site with
  // the same two headers.
  server: { host: '127.0.0.1', port: 4174, strictPort: true, headers: isolationHeaders },
  preview: { host: '127.0.0.1', port: 4180, strictPort: true, headers: isolationHeaders },
});
