import { randomBytes } from 'node:crypto';
import { encodeParw } from '../parw/format.ts';
import { sha256Hex } from '../parw/hash.ts';
import type { RestoreStep, StorageProvider, UsageReport } from '../storage/types.ts';

export type PayloadKind = 'random' | 'compressible';

export interface ExperimentOptions {
  /** Test file sizes in BYTES. Nothing larger is ever generated automatically. */
  sizes: number[];
  kind?: PayloadKind;
  /** Used to namespace paths so reruns never collide. */
  runId?: string;
  onProgress?: (msg: string) => void;
}

export interface Snapshot {
  label: string;
  usage: UsageReport;
}

export interface FileRun {
  sizeBytes: number;
  virtualPath: string;
  originalSha256: string;
  parwSize: number;
  /** 1 - parw/original (fraction). */
  compressionRatio: number;
  timingsMs: { upload: number; archive: number; restore: number; restoreToTree: number };
  snapshots: { afterUpload: Snapshot; afterArchive: Snapshot; afterRestoreToTree: Snapshot };
  restoreSteps: RestoreStep[];
  verified: boolean;
  error?: string;
}

export interface ExperimentResult {
  runId: string;
  kind: PayloadKind;
  baseline: Snapshot;
  files: FileRun[];
  final: Snapshot;
  startedAt: string;
}

function makePayload(size: number, kind: PayloadKind): Buffer {
  if (kind === 'random') return randomBytes(size); // worst case: zstd cannot help
  const block = randomBytes(Math.min(4096, Math.max(size, 1)));
  return Buffer.concat(Array.from({ length: Math.ceil(size / block.length) }, () => block)).subarray(0, size);
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
}

/**
 * For each size: upload -> snapshot -> archive (pointer) -> snapshot -> restore from history (verified)
 * -> restore back into tree -> snapshot. Works against ANY StorageProvider.
 */
