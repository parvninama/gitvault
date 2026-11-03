import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DbFileStatus = 'active' | 'archived';

export interface FileRecord {
  virtualPath: string;
  name: string;
  repoId: string;
  backendPath: string;
  status: DbFileStatus;
  mimeType: string;
  originalSize: number;
  parwSize: number;
  originalSha256: string;
  parwSha256: string;
  uploadCommitSha: string;
  /** Commit holding the pointer (when archived). */
  pointerCommitSha: string | null;
  /** Commit the pointer references (where the original blob lives). */
  archivedFromCommitSha: string | null;
  /** Size of the pointer file in the current tree (when archived). */
  pointerBytes: number | null;
  createdAt: string;
  archivedAt: string | null;
  restoredAt: string | null;
}

export interface RepositoryRecord {
  repoId: string;
  owner: string;
  repository: string;
  logicalVolume: string;
  approximateCurrentSize: number;
  approximateHistoricalSize: number;
  status: 'active' | 'full' | 'disabled';
}

export interface Summary {
  activeFiles: number;
  archivedFiles: number;
  activeOriginalBytes: number;
  archivedOriginalBytes: number;
  totalOriginalBytes: number;
  totalParwBytes: number;
}

/** 1 - parw/original, as a fraction (0.096 = 9.6% smaller). 0 for empty files. */
export function compressionRatio(originalSize: number, parwSize: number): number {
  return originalSize === 0 ? 0 : 1 - parwSize / originalSize;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  repo_id TEXT PRIMARY KEY, owner TEXT NOT NULL, repository TEXT NOT NULL,
  logical_volume TEXT NOT NULL DEFAULT 'default',
  approx_current_size INTEGER NOT NULL DEFAULT 0,
  approx_historical_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS files (
  virtual_path TEXT PRIMARY KEY, name TEXT NOT NULL, repo_id TEXT NOT NULL, backend_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','archived')),
  mime_type TEXT NOT NULL, original_size INTEGER NOT NULL, parw_size INTEGER NOT NULL,
  original_sha256 TEXT NOT NULL, parw_sha256 TEXT NOT NULL, upload_commit_sha TEXT NOT NULL,
  pointer_commit_sha TEXT, archived_from_commit_sha TEXT, pointer_bytes INTEGER,
  created_at TEXT NOT NULL, archived_at TEXT, restored_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
`;

type Row = Record<string, unknown>;

function toFile(r: Row): FileRecord {
  return {
    virtualPath: r.virtual_path as string, name: r.name as string, repoId: r.repo_id as string,
    backendPath: r.backend_path as string, status: r.status as DbFileStatus, mimeType: r.mime_type as string,
    originalSize: r.original_size as number, parwSize: r.parw_size as number,
    originalSha256: r.original_sha256 as string, parwSha256: r.parw_sha256 as string,
    uploadCommitSha: r.upload_commit_sha as string,
    pointerCommitSha: (r.pointer_commit_sha as string | null) ?? null,
    archivedFromCommitSha: (r.archived_from_commit_sha as string | null) ?? null,
    pointerBytes: (r.pointer_bytes as number | null) ?? null,
    createdAt: r.created_at as string, archivedAt: (r.archived_at as string | null) ?? null,
    restoredAt: (r.restored_at as string | null) ?? null,
  };
}

export class MetadataStore {
  private db: DatabaseSync;

  /** Pass ":memory:" for tests. */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  insertFile(f: Omit<FileRecord, 'createdAt' | 'archivedAt' | 'restoredAt' | 'pointerCommitSha' | 'archivedFromCommitSha' | 'pointerBytes'>): FileRecord {
    this.db.prepare(`INSERT INTO files (virtual_path,name,repo_id,backend_path,status,mime_type,original_size,parw_size,
        original_sha256,parw_sha256,upload_commit_sha,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.virtualPath, f.name, f.repoId, f.backendPath, f.status, f.mimeType, f.originalSize, f.parwSize,
        f.originalSha256, f.parwSha256, f.uploadCommitSha, new Date().toISOString());
    return this.getFile(f.virtualPath)!;
  }

  getFile(virtualPath: string): FileRecord | null {
    const r = this.db.prepare('SELECT * FROM files WHERE virtual_path = ?').get(virtualPath) as Row | undefined;
    return r ? toFile(r) : null;
  }

  listFiles(status?: DbFileStatus): FileRecord[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM files WHERE status = ? ORDER BY virtual_path').all(status)
      : this.db.prepare('SELECT * FROM files ORDER BY virtual_path').all()) as Row[];
    return rows.map(toFile);
  }

  markArchived(virtualPath: string, a: { pointerCommitSha: string; archivedFromCommitSha: string; pointerBytes: number }): void {
    const r = this.db.prepare(`UPDATE files SET status='archived', pointer_commit_sha=?, archived_from_commit_sha=?, pointer_bytes=?, archived_at=?
      WHERE virtual_path=? AND status='active'`).run(a.pointerCommitSha, a.archivedFromCommitSha, a.pointerBytes, new Date().toISOString(), virtualPath);
    if (r.changes === 0) throw new Error(`No active file ${virtualPath} to mark archived`);
  }

  /** `restoredToTree` flips the status back to active; a local-only restore leaves it archived. */
  markRestored(virtualPath: string, restoredToTree: boolean): void {
    const now = new Date().toISOString();
    const r = restoredToTree
      ? this.db.prepare(`UPDATE files SET status='active', restored_at=?, pointer_commit_sha=NULL, archived_from_commit_sha=NULL, pointer_bytes=NULL
          WHERE virtual_path=? AND status='archived'`).run(now, virtualPath)
      : this.db.prepare('UPDATE files SET restored_at=? WHERE virtual_path=? AND status=\'archived\'').run(now, virtualPath);
    if (r.changes === 0) throw new Error(`No archived file ${virtualPath} to mark restored`);
  }

  upsertRepository(r: RepositoryRecord): void {
    this.db.prepare(`INSERT INTO repositories (repo_id,owner,repository,logical_volume,approx_current_size,approx_historical_size,status)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET owner=excluded.owner, repository=excluded.repository,
      logical_volume=excluded.logical_volume, approx_current_size=excluded.approx_current_size,
      approx_historical_size=excluded.approx_historical_size, status=excluded.status`)
      .run(r.repoId, r.owner, r.repository, r.logicalVolume, r.approximateCurrentSize, r.approximateHistoricalSize, r.status);
  }

  getRepository(repoId: string): RepositoryRecord | null {
    return this.listRepositories().find((r) => r.repoId === repoId) ?? null;
  }

  listRepositories(): RepositoryRecord[] {
    return (this.db.prepare('SELECT * FROM repositories ORDER BY repo_id').all() as Row[]).map((r) => ({
      repoId: r.repo_id as string, owner: r.owner as string, repository: r.repository as string,
      logicalVolume: r.logical_volume as string, approximateCurrentSize: r.approx_current_size as number,
      approximateHistoricalSize: r.approx_historical_size as number, status: r.status as RepositoryRecord['status'],
    }));
  }

  summary(): Summary {
    const r = this.db.prepare(`SELECT
      COALESCE(SUM(status='active'),0) AS a_n, COALESCE(SUM(status='archived'),0) AS r_n,
      COALESCE(SUM(CASE WHEN status='active' THEN original_size END),0) AS a_b,
      COALESCE(SUM(CASE WHEN status='archived' THEN original_size END),0) AS r_b,
      COALESCE(SUM(original_size),0) AS o_b, COALESCE(SUM(parw_size),0) AS p_b FROM files`).get() as Row;
    return {
      activeFiles: Number(r.a_n), archivedFiles: Number(r.r_n),
      activeOriginalBytes: Number(r.a_b), archivedOriginalBytes: Number(r.r_b),
      totalOriginalBytes: Number(r.o_b), totalParwBytes: Number(r.p_b),
    };
  }
}
