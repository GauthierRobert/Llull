/**
 * @layer server
 *
 * HTTP routes for the UI↔MCP live-sync bridge.
 *
 * Two routes, both protected by the same bearer-auth as /mcp:
 *
 *   POST /ui-bridge/push
 *     Body: serialised CadDocument (JSON).
 *     Effect: stores the document in the in-memory bridge as the "live UI doc".
 *     Response 200: { ok: true, summary: string }
 *     Response 400: { error: string }  — malformed body.
 *
 *   POST /ui-bridge/pull
 *     Body: (empty / ignored).
 *     Effect: pops the pending staged publish document (if any) and clears it.
 *     Response 200: { pending: true, document: CadDocument } — pending doc present.
 *     Response 200: { pending: false }                       — nothing staged.
 *
 * The auth middleware is inherited from the caller (server/src/index.ts mounts
 * this router AFTER the auth middleware in buildUiBridgeRouter).
 *
 * Architecture: no business logic — delegates to `uiBridge.ts` state primitives.
 */

import { type Request, type Response, type Router, Router as createRouter } from 'express';
import type { CadDocument } from '@core/model/types';
import { pushLiveDocument, popPendingPublish } from './uiBridge';

// ---------------------------------------------------------------------------
// Auth middleware (re-uses the same token as /mcp)
// ---------------------------------------------------------------------------

function buildAuthMiddleware(): (req: Request, res: Response, next: () => void) => void {
  const token = process.env['MCP_AUTH_TOKEN'];
  if (!token) {
    // No token configured — allow all (mirrors /mcp behaviour in dev mode).
    return (_req, _res, next) => next();
  }
  const expected = `Bearer ${token}`;
  return (req: Request, res: Response, next: () => void) => {
    if (req.headers['authorization'] !== expected) {
      res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Build the Express Router for UI bridge routes.
 *
 * Mount with:
 *   `app.use('/ui-bridge', buildUiBridgeRouter());`
 */
export function buildUiBridgeRouter(): Router {
  const router = createRouter();
  const auth = buildAuthMiddleware();

  router.use(auth);

  // -------------------------------------------------------------------------
  // POST /ui-bridge/push — UI pushes its current document
  // -------------------------------------------------------------------------

  router.post('/push', (req: Request, res: Response) => {
    const body = req.body as unknown;

    // Basic structural validation — must be an object with entities + order.
    if (
      typeof body !== 'object' ||
      body === null ||
      !('entities' in body) ||
      !('order' in body)
    ) {
      res.status(400).json({
        error:
          'Request body must be a serialised CadDocument ' +
          '(object with "entities" and "order" fields).',
      });
      return;
    }

    pushLiveDocument(body as CadDocument);

    const entityCount = Object.keys((body as CadDocument).entities).length;
    res.status(200).json({
      ok: true,
      summary: `Live UI document updated (${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}).`,
    });
  });

  // -------------------------------------------------------------------------
  // POST /ui-bridge/pull — UI pops the pending staged document
  // -------------------------------------------------------------------------

  router.post('/pull', (_req: Request, res: Response) => {
    const doc = popPendingPublish();

    if (doc === null) {
      res.status(200).json({ pending: false });
      return;
    }

    res.status(200).json({ pending: true, document: doc });
  });

  return router;
}
