import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'data',
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
  },
});
