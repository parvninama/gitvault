import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../api/httpServer.ts';
import { TokenStore } from '../api/session.ts';
import { MetadataStore } from '../database/MetadataStore.ts';
import { LocalProviderFactory } from '../repository/factories.ts';
import { RepositoryManager } from '../repository/RepositoryManager.ts';
import { LocalStorageProvider } from '../storage/LocalStorageProvider.ts';
import { StorageService } from '../storage/StorageService.ts';

/** Boots the real route table over node:http with a LOCAL backend in a temp dir. For tests only. */
export async function startTestServer(o: { target?: number; maxRepos?: number; maxFile?: number; clientDist?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-http-'));
  const store = new MetadataStore(':memory:');
  const repos = new RepositoryManager({
    store, factory: new LocalProviderFactory(join(dir, 'repos')), targetSize: o.target ?? 1024 * 1024 * 1024, maxRepositories: o.maxRepos ?? 3,
  });
  const maxFile = o.maxFile ?? 90 * 1024 * 1024;
  const service = new StorageService({
    store, repos, maxFileSize: maxFile, restoreDir: join(dir, 'restored'),
    experimentSandbox: () => new LocalStorageProvider(join(dir, 'sandbox', String(Date.now()) + Math.random())),
  });
  const config = {
    githubClientId: '', githubClientSecret: '', githubCallbackUrl: '', databasePath: ':memory:',
    maxGithubFileSize: maxFile, targetRepositorySize: o.target ?? 1024 * 1024 * 1024, maxRepositories: o.maxRepos ?? 3,
  };
  const server = createHttpServer({ service, config, tokens: new TokenStore(), backend: 'local', clientDist: o.clientDist });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl, store, service, dir,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
