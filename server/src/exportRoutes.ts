/**
 * @layer server
 * GET /export/{stl,code,step} — file downloads of the shared live document. Guarded by `guardRead`
 * (bearer or `?access_token=`; browser downloads cannot send Authorization headers).
 */

import { Router, type Response } from 'express';
import { exportStepFile } from '@mcp/index';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import { safeFileName } from '@lib/safeFileName';
import { guardRead } from './security';
import { fileOfRecord } from './cli/saveFiles';

/** Attachment headers + a text (send) or binary (end) body. */
function sendDownload(
  res: Response,
  fileName: string,
  contentType: string,
  body: string | Buffer,
): void {
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', contentType);
  if (typeof body === 'string') {
    res.status(200).send(body);
    return;
  }
  res.setHeader('Content-Length', body.length);
  res.status(200).end(body);
}

/** @param exchange Python bridge shared with the MCP exchange tools (STEP needs it). */
export function buildExportRouter(exchange: ExchangeOptions): Router {
  const router = Router();
  router.use(guardRead());

  /** Query: format = ascii (default) | binary; name = file base name. */
  router.get('/stl', (req, res) => {
    const format = req.query['format'] === 'binary' ? 'binary' : 'ascii';
    const name = safeFileName(req.query['name']);
    const result = applyCommand('export_stl', { format, name });
    const file = isRecord(result.data) ? fileOfRecord(result.data) : null;
    if (file === null) {
      res.status(500).json({ error: `export_stl returned no ${format} data.` });
      return;
    }
    sendDownload(res, `${name}.stl`, 'model/stl', file.bytes);
  });

  /**
   * Query: language = cadquery (default) | build123d | openscad | freecad; name = file base name.
   * The language is validated by the `export_code` schema: an invalid value is a 400.
   */
  router.get('/code', (req, res) => {
    const name = safeFileName(req.query['name'], 'model');
    const result = applyCommand('export_code', {
      name,
      language: req.query['language'] ?? 'cadquery',
    });
    const data = result.data as { text?: string; fileName?: string } | undefined;
    if (data?.text === undefined || data.fileName === undefined) {
      const invalid = result.summary.includes('invalid params');
      res.status(invalid ? 400 : 500).json({ error: result.summary });
      return;
    }
    sendDownload(res, data.fileName, 'text/plain; charset=utf-8', data.text);
  });

  /**
   * Query: name; language = cadquery (default) | build123d. Without the Python bridge, the exact
   * B-rep kernel writes the STEP itself (`exportStepFile`); 503 when neither is available.
   */
  router.get('/step', (req, res) => {
    const port = exchange.port;
    exportStepFile(getLiveDoc, port, {
      name: safeFileName(req.query['name'], 'model'),
      language: req.query['language'],
      save: false,
    })
      .then((file) => {
        if ('error' in file) {
          res.status(port === null ? 503 : 500).json({ error: file.error });
          return;
        }
        sendDownload(res, file.fileName, 'model/step', Buffer.from(file.stepBase64, 'base64'));
      })
      .catch((error: unknown) => {
        res.status(500).json({ error: `export_step failed: ${errorMessage(error)}` });
      });
  });

  return router;
}
