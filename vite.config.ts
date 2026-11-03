import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run client:dev` (UI on :5173, proxies /api to the Express server on :3001).
// Build: `npm run client:build` writes dist/client, which the server serves automatically.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001' } },
});