export async function runExperiment(provider: StorageProvider, opts: ExperimentOptions): Promise<ExperimentResult> {
  const kind = opts.kind ?? 'random';
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const say = opts.onProgress ?? (() => {});
  const snap = async (label: string): Promise<Snapshot> => ({ label, usage: await provider.getUsage() });

  const baseline = await snap('baseline');
  const files: FileRun[] = [];

  for (const size of opts.sizes) {
    const virtualPath = `experiment/${runId}/test-${size}.bin`;
    say(`[${size} bytes] generating + encoding`);
    const original = makePayload(size, kind);
    const originalSha256 = sha256Hex(original);
    const parw = encodeParw({ data: original, filename: `test-${size}.bin` });
    const run: Partial<FileRun> = {
      sizeBytes: size, virtualPath, originalSha256, parwSize: parw.length,
      compressionRatio: size === 0 ? 0 : 1 - parw.length / size, verified: false, restoreSteps: [],
    };
    try {
      say(`[${size} bytes] uploading`);
      const [, upload] = await timed(() => provider.uploadFile({ virtualPath, parw }));
      const afterUpload = await snap('after upload');

      say(`[${size} bytes] archiving (pointer replaces file)`);
      const [, archive] = await timed(() => provider.archiveFile(virtualPath));
      const afterArchive = await snap('after archive (pointer only)');

      say(`[${size} bytes] restoring from history`);
      const [restored, restore] = await timed(() => provider.restoreFile(virtualPath, { expectedOriginalSha256: originalSha256 }));
      run.restoreSteps = restored.steps;
      run.verified = sha256Hex(restored.data) === originalSha256 && restored.data.length === size;
      if (!run.verified) throw new Error('Restored bytes differ from original');

      const [, restoreToTree] = await timed(() => provider.restoreFile(virtualPath, { restoreToTree: true, expectedOriginalSha256: originalSha256 }));
      const afterRestoreToTree = await snap('after restore into tree');

      files.push({
        ...(run as FileRun),
        timingsMs: { upload, archive, restore, restoreToTree },
        snapshots: { afterUpload, afterArchive, afterRestoreToTree },
      });
    } catch (e) {
      const empty = baseline;
      files.push({
        ...(run as FileRun), error: (e as Error).message, verified: false,
        timingsMs: { upload: 0, archive: 0, restore: 0, restoreToTree: 0 },
        snapshots: { afterUpload: empty, afterArchive: empty, afterRestoreToTree: empty },
      });
      say(`[${size} bytes] FAILED: ${(e as Error).message}`);
    }
  }
  return { runId, kind, baseline, files, final: await snap('final'), startedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- reporting

export function fmtBytes(n: number | null): string {
  if (n === null) return 'n/a';
  const sign = n < 0 ? '-' : '';
  let v = Math.abs(n);
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${sign}${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
}
const signed = (n: number | null) => (n === null ? 'n/a' : (n > 0 ? '+' : '') + fmtBytes(n));
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
const row = (cols: string[], w: number[]) => cols.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');

export function formatReport(r: ExperimentResult, ctx: { backend: string } = { backend: 'unknown' }): string {
  const out: string[] = [];
  const W = [30, 12, 12, 12, 8, 8];
  const header = row(['', 'A tree', 'B repo est.', 'C history', 'D cmts', 'E objs'], W);
  const line = (s: Snapshot) => row([
    s.label, fmtBytes(s.usage.currentTreeBytes), fmtBytes(s.usage.estimatedRepoBytes), fmtBytes(s.usage.historicalObjectBytes),
    String(s.usage.commits), s.usage.binaryObjects === null ? 'n/a' : String(s.usage.binaryObjects),
  ], W);

  out.push(`GIT HISTORY EXPERIMENT  run=${r.runId}  backend=${ctx.backend}  payload=${r.kind}`);
  out.push('A = current working-tree bytes | B = estimated repository size on the backend | C = historical object bytes retained');
  out.push('D = commits | E = unique binary objects ("n/a" = the backend API does not expose it)');

  for (const f of r.files) {
    out.push('', `== ${fmtBytes(f.sizeBytes)} test file ==`);
    out.push(`original ${fmtBytes(f.sizeBytes)} -> PARW ${fmtBytes(f.parwSize)} (compression ${(f.compressionRatio * 100).toFixed(1)}%)`);
    if (f.error) { out.push(`RESULT: FAILED - ${f.error}`); continue; }
    out.push(header, line(r.baseline), line(f.snapshots.afterUpload), line(f.snapshots.afterArchive), line(f.snapshots.afterRestoreToTree));
    const a = f.snapshots.afterUpload.usage, b = f.snapshots.afterArchive.usage;
    out.push(
      `archive effect: tree ${signed(diff(a.currentTreeBytes, b.currentTreeBytes))}, repo estimate ${signed(diff(a.estimatedRepoBytes, b.estimatedRepoBytes))}, ` +
      `history ${signed(diff(a.historicalObjectBytes, b.historicalObjectBytes))}`,
    );
    out.push(`timings ms: upload ${f.timingsMs.upload}, archive ${f.timingsMs.archive}, restore ${f.timingsMs.restore}, restore->tree ${f.timingsMs.restoreToTree}`);
    out.push(`restore steps: ${f.restoreSteps.map((s) => `${s.step}:${s.status}`).join(' > ')}`);
    out.push(`RESULT: ${f.verified ? 'PASS' : 'FAIL'}  SHA-256 original == reconstructed (${f.originalSha256.slice(0, 16)}...)`);
  }

  const ok = r.files.filter((f) => !f.error);
  const fin = r.final.usage;
  const totalParw = ok.reduce((n, f) => n + f.parwSize, 0);
  const reclaimed = ok.map((f) => diff(f.snapshots.afterArchive.usage.estimatedRepoBytes, f.snapshots.afterUpload.usage.estimatedRepoBytes));
  out.push('', '== SUMMARY ==', header, line(r.baseline), line(r.final));
  out.push(`files verified: ${ok.filter((f) => f.verified).length}/${r.files.length}   total PARW bytes uploaded: ${fmtBytes(totalParw)}`);
  out.push('', 'FINDINGS FROM THIS RUN');
  const anyReclaim = reclaimed.some((x) => x !== null && x > 0.01 * totalParw / Math.max(ok.length, 1));
  out.push(anyReclaim
    ? '- The backend reported the repository shrinking after an archive. Verify this independently before relying on it.'
    : '- Archiving did NOT reduce the repository footprint (repo estimate did not drop). Only the current tree (A) shrank.');
  out.push(`- Current tree ${fmtBytes(fin.currentTreeBytes)} vs retained history ${fmtBytes(fin.historicalObjectBytes)} vs repo estimate ${fmtBytes(fin.estimatedRepoBytes)}.`);
  out.push('- Restore-into-tree re-adds identical bytes; git deduplicates identical blobs, so it should not add a second copy of the data.');
  out.push('', 'CAVEATS');
  for (const n of fin.notes) out.push(`- ${n}`);
  if (ctx.backend === 'local') out.push('- LOCAL SIMULATION: this validates the workflow and checksums only. It says nothing about GitHub\'s real storage behaviour; run with --provider github.');
  out.push('- Not measured: GitHub-side garbage collection/packing over time, rate limits, push throughput at scale, or Terms-of-Service suitability.');
  return out.join('\n');
}
