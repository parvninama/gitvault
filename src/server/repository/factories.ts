import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RepositoryRecord } from '../database/MetadataStore.ts';
import type { GitHubClient } from '../github/GitHubClient.ts';
import { GitHubStorageProvider } from '../github/GitHubStorageProvider.ts';
import { LocalStorageProvider } from '../storage/LocalStorageProvider.ts';
import type { StorageProvider } from '../storage/types.ts';
import type { ProviderFactory } from './RepositoryManager.ts';

export class LocalProviderFactory implements ProviderFactory {
  private root: string;
  private maxFileSize?: number;
  constructor(root: string, maxFileSize?: number) {
    this.root = root;
    this.maxFileSize = maxFileSize;
  }
  async createRepository(repoId: string) {
    const repository = `mycloud-${repoId.slice('repo-'.length)}`;
    mkdirSync(join(this.root, repository), { recursive: true });
    return { owner: 'local', repository };
  }
  openProvider(r: RepositoryRecord): StorageProvider {
    return new LocalStorageProvider(join(this.root, r.repository), { maxFileSize: this.maxFileSize });
  }
}

/** Creates PRIVATE repositories named <prefix>NN under the authenticated user. Needs the `repo` scope. */
export class GitHubProviderFactory implements ProviderFactory {
  private client: GitHubClient;
  private owner: string | (() => string);
  private prefix: string;
  private maxFileSize?: number;
  constructor(a: { client: GitHubClient; owner: string | (() => string); prefix?: string; maxFileSize?: number }) {
    this.client = a.client;
    this.owner = a.owner;
    this.prefix = a.prefix ?? 'mycloud-';
    this.maxFileSize = a.maxFileSize;
  }
  private ownerName(): string {
    return typeof this.owner === 'function' ? this.owner() : this.owner;
  }
  async createRepository(repoId: string) {
    const repository = `${this.prefix}${repoId.slice('repo-'.length)}`;
    // 422 = already exists: adopt it rather than failing.
    const res = await this.client.request('POST', '/user/repos', {
      body: { name: repository, private: true, auto_init: false, description: 'gitvault-poc storage repository (experimental)' },
      allow: [422],
    });
    if (!res.ok) await this.client.json('GET', `/repos/${this.ownerName()}/${repository}`);
    return { owner: this.ownerName(), repository };
  }
  openProvider(r: RepositoryRecord): StorageProvider {
    return new GitHubStorageProvider({ client: this.client, owner: r.owner, repo: r.repository, maxFileSize: this.maxFileSize });
  }
}
