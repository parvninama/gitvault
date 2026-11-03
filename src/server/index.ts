import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { MetadataStore } from './database/MetadataStore.ts';
import { TokenStore } from './api/session.ts';
import type { AppDeps } from './api/routes.ts';
import { GitHubClient } from './github/GitHubClient.ts';
import { GitHubProviderFactory, LocalProviderFactory } from './repository/factories.ts';
import { RepositoryManager } from './repository/RepositoryManager.ts';
import { LocalStorageProvider } from './storage/LocalStorageProvider.ts';
import { StorageService } from './storage/StorageService.ts';

const config = loadConfig();
const backend = process.env.STORAGE_BACKEND === 'github' ? 'github' : 'local';
const dataDir = dirname(config.databasePath);
const tokens = new TokenStore();
const store = new MetadataStore(config.databasePath);

const factory = backend === 'github'
  ? new GitHubProviderFactory({ client: new GitHubClient({ getToken: () => tokens.require() }), owner: () => tokens.login ?? '', maxFileSize: config.maxGithubFileSize })
  : new LocalProviderFactory(join(dataDir, 'local-repos'), config.maxGithubFileSize);

const repos = new RepositoryManager({ store, factory, targetSize: config.targetRepositorySize, maxRepositories: config.maxRepositories });
const service = new StorageService({
  store, repos, maxFileSize: config.maxGithubFileSize, restoreDir: join(dataDir, 'restored'),
  // Local mode: experiments run in an isolated throwaway simulation and never touch the real volume.
  experimentSandbox: backend === 'local'
    ? () => new LocalStorageProvider(join(dataDir, 'experiments', new Date().toISOString().replace(/[:.]/g, '-')), { maxFileSize: config.maxGithubFileSize })
    : undefined,
});

const clientDist = resolve('dist/client');
const deps: AppDeps = {
  service, config, tokens, backend, clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  clientDist: existsSync(clientDist) ? clientDist : undefined,
};
const port = Number(process.env.PORT ?? 3001);
const host = '127.0.0.1';

let hostName = 'express';
try {
  const { createApp } = await import('./api/app.ts');
  createApp(deps).listen(port, host, () => announce());
} catch (e) {
  if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw e;
  hostName = 'node:http fallback (express is not installed; same routes)';
  const { createHttpServer } = await import('./api/httpServer.ts');
  createHttpServer(deps).listen(port, host, () => announce());
}

function announce() {
  console.log(`gitvault-poc on http://${host}:${port}  backend=${backend}${backend === 'github' ? ' (EXPERIMENTAL)' : ''}  host=${hostName}`);
  console.log(deps.clientDist ? `serving UI from ${deps.clientDist}` : 'no UI build found: run `npm run client:build` (or `npm run client:dev` for Vite)');
}
