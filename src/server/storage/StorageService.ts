import { join } from 'node:path';
import { compressionRatio } from '../database/MetadataStore.ts';
import type { FileRecord, MetadataStore } from '../database/MetadataStore.ts';
import { decodeParw, encodeParw, readParwMetadata } from '../parw/format.ts';
import { sha256Hex } from '../parw/hash.ts';
import { CapacityError } from '../repository/RepositoryManager.ts';
import type { RepositoryManager } from '../repository/RepositoryManager.ts';
import { normalizePath } from '../util/paths.ts';
import { runExperiment } from '../experiment/gitHistoryExperiment.ts';
import type { ExperimentResult } from '../experiment/gitHistoryExperiment.ts';
import { StorageError } from './errors.ts';
import type { RestoreResult, RestoreStep, RestoreStepName, StorageProvider, UsageReport } from './types.ts';

export { CapacityError };

export interface FileView {
  virtualPath: string;
  name: string;
  status: 'active' | 'archived';
  originalSize: number;
  storedSize: number;
  compressionRatio: number;
  repoId: string;
  repository: string;
  sha256: string;
  parwSha256: string;
  mimeType: string;
  /** Bytes this file occupies in the CURRENT git tree: the PARW file, or only the pointer if archived. */
  currentRepoFootprint: number;
  archivedFromCommitSha: string | null;
  createdAt: string;
  archivedAt: string | null;
  restoredAt: string | null;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  file?: FileView;
  children?: TreeNode[];
}

export interface Dashboard {
  tree: { files: number; logicalBytes: number; currentRepoBytes: number };
  historical: {
    archivedFiles: number;
    archivedOriginalBytes: number;
    /** Bytes THIS APP has pushed that must be assumed retained in Git history (PARW files + pointers). */
    inferredRetainedBytes: number;
    /** Backend-reported figures; null when the backend API does not expose them. */
    measuredObjectBytes: number | null;
    estimatedRepoBytes: number | null;
    commits: number;
    binaryObjects: number | null;
  };
  compression: { originalBytes: number; parwBytes: number; ratio: number };
  repositories: { files: number; activeFiles: number; archivedFiles: number; repoId: string; owner: string; repository: string; status: string; approximateCurrentSize: number; approximateHistoricalSize: number; targetSize: number; usage: UsageReport | null }[];
  targetRepositorySize: number;
  maxRepositories: number;
  notes: string[];
}

export interface UploadPreview {
  virtualPath: string;
  originalSize: number;
  parwSize: number | null;
  compressionRatio: number | null;
  compression: 'zstd' | 'none' | null;
  targetRepository: string | null;
  status: 'ready' | 'exists' | 'requires-chunking' | 'no-capacity' | 'invalid-path';
  message?: string;
}

export function buildVirtualTree(files: FileView[]): TreeNode {
  const root: TreeNode = { name: '/', path: '', type: 'dir', children: [] };
  for (const f of files) {
    const parts = f.virtualPath.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      if (i === parts.length - 1) {
        node.children!.push({ name: part, path, type: 'file', file: f });
      } else {
        let dir = node.children!.find((c) => c.type === 'dir' && c.name === part);
        if (!dir) { dir = { name: part, path, type: 'dir', children: [] }; node.children!.push(dir); }
        node = dir;
      }
    });
  }
  const sort = (n: TreeNode) => {
    n.children?.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    n.children?.forEach(sort);
  };
  sort(root);
  return root;
}

export interface ServiceOptions {
  store: MetadataStore;
  repos: RepositoryManager;
  /** Encoded files above this are refused (and must be chunked) BEFORE any repo is allocated. */
  maxFileSize: number;
  /** Directory restored originals are written to. */
  restoreDir: string;
  /** If set, experiments run in this isolated provider instead of a real repository of the volume. */
  experimentSandbox?: () => StorageProvider;
}

