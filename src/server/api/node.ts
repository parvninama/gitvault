import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { ApiRequest, ApiResponse } from './routes.ts';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function toApiRequest(req: IncomingMessage, raw: Buffer): ApiRequest {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  const cookies: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) cookies[k] = rest.join('=');
  }
  return { method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, cookies, raw };
}

export async function readBody(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Writes an ApiResponse to any Node ServerResponse (plain http or Express: Express's res extends it). */
export async function writeResponse(res: ServerResponse, r: ApiResponse): Promise<void> {
  const headers: Record<string, string | string[]> = { 'X-Content-Type-Options': 'nosniff', ...(r.headers ?? {}) };
  if (r.setCookie) headers['Set-Cookie'] = `${r.setCookie.name}=${r.setCookie.value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${r.setCookie.maxAgeSec}`;
  if (r.clearCookie) headers['Set-Cookie'] = `${r.clearCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  if (r.redirect) {
    res.writeHead(r.status, { ...headers, Location: r.redirect });
    return void res.end();
  }
  if (r.stream) {
    res.writeHead(r.status, { ...headers, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    await r.stream((event) => res.write(JSON.stringify(event) + '\n'));
    return void res.end();
  }
  if (r.binary) {
    res.writeHead(r.status, { 'Content-Length': r.binary.length, ...headers });
    return void res.end(r.binary);
  }
  const body = Buffer.from(JSON.stringify(r.json ?? {}));
  res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
};

/** Serves the built client with SPA fallback to index.html. Returns null if there is no build. */
export async function serveStatic(dist: string | undefined, pathname: string): Promise<ApiResponse | null> {
  if (!dist) return null;
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const full = join(dist, rel);
  if (full !== dist && !full.startsWith(dist + sep)) return { status: 403, json: { error: 'forbidden' } };
  for (const candidate of [full, join(dist, 'index.html')]) {
    try {
      if ((await stat(candidate)).isFile()) {
        return { status: 200, binary: await readFile(candidate), headers: { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' } };
      }
    } catch { /* try next */ }
  }
  return null;
}
