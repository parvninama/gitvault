// Type-only imports: the browser bundle contains NO server code.
export type { FileView, TreeNode, Dashboard, UploadPreview } from '../../server/storage/StorageService.ts';
export type { ExperimentResult, FileRun, Snapshot } from '../../server/experiment/gitHistoryExperiment.ts';
export type { RestoreStep, RestoreStepName } from '../../server/storage/types.ts';
import type { FileView } from '../../server/storage/StorageService.ts';
import type { ExperimentResult } from '../../server/experiment/gitHistoryExperiment.ts';
import type { RestoreStep, RestoreStepName } from '../../server/storage/types.ts';

export interface AuthStatus { backend: 'local' | 'github'; connected: boolean; login: string | null; scope: string }

export interface Settings {
  backend: 'local' | 'github';
  experimentalBackend: boolean;
  targetRepositorySize: number;
  maxRepositories: number;
  maxFileSize: number;
  parwCompression: { algorithm: string; level: number; fallback: string };
  experimentLimits: { maxFiles: number; maxSizeMiB: number };
  github: { oauthConfigured: boolean; connected: boolean; login: string | null; scope: string };
}

export interface ExperimentResponse {
  result: ExperimentResult;
  sandboxed: boolean;
  backend: 'local' | 'github';
  report: string;
}

/** Events streamed by POST /api/files/restore */
export type RestoreEvent =
  | { type: 'start'; step: RestoreStepName }
  | ({ type: 'step' } & RestoreStep)
  | { type: 'done'; file: FileView; result: { steps: RestoreStep[]; outputPath?: string; restoredToTree: boolean; commitSha?: string } }
  | { type: 'error'; message: string; failedStep?: RestoreStepName; code?: string };

export type RestoreOutcome =
  | { ok: true; file: FileView; outputPath?: string; restoredToTree: boolean }
  | { ok: false; message: string; failedStep?: RestoreStepName };
