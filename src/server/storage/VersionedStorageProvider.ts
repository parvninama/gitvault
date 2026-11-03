import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decodeParw, readParwMetadata } from '../parw/format.ts';
import { sha256Hex } from '../parw/hash.ts';
import { normalizePath } from '../util/paths.ts';
import type { VersionedBackend } from './backend.ts';
import { StorageError } from './errors.ts';
import { createPointer, parsePointer, pointerPathFor, POINTER_SUFFIX } from './pointer.ts';
import type {
  ArchiveResult, FileMetadata, RestoreOptions, RestoreResult, RestoreStep, RestoreStepName,
  StorageProvider, UploadRequest, UploadResult, UsageReport,
} from './types.ts';

export const DEFAULT_MAX_FILE_SIZE = 90 * 1024 * 1024; // 90 MiB: deliberately below GitHub's 100 MB hard limit

export class RestoreError extends StorageError {
  step: RestoreStepName;
  steps: RestoreStep[];
  constructor(step: RestoreStepName, message: string, steps: RestoreStep[]) {
    super('RESTORE_FAILED', `Restore failed at "${step}": ${message}`);
    this.name = 'RestoreError';
    this.step = step;
    this.steps = steps;
  }
}

export interface ProviderOptions {
  maxFileSize?: number;
}

export function backendPathFor(virtualPath: string): string {
  return normalizePath(virtualPath) + '.parw';
}

/** Provider logic shared by every versioned backend (local simulation, GitHub). */
export class VersionedStorageProvider implements StorageProvider {
  protected backend: VersionedBackend;
  protected maxFileSize: number;

  constructor(backend: VersionedBackend, opts: ProviderOptions = {}) {
    this.backend = backend;
    this.maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  }