/** Orchestrates encode -> allocate repo -> provider -> SQLite. One logical volume over many repositories. */
export class StorageService {
  private o: ServiceOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: ServiceOptions) {
    this.o = o;
  }

  /** Mutations run one at a time so repository accounting cannot race. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private view(r: FileRecord): FileView {
    const repo = this.o.repos.list().find((x) => x.repoId === r.repoId);
    return {
      virtualPath: r.virtualPath, name: r.name, status: r.status, originalSize: r.originalSize, storedSize: r.parwSize,
      compressionRatio: compressionRatio(r.originalSize, r.parwSize), repoId: r.repoId,
      repository: repo ? `${repo.owner}/${repo.repository}` : r.repoId, sha256: r.originalSha256, parwSha256: r.parwSha256,
      mimeType: r.mimeType, currentRepoFootprint: r.status === 'archived' ? (r.pointerBytes ?? 0) : r.parwSize,
      archivedFromCommitSha: r.archivedFromCommitSha, createdAt: r.createdAt, archivedAt: r.archivedAt, restoredAt: r.restoredAt,
    };
  }

  list(status?: 'active' | 'archived'): FileView[] {
    return this.o.store.listFiles(status).map((r) => this.view(r));
  }

  tree(): TreeNode {
    return buildVirtualTree(this.list());
  }

  upload(a: { virtualPath: string; data: Buffer; mimeType?: string }): Promise<FileView> {
    return this.exclusive(async () => {
      const virtualPath = normalizePath(a.virtualPath);
      if (this.o.store.getFile(virtualPath)) throw new StorageError('ALREADY_EXISTS', `${virtualPath} already exists`);
      const name = virtualPath.split('/').pop()!;
      const originalSha256 = sha256Hex(a.data);                    // 2. SHA-256
      const parw = encodeParw({ data: a.data, filename: name, mimeType: a.mimeType }); // 3. PARW
      if (parw.length > this.o.maxFileSize) {                      // 4. size check, before touching any repo
        throw new StorageError('REQUIRES_CHUNKING', `Encoded size ${parw.length} exceeds ${this.o.maxFileSize}; this file requires chunking (experimental, not wired into upload yet)`);
      }
      const { record, provider } = await this.o.repos.allocate(parw.length);
      const up = await provider.uploadFile({ virtualPath, parw });  // 5. upload
      this.o.repos.recordUpload(record.repoId, parw.length);
      const row = this.o.store.insertFile({                         // 6. metadata
        virtualPath, name, repoId: record.repoId, backendPath: up.backendPath, status: 'active',
        mimeType: up.metadata.mimeType, originalSize: a.data.length, parwSize: parw.length,
        originalSha256, parwSha256: up.parwSha256, uploadCommitSha: up.commitSha,
      });
      return this.view(row);                                        // 7. return
    });
  }

  archive(virtualPath: string): Promise<FileView> {
    return this.exclusive(async () => {
      const rec = this.mustGet(virtualPath);
      if (rec.status !== 'active') throw new StorageError('ALREADY_ARCHIVED', `${virtualPath} is already archived`);
      const a = await this.o.repos.provider(rec.repoId).archiveFile(rec.virtualPath);
      this.o.store.markArchived(rec.virtualPath, {
        pointerCommitSha: a.commitSha, archivedFromCommitSha: a.pointer.commitSha, pointerBytes: a.pointerBytes,
      });
      this.o.repos.recordArchive(rec.repoId, rec.parwSize, a.pointerBytes);
      return this.view(this.mustGet(virtualPath));
    });
  }

  restore(virtualPath: string, opts: { restoreToTree?: boolean; onStep?: (s: RestoreStep) => void; onStepStart?: (s: RestoreStepName) => void | Promise<void> } = {}): Promise<{ file: FileView; result: Omit<RestoreResult, 'data'> }> {
    return this.exclusive(async () => {
      const rec = this.mustGet(virtualPath);
      if (rec.status !== 'archived') throw new StorageError('NOT_ARCHIVED', `${virtualPath} is not archived`);
      const outputPath = join(this.o.restoreDir, rec.virtualPath);
      const { data: _data, ...result } = await this.o.repos.provider(rec.repoId).restoreFile(rec.virtualPath, {
        outputPath, restoreToTree: opts.restoreToTree, expectedOriginalSha256: rec.originalSha256, onStep: opts.onStep, onStepStart: opts.onStepStart,
      });
      this.o.store.markRestored(rec.virtualPath, !!opts.restoreToTree);
      if (opts.restoreToTree) this.o.repos.recordRestoreToTree(rec.repoId, rec.parwSize, rec.pointerBytes ?? 0);
      return { file: this.view(this.mustGet(virtualPath)), result };
    });
  }

  /**
   * Runs the history experiment. With an experimentSandbox (local mode) it runs in an isolated throwaway provider and
   * touches nothing else. Otherwise it runs inside a real repository of the volume, and its test blobs stay in Git history.
   */
  runExperiment(sizesBytes: number[], kind: 'random' | 'compressible' = 'random'): Promise<{ result: ExperimentResult; sandboxed: boolean }> {
    return this.exclusive(async () => {
      if (this.o.experimentSandbox) {
        return { result: await runExperiment(this.o.experimentSandbox(), { sizes: sizesBytes, kind }), sandboxed: true };
      }
      const total = sizesBytes.reduce((n, x) => n + x, 0) * 2; // each file is committed, archived, restored: budget generously
      const { record, provider } = await this.o.repos.allocate(total);
      try {
        return { result: await runExperiment(provider, { sizes: sizesBytes, kind }), sandboxed: false };
      } finally {
        await this.o.repos.refresh(record.repoId); // experiment files are not in SQLite, so re-measure
      }
    });
  }

  /** Dry run for the upload page: encode, check, and say where the file WOULD go. Writes nothing. */
  async preview(a: { virtualPath: string; data: Buffer; mimeType?: string }): Promise<UploadPreview> {
    const base = { virtualPath: a.virtualPath, originalSize: a.data.length };
    let virtualPath: string;
    try { virtualPath = normalizePath(a.virtualPath); } catch (e) {
      return { ...base, parwSize: null, compressionRatio: null, compression: null, targetRepository: null, status: 'invalid-path', message: (e as Error).message };
    }
    const parw = encodeParw({ data: a.data, filename: virtualPath.split('/').pop()!, mimeType: a.mimeType });
    const common = {
      virtualPath, originalSize: a.data.length, parwSize: parw.length,
      compressionRatio: compressionRatio(a.data.length, parw.length), compression: readParwMetadata(parw).metadata.compression,
    };
    if (this.o.store.getFile(virtualPath)) return { ...common, targetRepository: null, status: 'exists', message: `${virtualPath} already exists` };
    if (parw.length > this.o.maxFileSize) {
      return { ...common, targetRepository: null, status: 'requires-chunking', message: `Encoded size exceeds the ${this.o.maxFileSize}-byte target; chunking is not integrated yet` };
    }
    try {
      return { ...common, targetRepository: this.o.repos.peek(parw.length).label, status: 'ready' };
    } catch (e) {
      if (e instanceof CapacityError) return { ...common, targetRepository: null, status: 'no-capacity', message: e.message };
      throw e;
    }
  }

  /** Returns the ORIGINAL bytes of an active file, decoded and checksum-verified. */
  async download(virtualPath: string): Promise<{ data: Buffer; filename: string; mimeType: string }> {
    const rec = this.mustGet(virtualPath);
    if (rec.status !== 'active') throw new StorageError('NOT_FOUND', `${virtualPath} is archived; restore it first`);
    const parw = await this.o.repos.provider(rec.repoId).downloadFile(rec.virtualPath);
    if (sha256Hex(parw) !== rec.parwSha256) throw new Error(`Stored PARW for ${virtualPath} failed SHA-256 verification`);
    const { data, metadata } = decodeParw(parw); // verifies the original SHA-256 too
    if (metadata.sha256 !== rec.originalSha256) throw new Error('Original checksum differs from the database record');
    return { data, filename: rec.name, mimeType: rec.mimeType };
  }

  private mustGet(virtualPath: string): FileRecord {
    const rec = this.o.store.getFile(normalizePath(virtualPath));
    if (!rec) throw new StorageError('NOT_FOUND', `No such file ${virtualPath}`);
    return rec;
  }

  async dashboard(opts: { measure?: boolean } = {}): Promise<Dashboard> {
    const s = this.o.store.summary();
    const files = this.o.store.listFiles();
    const repos = this.o.repos.list();
    const usages: (UsageReport | null)[] = [];
    for (const r of repos) {
      if (opts.measure === false) { usages.push(null); continue; }
      usages.push(await this.o.repos.provider(r.repoId).getUsage());
    }
    const sum = (f: (u: UsageReport) => number | null): number | null => {
      let n = 0;
      for (const u of usages) { const v = u ? f(u) : null; if (v === null) return null; n += v; }
      return n;
    };
    const pointerBytes = files.reduce((n, f) => n + (f.pointerBytes ?? 0), 0);
    const notes = new Set<string>();
    usages.forEach((u) => u?.notes.forEach((n) => notes.add(n)));
    notes.add('Archiving replaces a file with a pointer in the current tree. It does NOT remove the original blob from Git history, so historical and repository size do not shrink.');
    return {
      tree: {
        files: s.activeFiles, logicalBytes: s.activeOriginalBytes,
        currentRepoBytes: usages.every((u) => u) ? usages.reduce((n, u) => n + u!.currentTreeBytes, 0) : repos.reduce((n, r) => n + r.approximateCurrentSize, 0),
      },
      historical: {
        archivedFiles: s.archivedFiles, archivedOriginalBytes: s.archivedOriginalBytes,
        inferredRetainedBytes: s.totalParwBytes + pointerBytes,
        measuredObjectBytes: usages.length ? sum((u) => u.historicalObjectBytes) : 0,
        estimatedRepoBytes: usages.length ? sum((u) => u.estimatedRepoBytes) : 0,
        commits: usages.reduce((n, u) => n + (u?.commits ?? 0), 0),
        binaryObjects: usages.length ? sum((u) => u.binaryObjects) : 0,
      },
      compression: { originalBytes: s.totalOriginalBytes, parwBytes: s.totalParwBytes, ratio: compressionRatio(s.totalOriginalBytes, s.totalParwBytes) },
      repositories: repos.map((r, i) => {
        const mine = files.filter((f) => f.repoId === r.repoId);
        const archived = mine.filter((f) => f.status === 'archived').length;
        return { ...r, files: mine.length, activeFiles: mine.length - archived, archivedFiles: archived, targetSize: this.targetSize, usage: usages[i] };
      }),
      targetRepositorySize: this.targetSize, maxRepositories: this.maxRepos, notes: [...notes],
    };
  }

  get targetSize(): number { return this.o.repos.targetSize; }
  get maxRepos(): number { return this.o.repos.maxRepos; }
}
