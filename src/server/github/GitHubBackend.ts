import type { BackendStats, CommitResult, FileChange, TreeEntry, VersionedBackend } from '../storage/backend.ts';
import { normalizePath } from '../util/paths.ts';
import { GitHubApiError } from './GitHubClient.ts';
import type { GitHubClient } from './GitHubClient.ts';

const RAW = 'application/vnd.github.raw+json';
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/**
 * VersionedBackend over the GitHub REST (Git Data) API.
 * A multi-file change becomes: blobs -> tree -> commit -> fast-forward ref update, i.e. ONE commit.
 */
export class GitHubBackend implements VersionedBackend {
  readonly name = 'github';
  private client: GitHubClient;
  private base: string;
  private branch: string;

  constructor(client: GitHubClient, args: { owner: string; repo: string; branch?: string }) {
    this.client = client;
    this.base = `/repos/${args.owner}/${args.repo}`;
    this.branch = args.branch ?? 'main';
  }

  async headCommit(): Promise<string | null> {
    const res = await this.client.request('GET', `${this.base}/git/ref/heads/${this.branch}`, { allow: [404, 409] });
    if (!res.ok) return null; // missing branch / empty repository
    return ((await res.json()) as { object: { sha: string } }).object.sha;
  }

  async hasCommit(ref: string): Promise<boolean> {
    const res = await this.client.request('GET', `${this.base}/commits/${encodeURIComponent(ref)}`, { allow: [404, 422] });
    return res.ok;
  }

  async getFile(path: string, ref?: string): Promise<Buffer | null> {
    const res = await this.client.request('GET', `${this.base}/contents/${encodePath(normalizePath(path))}`, {
      accept: RAW, query: ref ? { ref } : undefined, allow: [404],
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }

  async listTree(): Promise<TreeEntry[]> {
    const head = await this.headCommit();
    if (!head) return [];
    const commit = await this.client.json<{ tree: { sha: string } }>('GET', `${this.base}/git/commits/${head}`);
    const tree = await this.client.json<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(
      'GET', `${this.base}/git/trees/${commit.tree.sha}`, { query: { recursive: '1' } },
    );
    if (tree.truncated) throw new Error('GitHub truncated the tree listing; repository has too many entries for this POC');
    return tree.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size ?? 0 }));
  }

  async commit(changes: FileChange[], message: string): Promise<CommitResult> {
    if (changes.length === 0) throw new Error('Empty commit');
    let head = await this.headCommit();
    if (!head) {
      // The Git Data API refuses to write into a completely empty repository; seed it via the Contents API.
      await this.client.json('PUT', `${this.base}/contents/README.md`, {
        body: { message: 'Initialise repository', branch: this.branch,
          content: Buffer.from('# Storage repository\n\nManaged by gitvault-poc (experimental).\n').toString('base64') },
      });
      head = await this.headCommit();
      if (!head) throw new Error('Repository still empty after initialisation');
    }
    const parent = await this.client.json<{ tree: { sha: string } }>('GET', `${this.base}/git/commits/${head}`);

    const entries: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
    for (const ch of changes) {
      const path = normalizePath(ch.path);
      if (ch.data === null) {
        entries.push({ path, mode: '100644', type: 'blob', sha: null }); // null sha = delete
      } else {
        const blob = await this.client.json<{ sha: string }>('POST', `${this.base}/git/blobs`, {
          body: { content: ch.data.toString('base64'), encoding: 'base64' },
        });
        entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    const tree = await this.client.json<{ sha: string }>('POST', `${this.base}/git/trees`, {
      body: { base_tree: parent.tree.sha, tree: entries },
    });
    const commit = await this.client.json<{ sha: string }>('POST', `${this.base}/git/commits`, {
      body: { message, tree: tree.sha, parents: [head] },
    });
    try {
      await this.client.json('PATCH', `${this.base}/git/refs/heads/${this.branch}`, { body: { sha: commit.sha, force: false } });
    } catch (e) {
      if (e instanceof GitHubApiError && e.status === 422) throw new Error('Branch moved during commit (non-fast-forward); retry');
      throw e;
    }
    return { commitSha: commit.sha };
  }

  async stats(): Promise<BackendStats> {
    const repo = await this.client.json<{ size: number }>('GET', `${this.base}`);
    const list = await this.client.request('GET', `${this.base}/commits`, { query: { sha: this.branch, per_page: '1' }, allow: [409] });
    let commits = 0;
    if (list.ok) {
      const last = /[?&]page=(\d+)>; rel="last"/.exec(list.headers.get('link') ?? '');
      commits = last ? Number(last[1]) : ((await list.json()) as unknown[]).length;
    }
    const tree = await this.listTree();
    return {
      commits,
      binaryObjects: null,
      currentTreeFiles: tree.length,
      currentTreeBytes: tree.reduce((n, e) => n + e.size, 0),
      historicalObjectBytes: null,
      retainedOnlyInHistoryBytes: null,
      estimatedRepoBytes: repo.size * 1024,
      measurement: 'estimated',
      notes: [
        'estimatedRepoBytes is GitHub\'s repository "size" field (KB, rounded, may lag behind pushes); it is the only server-side size signal the REST API exposes.',
        'Historical object bytes are not exposed by the REST API. The experiment infers them from what this app has committed.',
      ],
    };
  }
}
