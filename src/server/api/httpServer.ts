import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dispatch, createRoutes } from './routes.ts';
import type { AppDeps } from './routes.ts';
import { readBody, serveStatic, toApiRequest, writeResponse } from './node.ts';

/** Dependency-free host for the same route table the Express host uses (used when express is not installed, and in tests). */
export function createHttpServer(d: AppDeps): Server {
  const routes = createRoutes(d);
  return createServer(async (req, res) => {
    try {
      const raw = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const apiReq = toApiRequest(req, raw);
      const r = (await dispatch(routes, d, apiReq)) ?? (req.method === 'GET' ? await serveStatic(d.clientDist, apiReq.path) : null)
        ?? { status: 404, json: { error: 'not_found' } };
      await writeResponse(res, r);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) await writeResponse(res, { status, json: { error: status === 413 ? 'request_too_large' : 'internal_error' } });
      else res.end();
    }
  });
}
