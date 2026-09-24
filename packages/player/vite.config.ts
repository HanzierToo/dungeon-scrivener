import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('./browser', import.meta.url)),
  server: { host: '127.0.0.1', port: 4181, strictPort: true },
  esbuild: { jsx: 'automatic' },
});
