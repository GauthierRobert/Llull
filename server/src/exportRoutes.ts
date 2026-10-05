/**
 * @layer server
 * GET /export/{stl,code,step} — file downloads of the shared live document. Mounted outside the
 * /mcp bearer auth (browser downloads cannot send Authorization headers).
 */

import { Router, type Response } from 'express';
import { exportStepFile } from '@mcp/index';
import type { ExportStlData } from '@core/commands/export';
import { errorMessage } from '@lib/errorMessage';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import { sanitizeFilename } from './security';

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

const exportLanguage = (raw: unknown): 'cadquery' | 'build123d' | 'openscad' | 'freecad' =>
  raw === 'build123d' || raw === 'openscad' || raw === 'freecad' ? raw : 'cadquery';

/** @param exchange Python bridge shared with the MCP exchange tools (STEP needs it). */
export function buildExportRouter(exchange: ExchangeOptions): Router {
  const router = Router();

  /** Query: format = ascii (default) | binary; name = file base name. */
  router.get('/stl', (req, res) => {
    const format = req.query['format'] === 'binary' ? 'binary' : 'ascii';
    const name = sanitizeFilename(req.query['name']);
    const data = applyCommand('export_stl', { format, name }).data as ExportStlData | undefined;
    if (!data) {
      res.status(500).json({ error: 'export_stl returned no data.' });
      return;
    }
    if (data.format === 'binary' && !data.stlBase64) {
      res.status(500).json({ error: 'export_stl binary result missing stlBase64.' });
      return;
    }
    sendDownload(
      res,
      `${name}.stl`,
      'model/stl',
      data.format === 'binary' ? Buffer.from(data.stlBase64 ?? '', 'base64') : (data.stl ?? ''),
    );
  });

  /** Query: language = cadquery (default) | build123d | openscad | freecad; name = file base name. */
  router.get('/code', (req, res) => {
    const name = sanitizeFilename(req.query['name'], 'model');
    const result = applyCommand('export_code', {
      language: exportLanguage(req.query['language']),
      name,
    });
    const data = result.data as { text?: string; fileName?: string } | undefined;
    if (data?.text === undefined || data.fileName === undefined) {
      res.status(500).json({ error: result.summary });
      return;
    }
    sendDownload(res, data.fileName, 'text/plain; charset=utf-8', data.text);
  });

  /** Query: name; language = cadquery (default) | build123d. 503 without the Python bridge. */
  router.get('/step', (req, res) => {
    const port = exchange.port;
    if (port === null) {
      res.status(503).json({ error: 'STEP export needs the Python bridge (LLULL_PYTHON is off).' });
      return;
    }
    const name = sanitizeFilename(req.query['name'], 'model');
    exportStepFile(getLiveDoc, port, { name, language: req.query['language'], save: false })
      .then((file) => {
        if ('error' in file) {
          res.status(500).json({ error: file.error });
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
