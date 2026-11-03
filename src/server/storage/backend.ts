/**
 * Minimal versioned-store abstraction (think "a git repo"). The generic provider logic
 * (upload / archive / restore) lives in VersionedStorageProvider and only needs these primitives,
 * so the local simulation and the GitHub implementation share the exact same workflow code.
 */
export interface FileChange {
  path: string;
  /** New content, or null to delete the path. */
  data: Buffer | null;
}

export interface CommitResult {
  commitSha: string;
}

export interface TreeEntry {
  path: string;
  size: number;
}

export interface BackendStats {
  commits: number;
  /** Unique binary objects ever stored (deduplicated by content); null if not measurable. */
  binaryObjects: number | null;
  currentTreeFiles: number;
  /** A. Bytes in the current working tree. */
  currentTreeBytes: number;
  /** C. Bytes of every unique object still retained in history (null if not measurable). */
  historicalObjectBytes: number | null;
  /** Subset of the above that is no longer reachable from the current tree. */
  retainedOnlyInHistoryBytes: number | null;
  /** B. Estimated on-server repository size (null if unknown). */
  estimatedRepoBytes: number | null;
  measurement: 'exact' | 'estimated';
  notes: string[];
}

export interface VersionedBackend {
  readonly name: string;
  /** Latest commit id, or null for an empty repository. */
  headCommit(): Promise<string | null>;
  hasCommit(ref: string): Promise<boolean>;
  /** Content of a path at `ref` (default: head). Null if the path does not exist there. */
  getFile(path: string, ref?: string): Promise<Buffer | null>;
  listTree(): Promise<TreeEntry[]>;
  /** Apply all changes in ONE commit. */
  commit(changes: FileChange[], message: string): Promise<CommitResult>;
  stats(): Promise<BackendStats>;
}
