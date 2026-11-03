// Fallback client build using esbuild directly (Vite uses esbuild internally). Produces the same dist/client layout.
// Use `npm run client:build` (Vite) normally; this exists for environments where Vite cannot be installed.
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

rmSync('dist/client', { recursive: true, force: true });
mkdirSync('dist/client/assets', { recursive: true });
await esbuild.build({
  entryPoints: ['src/client/main.tsx'], bundle: true, minify: true, sourcemap: true, format: 'esm', target: 'es2022',
  jsx: 'automatic', outdir: 'dist/client/assets', entryNames: 'app', define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'css' },
  nodePaths: (process.env.NODE_PATH ?? '').split(':').filter(Boolean), // only needed with globally installed packages
});
writeFileSync('dist/client/index.html', `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitVault (experimental)</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`);
console.log('built dist/client');
