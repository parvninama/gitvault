import express from 'express';
import { dispatch, createRoutes } from './routes.ts';
import type { AppDeps } from './routes.ts';
import { MAX_UPLOAD_BYTES, serveStatic, toApiRequest, writeResponse } from './node.ts';

/**
 * Express host. All behaviour lives in routes.ts (framework-neutral); Express only reads the body and hands over.
 * NOT YET RUN in the authoring sandbox (express could not be installed). httpServer.ts hosts the same routes.
 */
export function createApp(d: AppDeps) {
  const routes = createRoutes(d);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }));
  app.use(async (req, res, next) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const apiReq = toApiRequest(req, raw);
      const r = (await dispatch(routes, d, apiReq)) ?? (req.method === 'GET' ? await serveStatic(d.clientDist, apiReq.path) : null);
      if (!r) return next();
      await writeResponse(res, r);
    } catch (e) {
      next(e);
    }
  });
  return app;
}
