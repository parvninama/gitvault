/**
 * The ONLY module in the frontend that talks to the network. Components call these typed functions
 * and never use fetch directly. Everything goes to the Express API; nothing here knows about GitHub.
 */
import type {
  AuthStatus, Dashboard, ExperimentResponse, FileView, RestoreEvent, RestoreOutcome, Settings, TreeNode, UploadPreview,
} from './types.ts';

interface ApiConfig { baseUrl: string; fetchImpl?: typeof fetch }
const cfg: ApiConfig = { baseUrl: '' };

/** Tests (and non-browser callers) configure the base URL; the browser uses same-origin relative URLs. */
export function configureApi(o: Partial<ApiConfig>): void {
  Object.assign(cfg, o);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const doFetch = (url: string, init?: RequestInit) => (cfg.fetchImpl ?? globalThis.fetch)(url, init);
const url = (path: string, query?: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return `${cfg.baseUrl}${path}${s ? `?${s}` : ''}`;
};

async function failure(res: Response): Promise<ApiError> {
  let body: { error?: string; code?: string } = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  return new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code);
}

async function getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
  const res = await doFetch(url(path, query));
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await doFetch(url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

export type FileBody = Blob | Uint8Array;

async function postRaw<T>(path: string, query: Record<string, string | undefined>, body: FileBody, onProgress?: (loaded: number, total: number) => void): Promise<T> {
  const total = body instanceof Blob ? body.size : body.byteLength;
  // XHR is used in browsers only because fetch cannot report upload progress.
  if (typeof XMLHttpRequest !== 'undefined' && onProgress) {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url(path, query));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : total);
      xhr.onerror = () => reject(new ApiError(0, 'Network error'));
      xhr.onload = () => {
        let parsed: any = {};
        try { parsed = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
        else reject(new ApiError(xhr.status, parsed.error ?? `HTTP ${xhr.status}`, parsed.code));
      };
      xhr.send(body as XMLHttpRequestBodyInit);
    });
  }
  const res = await doFetch(url(path, query), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: body as BodyInit });
  if (!res.ok) throw await failure(res);
  onProgress?.(total, total);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------- typed API

export const getAuthStatus = () => getJson<AuthStatus>('/api/auth/status');
export const getSettings = () => getJson<Settings>('/api/settings');
export const getDashboard = () => getJson<Dashboard>('/api/experiment/dashboard');
export const getRepositories = () => getJson<Dashboard['repositories']>('/api/repositories');
export const listFiles = (status?: 'active' | 'archived') => getJson<FileView[]>('/api/files', { status });
export const getTree = () => getJson<TreeNode>('/api/tree');

/** Dry run: encodes server-side and reports PARW size, ratio and the target repository. Writes nothing. */
export const previewUpload = (path: string, body: FileBody, mime?: string) =>
  postRaw<UploadPreview>('/api/files/preview', { path, mime }, body);

/** The File/Blob is sent directly as the raw request body (no multipart). */
export const uploadFile = (path: string, body: FileBody, opts: { mime?: string; onProgress?: (loaded: number, total: number) => void } = {}) =>
  postRaw<FileView>('/api/files', { path, mime: opts.mime }, body, opts.onProgress);

export const archiveFile = (path: string) => postJson<FileView>('/api/files/archive', { path });
export const downloadUrl = (path: string) => url('/api/files/download', { path });

export const runExperiment = (opts: { sizesMiB: number[]; kind?: 'random' | 'compressible'; confirmGitHub?: boolean }) =>
  postJson<ExperimentResponse>('/api/experiment/run', opts);

/** Reads newline-delimited JSON from a streaming response. */
async function readNdjson(res: Response, onEvent: (e: RestoreEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as RestoreEvent);
    }
    if (done) break;
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as RestoreEvent);
}

/** Streams step events as they happen; resolves with the final outcome. Never throws for a failed restore step. */
export async function restoreFile(path: string, opts: { restoreToTree?: boolean; slowMs?: number } = {}, onEvent: (e: RestoreEvent) => void = () => {}): Promise<RestoreOutcome> {
  const res = await doFetch(url('/api/files/restore'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, ...opts }),
  });
  if (!res.ok) {
    const err = await failure(res);
    return { ok: false, message: err.message };
  }
  let outcome: RestoreOutcome = { ok: false, message: 'Restore stream ended without a result' };
  await readNdjson(res, (e) => {
    onEvent(e);
    if (e.type === 'done') outcome = { ok: true, file: e.file, outputPath: e.result.outputPath, restoredToTree: e.result.restoredToTree };
    if (e.type === 'error') outcome = { ok: false, message: e.message, failedStep: e.failedStep };
  });
  return outcome;
}
