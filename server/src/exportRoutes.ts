/** GET /export/{stl,code,step}: downloads of the live document (`guardRead`: bearer or `?access_token=`). */
import { Router, type Response } from 'express';
import { exportStepFile } from '@mcp/index';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import { BusyError, type ExchangeOptions } from './pythonExchange';
import { safeFileName } from '@lib/safeFileName';
import { guardRead } from './security';
import { fileOfRecord } from './cli/saveFiles';

function sendDownload(res: Response, fileName: string, contentType: string, body: string | Buffer): void {
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', contentType);
  if (typeof body === 'string') return void res.status(200).send(body);
  res.setHeader('Content-Length', body.length);
  res.status(200).end(body);
}

const GATE_CODES: ReadonlySet<string> = new Set(['MAT_EXPORT_CONTROLLED', 'MAT_HUMAN_GATE']);

/** 403 with the gate's code and summary when the export gate refused (export-controlled content, TR-MAT-51); else the route's own status. */
function gateRefusal(res: Response, code: string | undefined, text: string): boolean {
  const gate = code !== undefined ? GATE_CODES.has(code) : [...GATE_CODES].some((known) => text.includes(known));
  if (gate) res.status(403).json({ error: text, code: code ?? [...GATE_CODES].find((known) => text.includes(known)) });
  return gate;
}

export function buildExportRouter(exchange: ExchangeOptions): Router {
  const router = Router();
  router.use(guardRead());

  router.get('/stl', (req, res) => {
    const format = req.query['format'] === 'binary' ? 'binary' : 'ascii';
    const name = safeFileName(req.query['name']);
    const result = applyCommand('export_stl', { format, name });
    const file = isRecord(result.data) ? fileOfRecord(result.data) : null;
    if (file === null) {
      if (!gateRefusal(res, result.error?.code, result.summary)) res.status(500).json({ error: `export_stl returned no ${format} data.` });
    } else sendDownload(res, `${name}.stl`, 'model/stl', file.bytes);
  });

  // `language` is validated by the export_code schema: invalid -> 400.
  router.get('/code', (req, res) => {
    const result = applyCommand('export_code', {
      name: safeFileName(req.query['name'], 'model'),
      language: req.query['language'] ?? 'cadquery',
    });
    const data = result.data as { text?: string; fileName?: string } | undefined;
    if (data?.text === undefined || data.fileName === undefined) {
      if (!gateRefusal(res, result.error?.code, result.summary))
        res.status(result.summary.includes('invalid params') ? 400 : 500).json({ error: result.summary });
    } else sendDownload(res, data.fileName, 'text/plain; charset=utf-8', data.text);
  });

  // Without the Python bridge the exact kernel writes the STEP; 503 when neither is available.
  router.get('/step', (req, res) => {
    const port = exchange.port;
    exportStepFile(getLiveDoc, port, { name: safeFileName(req.query['name'], 'model'), language: req.query['language'], save: false })
      .then((file) => {
        if ('error' in file) {
          if (!gateRefusal(res, undefined, file.error)) res.status(port === null ? 503 : 500).json({ error: file.error });
        } else sendDownload(res, file.fileName, 'model/step', Buffer.from(file.stepBase64, 'base64'));
      })
      .catch(
        (error: unknown) =>
          void res.status(error instanceof BusyError ? 503 : 500).json({ error: `export_step failed: ${errorMessage(error)}` }),
      );
  });

  return router;
}
