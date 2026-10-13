/**
 * POST /exchange `{ name, params }` — the exchange tools (export_step, import_step, import_dwg,
 * import_code) for REST callers: the `llull` CLI with `--app` / `--server` (`liveExchange.ts`).
 * Answers the command bus shape plus `changed`.
 */

import { Router, type RequestHandler } from 'express';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { runLiveExchangeTool } from './liveExchange';
import type { ExchangeOptions } from './pythonExchange';
import { guardMutation } from './security';
import { actorOf } from './audit';

export function buildExchangeRouter(restLimiter: RequestHandler, exchange: ExchangeOptions): Router {
  const router = Router();
  router.post('/exchange', restLimiter, guardMutation(), (req, res) => {
    const body = req.body as unknown;
    const name = isRecord(body) ? body['name'] : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      res.status(400).json({ error: 'Request body must be an object with a "name" field.' });
      return;
    }
    const actor = actorOf(res, isRecord(body) && body['client'] === 'cli' ? 'cli' : 'rest');
    runLiveExchangeTool(name, isRecord(body) ? body['params'] : undefined, exchange, actor)
      .then((outcome) => {
        if (outcome === null) {
          res.status(404).json({ error: `"${name}" is not an exchange tool; use POST /command.` });
          return;
        }
        res.status(200).json(outcome);
      })
      .catch((error: unknown) => {
        res.status(500).json({ error: errorMessage(error) });
      });
  });
  return router;
}
