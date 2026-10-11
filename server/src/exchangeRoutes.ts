/**
 * @layer server
 * POST /exchange `{ name, params }` — the exchange tools (export_step, import_step, import_dwg,
 * import_code) for REST callers: the `llull` CLI with `--app` / `--server`. The same handlers as
 * MCP (`applyExchangeToolCall`); document changes go through the command bus (undo, live sync,
 * audit). Answers the command bus shape plus `changed`.
 */

import { Router, type RequestHandler } from 'express';
import { applyExchangeToolCall } from '@mcp/index';
import { isRecord } from '@lib/isRecord';
import { applyCommand } from './commandBus';
import { unshapeExchangeResult } from './exchangeResult';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import { guardMutation } from './security';
import { actorOf } from './audit';

export function buildExchangeRouter(
  restLimiter: RequestHandler,
  exchange: ExchangeOptions,
): Router {
  const router = Router();
  router.post('/exchange', restLimiter, guardMutation(), (req, res) => {
    const body = req.body as unknown;
    const name = isRecord(body) ? body['name'] : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      res.status(400).json({ error: 'Request body must be an object with a "name" field.' });
      return;
    }
    const actor = actorOf(res, 'rest');
    const before = getLiveDoc();
    applyExchangeToolCall(name, isRecord(body) ? body['params'] : undefined, {
      port: exchange.port,
      dwg: exchange.dwg ?? null,
      getDoc: getLiveDoc,
      applyCommand: (commandName, params) => applyCommand(commandName, params, undefined, actor),
      allowCodeExecution: exchange.allowCodeExecution,
    })
      .then((shaped) => {
        if (shaped === null) {
          res.status(404).json({ error: `"${name}" is not an exchange tool; use POST /command.` });
          return;
        }
        res
          .status(200)
          .json({ ...unshapeExchangeResult(shaped), changed: getLiveDoc() !== before });
      })
      .catch((error: unknown) => {
        res.status(500).json({ error: String(error) });
      });
  });
  return router;
}
