import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../parw/hash.ts';
import { normalizePath } from '../util/paths.ts';
import { StorageError } from './errors.ts';
import type { BackendStats, CommitResult, FileChange, TreeEntry, VersionedBackend } from './backend.ts';

interface LogChange {
  path: string;
  /** SHA-256 of the object, or null for a deletion. */
  object: string | null;
  size: number;
}
interface LogCommit {
  id: string;
  parent: string | null;
  message: string;
  timestamp: string;
  changes: LogChange[];
}

/**
 * A tiny git-like store on the local disk, used for tests and offline experiments.
 * Like git, old objects are retained forever once committed: deleting a path only changes the
 * current tree. Layout: <root>/log.json (commit log) and <root>/objects/<sha256>.
 */
export class LocalVersionedBackend implements VersionedBackend {
  readonly name = 'local';
  private root: string;
  private commits: LogCommit[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<LogCommit[]> {
    if (this.commits) return this.commits;
    try {
      this.commits = JSON.parse(await readFile(join(this.root, 'log.json'), 'utf8')) as LogCommit[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.commits = [];
    }
    return this.commits;
  }

  private objectPath(sha: string): string {
    return join(this.root, 'objects', sha);
  }

  private resolveIndex(commits: LogCommit[], ref?: string): number {
    if (ref === undefined) return commits.length - 1;
    const idx = commits.findIndex((c) => c.id === ref || (ref.length >= 7 && c.id.startsWith(ref)));
    if (idx < 0) throw new StorageError('UNKNOWN_REF', `Unknown commit ${ref}`);
    return idx;
  }

  private treeAt(commits: LogCommit[], upTo: number): Map<string, LogChange> {
    const tree = new Map<string, LogChange>();
    for (let i = 0; i <= upTo; i++) {
      for (const ch of commits[i].changes) {
        if (ch.object === null) tree.delete(ch.path);
        else tree.set(ch.path, ch);
      }
    }
    return tree;
  }

  async headCommit(): Promise<string | null> {
    const commits = await this.load();
    return commits.length ? commits[commits.length - 1].id : null;
  }

  async hasCommit(ref: string): Promise<boolean> {
    const commits = await this.load();
    return commits.some((c) => c.id === ref || (ref.length >= 7 && c.id.startsWith(ref)));
  }

  async getFile(path: string, ref?: string): Promise<Buffer | null> {
    const commits = await this.load();
    const entry = this.treeAt(commits, this.resolveIndex(commits, ref)).get(normalizePath(path));
    return entry?.object ? readFile(this.objectPath(entry.object)) : null;
  }

  async listTree(): Promise<TreeEntry[]> {
    const commits = await this.load();
    return [...this.treeAt(commits, commits.length - 1).values()].map((c) => ({ path: c.path, size: c.size }));
  }

  commit(changes: FileChange[], message: string): Promise<CommitResult> {
    return this.serialize(async () => {
      const commits = await this.load();
      if (changes.length === 0) throw new Error('Empty commit');
      const tree = this.treeAt(commits, commits.length - 1);
      const seen = new Set<string>();
      const logChanges: LogChange[] = [];
      await mkdir(join(this.root, 'objects'), { recursive: true });

      for (const ch of changes) {
        const path = normalizePath(ch.path);
        if (seen.has(path)) throw new Error(`Duplicate path in commit: ${path}`);
        seen.add(path);
        if (ch.data === null) {
          if (!tree.has(path)) throw new StorageError('NOT_FOUND', `Cannot delete missing path ${path}`);
          logChanges.push({ path, object: null, size: 0 });
        } else {
          const sha = sha256Hex(ch.data);
          const p = this.objectPath(sha);
          const exists = await access(p).then(() => true, () => false);
          if (!exists) await writeFile(p, ch.data);
          logChanges.push({ path, object: sha, size: ch.data.length });
        }
      }

      const parent = commits.length ? commits[commits.length - 1].id : null;
      const timestamp = new Date().toISOString();
      const id = createHash('sha1')
        .update(JSON.stringify({ parent, message, timestamp, n: commits.length, logChanges }))
        .digest('hex');
      commits.push({ id, parent, message, timestamp, changes: logChanges });

      const tmp = join(this.root, 'log.json.tmp');
      await writeFile(tmp, JSON.stringify(commits));
      await rename(tmp, join(this.root, 'log.json'));
      return { commitSha: id };
    });
  }

  async stats(): Promise<BackendStats> {
    const commits = await this.load();
    const unique = new Map<string, number>();
    for (const c of commits) for (const ch of c.changes) if (ch.object) unique.set(ch.object, ch.size);
    const current = this.treeAt(commits, commits.length - 1);
    const currentObjects = new Set<string>();
    let currentTreeBytes = 0;
    for (const e of current.values()) {
      currentTreeBytes += e.size;
      if (e.object) currentObjects.add(e.object);
    }
    let historical = 0;
    let retainedOnly = 0;
    for (const [sha, size] of unique) {
      historical += size;
      if (!currentObjects.has(sha)) retainedOnly += size;
    }
    return {
      commits: commits.length,
      binaryObjects: unique.size,
      currentTreeFiles: current.size,
      currentTreeBytes,
      historicalObjectBytes: historical,
      retainedOnlyInHistoryBytes: retainedOnly,
      estimatedRepoBytes: historical,
      measurement: 'exact',
      notes: ['Local simulation: objects are stored uncompressed, so this is an upper-bound model of a git object database.'],
    };
  }
}
