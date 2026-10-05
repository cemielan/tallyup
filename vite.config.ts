import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The PWA. Built into ./dist, which wrangler.toml serves as static assets
// beside the API. In dev, Vite serves the app and forwards /v1 to
// `wrangler dev` (npm run dev:api) on its default port.
export default defineConfig({
  root: 'web',
  plugins: [svelte()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/v1': 'http://localhost:8787' } },
});
