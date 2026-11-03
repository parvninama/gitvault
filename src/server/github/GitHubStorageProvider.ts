import { VersionedStorageProvider } from '../storage/VersionedStorageProvider.ts';
import { GitHubBackend } from './GitHubBackend.ts';
import type { GitHubClient } from './GitHubClient.ts';

export interface GitHubProviderArgs {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch?: string;
  /** Target size for one encoded file (default 90 MiB). */
  maxFileSize?: number;
}

/** StorageProvider for ONE GitHub repository. Multi-repo pooling is layered on top (RepositoryManager). */
export class GitHubStorageProvider extends VersionedStorageProvider {
  readonly owner: string;
  readonly repo: string;
  constructor(a: GitHubProviderArgs) {
    super(new GitHubBackend(a.client, { owner: a.owner, repo: a.repo, branch: a.branch }), { maxFileSize: a.maxFileSize });
    this.owner = a.owner;
    this.repo = a.repo;
  }
}
