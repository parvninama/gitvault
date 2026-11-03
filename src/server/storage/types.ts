import type { ParwMetadata } from '../parw/format.ts';
import type { BackendStats } from './backend.ts';
import type { ParwPointer } from './pointer.ts';

export type FileStatus = 'active' | 'archived';

/** Tree-level view of a file. Rich metadata (sizes, ratio) lives in SQLite / the PARW header. */
export interface FileMetadata {
  virtualPath: string;
  backendPath: string;
  status: FileStatus;
  /** Bytes this file occupies in the CURRENT tree (a pointer, if archived). */
  treeBytes: number;
}

export interface UploadRequest {
  virtualPath: string;
  /** Fully encoded PARW bytes. */
  parw: Buffer;
}

export interface UploadResult {
  virtualPath: string;
  backendPath: string;
  commitSha: string;
  parwSha256: string;
  parwSize: number;
  metadata: ParwMetadata;
}

export interface ArchiveResult {
  virtualPath: string;
  pointerPath: string;
  pointer: ParwPointer;
  /** Commit that removed the original and added the pointer. */
  commitSha: string;
  pointerBytes: number;
}

export type RestoreStepName =
  | 'read-pointer'
  | 'locate-commit'
  | 'fetch-historical'
  | 'verify-parw-sha256'
  | 'decode-parw'
  | 'verify-original-sha256'
  | 'write-local'
  | 'restore-to-tree';

export interface RestoreStep {
  step: RestoreStepName;
  status: 'ok' | 'failed';
  detail?: string;
  ms: number;
}

export interface RestoreOptions {
  /** Write the reconstructed original here (step 7). */
  outputPath?: string;
  /** Put the original .parw back into the current tree and drop the pointer (step 8). */
  restoreToTree?: boolean;
  /** Extra check against the checksum recorded in the app database. */
  expectedOriginalSha256?: string;
  /** Fired BEFORE a step runs (lets a UI show "running"). May be async. */
  onStepStart?: (step: RestoreStepName) => void | Promise<void>;
  onStep?: (step: RestoreStep) => void;
}

export interface RestoreResult {
  data: Buffer;
  metadata: ParwMetadata;
  steps: RestoreStep[];
  outputPath?: string;
  restoredToTree: boolean;
  commitSha?: string;
}

export type UsageReport = BackendStats;

export interface StorageProvider {
  listFiles(): Promise<FileMetadata[]>;
  uploadFile(req: UploadRequest): Promise<UploadResult>;
  /** Returns the CURRENT PARW bytes of an active file. */
  downloadFile(virtualPath: string): Promise<Buffer>;
  archiveFile(virtualPath: string): Promise<ArchiveResult>;
  restoreFile(virtualPath: string, opts?: RestoreOptions): Promise<RestoreResult>;
  getUsage(): Promise<UsageReport>;
}
