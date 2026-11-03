import { randomBytes } from 'node:crypto';
import type { Config } from '../config.ts';
import { formatReport } from '../experiment/gitHistoryExperiment.ts';
import { buildAuthorizeUrl, exchangeCode, OAuthError, pollDeviceFlow, REQUIRED_SCOPE, startDeviceFlow } from '../github/auth.ts';
import type { DeviceCode } from '../github/auth.ts';
import { CapacityError } from '../repository/RepositoryManager.ts';
import { StorageError } from '../storage/errors.ts';
import type { StorageService } from '../storage/StorageService.ts';
import { RestoreError } from '../storage/VersionedStorageProvider.ts';
import { NotConnectedError } from './session.ts';
import type { TokenStore } from './session.ts';

export interface AppDeps {
  service: StorageService;
  config: Config;
  tokens: TokenStore;
  backend: 'local' | 'github';
  /** Browser origin allowed to make state-changing requests (Vite dev server). */
  clientOrigin?: string;
  /** Directory with the built client (index.html + assets); served for non-/api GETs. */
  clientDist?: string;
}

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string>;
  /** Raw request bytes (possibly empty). */
  raw: Buffer;
}

export interface ApiResponse {
  status: number;
  json?: unknown;
  binary?: Buffer;
  redirect?: string;
  /** Newline-delimited JSON stream; the handler emits events as they happen. */
  stream?: (emit: (event: unknown) => void) => Promise<void>;
  headers?: Record<string, string>;
  setCookie?: { name: string; value: string; maxAgeSec: number };
  clearCookie?: string;
}

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** Needs a connected backend (GitHub token in github mode). */
  auth?: boolean;
  handler: (req: ApiRequest, body: () => any) => Promise<ApiResponse> | ApiResponse;
}

const MB = 1024 * 1024;
export const EXPERIMENT_LIMITS = { maxFiles: 4, maxSizeMiB: 50, allowedKinds: ['random', 'compressible'] as const };
const json = (status: number, body: unknown): ApiResponse => ({ status, json: body });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createRoutes(d: AppDeps): Route[] {
  let device: DeviceCode | null = null;
  const connect = async (token: string) => {
    const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new OAuthError('user_lookup_failed', `GitHub /user returned ${r.status}`);
    d.tokens.set(token, ((await r.json()) as { login: string }).login);
  };

  return [
    // ---- auth (token handling is strictly server-side; no token is ever returned to the browser) ----
    { method: 'GET', path: '/api/auth/status', handler: () => json(200, {
      backend: d.backend, connected: d.backend === 'local' || d.tokens.isConnected(), login: d.tokens.login, scope: REQUIRED_SCOPE,
    }) },
    { method: 'GET', path: '/api/auth/github/login', handler: () => {
      const state = randomBytes(16).toString('hex');
      return { status: 302, redirect: buildAuthorizeUrl({ clientId: d.config.githubClientId, redirectUri: d.config.githubCallbackUrl, state }),
        setCookie: { name: 'gv_state', value: state, maxAgeSec: 600 } };
    } },
    { method: 'GET', path: '/api/auth/github/callback', handler: async (req) => {
      if (!req.query.state || req.query.state !== req.cookies.gv_state) return json(400, { error: 'Invalid OAuth state' });
      await connect(await exchangeCode({
        clientId: d.config.githubClientId, clientSecret: d.config.githubClientSecret, code: req.query.code ?? '', redirectUri: d.config.githubCallbackUrl,
      }));
      return { status: 302, redirect: d.clientOrigin ?? '/', clearCookie: 'gv_state' };
    } },
    { method: 'POST', path: '/api/auth/device/start', handler: async () => {
      device = await startDeviceFlow(d.config.githubClientId);
      return json(200, { userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn });
    } },
    { method: 'POST', path: '/api/auth/device/poll', handler: async () => {
      if (!device) return json(400, { error: 'no_device_flow' });
      await connect(await pollDeviceFlow(d.config.githubClientId, device));
      device = null;
      return json(200, { connected: true, login: d.tokens.login });
    } },
    { method: 'POST', path: '/api/auth/logout', handler: () => { d.tokens.clear(); return json(200, { connected: false }); } },

    // ---- storage ----
    { method: 'GET', path: '/api/files', auth: true, handler: (req) => {
      const s = req.query.status;
      return json(200, d.service.list(s === 'active' || s === 'archived' ? s : undefined));
    } },
    { method: 'GET', path: '/api/tree', auth: true, handler: () => json(200, d.service.tree()) },
    // Raw-body upload: POST /api/files?path=photos/a.jpg (body = the file bytes). No multipart.
    { method: 'POST', path: '/api/files', auth: true, handler: async (req) => {
      const path = req.query.path;
      if (!path) return json(400, { error: 'path query parameter is required' });
      return json(201, await d.service.upload({ virtualPath: path, data: req.raw, mimeType: mimeOf(req) }));
    } },
    { method: 'POST', path: '/api/files/preview', auth: true, handler: async (req) => {
      if (!req.query.path) return json(400, { error: 'path query parameter is required' });
      return json(200, await d.service.preview({ virtualPath: req.query.path, data: req.raw, mimeType: mimeOf(req) }));
    } },
    { method: 'GET', path: '/api/files/download', auth: true, handler: async (req) => {
      const f = await d.service.download(req.query.path ?? '');
      return { status: 200, binary: f.data, headers: {
        'Content-Type': f.mimeType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      } };
    } },
    { method: 'POST', path: '/api/files/archive', auth: true, handler: async (_req, body) => json(200, await d.service.archive(String(body()?.path))) },
    // Streams NDJSON: {type:'start',step} / {type:'step',...} / {type:'done',...} | {type:'error',...}
    { method: 'POST', path: '/api/files/restore', auth: true, handler: (_req, body) => {
      const b = body() ?? {};
      const slowMs = d.backend === 'local' ? Math.min(Math.max(Number(b.slowMs) || 0, 0), 1500) : 0; // demo aid, local only
      return { status: 200, stream: async (emit) => {
        try {
          const r = await d.service.restore(String(b.path), {
            restoreToTree: !!b.restoreToTree,
            onStepStart: async (step) => { emit({ type: 'start', step }); if (slowMs) await sleep(slowMs); },
            onStep: (s) => emit({ type: 'step', ...s }),
          });
          emit({ type: 'done', file: r.file, result: r.result });
        } catch (e) {
          if (e instanceof RestoreError) emit({ type: 'error', message: e.message, failedStep: e.step, code: e.code });
          else emit({ type: 'error', message: (e as Error).message, code: (e as { code?: string }).code ?? 'ERROR' });
        }
      } };
    } },

    // ---- experiment / repositories / settings ----
    { method: 'GET', path: '/api/experiment/dashboard', auth: true, handler: async () => json(200, await d.service.dashboard()) },
    { method: 'POST', path: '/api/experiment/run', auth: true, handler: async (_req, body) => {
      const b = body() ?? {};
      const mib: unknown = b.sizesMiB ?? [1, 5];
      const L = EXPERIMENT_LIMITS;
      if (!Array.isArray(mib) || mib.length === 0 || mib.length > L.maxFiles || mib.some((n) => typeof n !== 'number' || !(n > 0) || n > L.maxSizeMiB)) {
        return json(400, { error: `sizesMiB must be 1-${L.maxFiles} numbers, each > 0 and <= ${L.maxSizeMiB}` });
      }
      if (d.backend === 'github' && b.confirmGitHub !== true) {
        return json(400, { error: 'GitHub experiments push real blobs that stay in Git history permanently. Send confirmGitHub:true to proceed.', code: 'CONFIRM_REQUIRED' });
      }
      const { result, sandboxed } = await d.service.runExperiment(mib.map((n: number) => Math.round(n * MB)), b.kind === 'compressible' ? 'compressible' : 'random');
      return json(200, { result, sandboxed, backend: d.backend, report: formatReport(result, { backend: d.backend }) });
    } },
    { method: 'GET', path: '/api/repositories', auth: true, handler: async () => json(200, (await d.service.dashboard()).repositories) },
    { method: 'GET', path: '/api/settings', handler: () => json(200, {
      backend: d.backend,
      experimentalBackend: d.backend === 'github',
      targetRepositorySize: d.config.targetRepositorySize,
      maxRepositories: d.config.maxRepositories,
      maxFileSize: d.config.maxGithubFileSize,
      parwCompression: { algorithm: 'zstd', level: 3, fallback: 'stored raw when zstd output is not smaller' },
      experimentLimits: { maxFiles: EXPERIMENT_LIMITS.maxFiles, maxSizeMiB: EXPERIMENT_LIMITS.maxSizeMiB },
      github: {
        oauthConfigured: !!(d.config.githubClientId && d.config.githubClientSecret && d.config.githubCallbackUrl),
        connected: d.tokens.isConnected(), login: d.tokens.login, scope: REQUIRED_SCOPE,
      },
    }) },
  ];
}