  async listFiles(): Promise<FileMetadata[]> {
    const out: FileMetadata[] = [];
    for (const e of await this.backend.listTree()) {
      if (e.path.endsWith('.parw')) {
        out.push({ virtualPath: e.path.slice(0, -5), backendPath: e.path, status: 'active', treeBytes: e.size });
      } else if (e.path.endsWith('.parw' + POINTER_SUFFIX)) {
        out.push({
          virtualPath: e.path.slice(0, -('.parw' + POINTER_SUFFIX).length),
          backendPath: e.path.slice(0, -POINTER_SUFFIX.length),
          status: 'archived',
          treeBytes: e.size,
        });
      }
    }
    return out.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));
  }

  async uploadFile(req: UploadRequest): Promise<UploadResult> {
    const backendPath = backendPathFor(req.virtualPath);
    const { metadata } = readParwMetadata(req.parw); // rejects non-PARW input
    if (req.parw.length > this.maxFileSize) {
      throw new StorageError(
        'REQUIRES_CHUNKING',
        `Encoded file is ${req.parw.length} bytes, above the ${this.maxFileSize}-byte target; it requires chunking`,
      );
    }
    // Never silently overwrite: an existing file or an archived pointer both count as "exists".
    const tree = new Set((await this.backend.listTree()).map((e) => e.path));
    if (tree.has(backendPath) || tree.has(pointerPathFor(backendPath))) {
      throw new StorageError('ALREADY_EXISTS', `${req.virtualPath} already exists`);
    }
    const { commitSha } = await this.backend.commit([{ path: backendPath, data: req.parw }], `add ${backendPath}`);
    return {
      virtualPath: normalizePath(req.virtualPath), backendPath, commitSha,
      parwSha256: sha256Hex(req.parw), parwSize: req.parw.length, metadata,
    };
  }

  async downloadFile(virtualPath: string): Promise<Buffer> {
    const data = await this.backend.getFile(backendPathFor(virtualPath));
    if (!data) throw new StorageError('NOT_FOUND', `No active file at ${virtualPath}`);
    return data;
  }

  async archiveFile(virtualPath: string): Promise<ArchiveResult> {
    const backendPath = backendPathFor(virtualPath);
    const pointerPath = pointerPathFor(backendPath);
    const current = await this.backend.getFile(backendPath);
    if (!current) {
      if (await this.backend.getFile(pointerPath)) throw new StorageError('ALREADY_ARCHIVED', `${virtualPath} is already archived`);
      throw new StorageError('NOT_FOUND', `No file at ${virtualPath}`);
    }
    // 1-3: record the commit that still contains the file, its path and its PARW hash.
    const headBefore = await this.backend.headCommit();
    if (!headBefore) throw new StorageError('NOT_FOUND', 'Repository has no commits');
    const { pointer, bytes } = createPointer({
      originalPath: backendPath, commitSha: headBefore, sha256: sha256Hex(current), size: current.length,
    });
    // 4-5: delete the original and add the pointer in a single commit. The old blob stays in history.
    const { commitSha } = await this.backend.commit(
      [{ path: backendPath, data: null }, { path: pointerPath, data: bytes }],
      `archive ${backendPath}`,
    );
    return { virtualPath: normalizePath(virtualPath), pointerPath, pointer, commitSha, pointerBytes: bytes.length };
  }

  async restoreFile(virtualPath: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
    const backendPath = backendPathFor(virtualPath);
    const pointerPath = pointerPathFor(backendPath);
    const steps: RestoreStep[] = [];

    const run = async <T>(step: RestoreStepName, fn: () => Promise<T> | T, detail?: (v: T) => string): Promise<T> => {
      await opts.onStepStart?.(step);
      const t0 = performance.now();
      try {
        const v = await fn();
        const rec: RestoreStep = { step, status: 'ok', ms: Math.round(performance.now() - t0), detail: detail?.(v) };
        steps.push(rec);
        opts.onStep?.(rec);
        return v;
      } catch (e) {
        const msg = (e as Error).message;
        const rec: RestoreStep = { step, status: 'failed', ms: Math.round(performance.now() - t0), detail: msg };
        steps.push(rec);
        opts.onStep?.(rec);
        throw new RestoreError(step, msg, steps); // abort: nothing after a failed check runs
      }
    };

    const pointer = await run('read-pointer', async () => {
      const bytes = await this.backend.getFile(pointerPath);
      if (!bytes) throw new StorageError('NOT_ARCHIVED', `No pointer at ${pointerPath}`);
      const p = parsePointer(bytes);
      if (p.originalPath !== backendPath) throw new Error(`Pointer targets ${p.originalPath}, expected ${backendPath}`);
      return p;
    }, (p) => `commit ${p.commitSha.slice(0, 12)}, ${p.size} bytes`);

    await run('locate-commit', async () => {
      if (!(await this.backend.hasCommit(pointer.commitSha))) {
        throw new Error(`Commit ${pointer.commitSha} no longer exists in the repository (history rewritten or garbage-collected?)`);
      }
    });

    const parw = await run('fetch-historical', async () => {
      const data = await this.backend.getFile(pointer.originalPath, pointer.commitSha);
      if (!data) throw new Error(`${pointer.originalPath} not found at commit ${pointer.commitSha}`);
      return data;
    }, (d) => `${d.length} bytes`);

    await run('verify-parw-sha256', () => {
      if (parw.length !== pointer.size) throw new Error(`size ${parw.length} != pointer size ${pointer.size}`);
      const actual = sha256Hex(parw);
      if (actual !== pointer.sha256) throw new Error(`expected ${pointer.sha256}, got ${actual}`);
    });

    const decoded = await run('decode-parw', () => decodeParw(parw), (d) => `${d.metadata.compression}, ${d.data.length} bytes`);

    await run('verify-original-sha256', () => {
      const actual = sha256Hex(decoded.data);
      if (actual !== decoded.metadata.sha256) throw new Error(`expected ${decoded.metadata.sha256}, got ${actual}`);
      if (opts.expectedOriginalSha256 && actual !== opts.expectedOriginalSha256) {
        throw new Error(`database expects ${opts.expectedOriginalSha256}, got ${actual}`);
      }
    });

    if (opts.outputPath) {
      await run('write-local', async () => {
        await mkdir(dirname(opts.outputPath!), { recursive: true });
        await writeFile(opts.outputPath!, decoded.data);
      }, () => opts.outputPath!);
    }

    let commitSha: string | undefined;
    if (opts.restoreToTree) {
      commitSha = await run('restore-to-tree', async () => {
        const r = await this.backend.commit(
          [{ path: pointerPath, data: null }, { path: backendPath, data: parw }],
          `restore ${backendPath}`,
        );
        return r.commitSha;
      }, (c) => `commit ${c.slice(0, 12)}`);
    }

    return {
      data: decoded.data, metadata: decoded.metadata, steps,
      outputPath: opts.outputPath, restoredToTree: !!opts.restoreToTree, commitSha,
    };
  }

  getUsage(): Promise<UsageReport> {
    return this.backend.stats();
  }
}
