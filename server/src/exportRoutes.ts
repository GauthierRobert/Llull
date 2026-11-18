/** GET /export/step: STEP download of the live document (`guardRead`: bearer token when one is set). STL / code go through `export_stl` / `export_code` (CLI, POST /exchange). */
import { Router, type Response } from 'express';
import { exportStepFile } from '@protocol/index';
import { errorMessage } from '@lib/errorMessage';
import { getLiveDoc } from './liveDocument';
import { BusyError, type ExchangeOptions } from './pythonExchange';
import { safeFileName } from '@lib/safeFileName';
import { guardRead } from './security';
import { serverContext } from './fea/context';

function sendDownload(res: Response, fileName: string, contentType: string, body: string | Buffer): void {
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', contentType);
  if (typeof body === 'string') return void res.status(200).send(body);
  res.setHeader('Content-Length', body.length);
  res.status(200).end(body);
}

const GATE_CODES: ReadonlySet<string> = new Set(['MAT_EXPORT_CONTROLLED', 'MAT_HUMAN_GATE']);

/** 403 with the gate's code and message when the export gate refused (export-controlled content, TR-MAT-51); else the route's own status. */
function gateRefusal(res: Response, text: string): boolean {
  const code = [...GATE_CODES].find((known) => text.includes(known));
  if (code !== undefined) res.status(403).json({ error: text, code });
  return code !== undefined;
}

export function buildExportRouter(exchange: ExchangeOptions): Router {
  const router = Router();
  router.use(guardRead());

  // Without the Python bridge the exact kernel writes the STEP; 503 when neither is available.
  router.get('/step', (req, res) => {
    const port = exchange.port;
    exportStepFile(getLiveDoc, port, {
      name: safeFileName(req.query['name'], 'model'),
      language: req.query['language'],
      save: false,
      context: serverContext(),
    })
      .then((file) => {
        if ('error' in file) {
          if (!gateRefusal(res, file.error)) res.status(port === null ? 503 : 500).json({ error: file.error });
        } else sendDownload(res, file.fileName, 'model/step', Buffer.from(file.stepBase64, 'base64'));
      })
      .catch(
        (error: unknown) =>
          void res.status(error instanceof BusyError ? 503 : 500).json({ error: `export_step failed: ${errorMessage(error)}` }),
      );
  });

  return router;
}
