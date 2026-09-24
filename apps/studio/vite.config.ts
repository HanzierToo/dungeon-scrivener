import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: { fs: { allow: ['../..'] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