function mimeOf(req: ApiRequest): string | undefined {
  if (req.query.mime) return req.query.mime;
  const ct = req.headers['content-type'];
  return ct && ct !== 'application/octet-stream' ? ct : undefined;
}

export function errorResponse(err: unknown): ApiResponse {
  if (err instanceof RestoreError) return json(422, { error: err.message, code: err.code, failedStep: err.step, steps: err.steps });
  if (err instanceof StorageError) {
    const status = ({ NOT_FOUND: 404, NOT_ARCHIVED: 409, ALREADY_EXISTS: 409, ALREADY_ARCHIVED: 409, REQUIRES_CHUNKING: 413 } as Record<string, number>)[err.code] ?? 400;
    return json(status, { error: err.message, code: err.code });
  }
  if (err instanceof CapacityError) return json(507, { error: err.message, code: err.code });
  if (err instanceof NotConnectedError) return json(401, { error: 'not_connected' });
  if (err instanceof OAuthError) return json(400, { error: err.message, code: err.code });
  if (err instanceof Error && /^Invalid path/.test(err.message)) return json(400, { error: err.message, code: 'INVALID_PATH' });
  console.error(err);
  return json(500, { error: 'internal_error' });
}

/** Framework-independent request handling: CSRF check, routing, auth gate, JSON parsing, error mapping. */
export async function dispatch(routes: Route[], d: AppDeps, req: ApiRequest): Promise<ApiResponse | null> {
  const route = routes.find((r) => r.method === req.method && r.path === req.path);
  if (!route) return req.path.startsWith('/api/') ? json(404, { error: 'not_found' }) : null;
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && origin !== `http://${req.headers.host}` && origin !== d.clientOrigin) {
    return json(403, { error: 'forbidden_origin' });
  }
  if (route.auth && d.backend === 'github' && !d.tokens.isConnected()) return json(401, { error: 'not_connected' });
  try {
    let parsed: unknown;
    const body = () => {
      if (parsed === undefined) {
        try { parsed = req.raw.length ? JSON.parse(req.raw.toString('utf8')) : {}; } catch { throw new StorageError('NOT_FOUND', 'Request body is not valid JSON'); }
      }
      return parsed as any;
    };
    return await route.handler(req, body);
  } catch (e) {
    return errorResponse(e);
  }
}
