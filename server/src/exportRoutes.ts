/**
 * @layer server
 * GET /export/{stl,code,step} — file downloads of the shared live document. Guarded by `guardRead`
 * (bearer or `?access_token=`; browser downloads cannot send Authorization headers).
 */

import { Router, type Response } from 'express';
import { exportStepFile } from '@mcp/index';
import type { ExportStlData } from '@core/commands/export';
import type { ExportStepExactData } from '@core/commands/brep';
import { errorMessage } from '@lib/errorMessage';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import { safeFileName } from '@lib/safeFileName';
import { guardRead } from './security';

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

type CodeLanguage = 'cadquery' | 'build123d' | 'openscad' | 'freecad';

/** Absent -> cadquery; unknown value -> null (caller answers 400). */
function exportLanguage(raw: unknown): CodeLanguage | null {
  if (raw === undefined) return 'cadquery';
  return raw === 'cadquery' || raw === 'build123d' || raw === 'openscad' || raw === 'freecad'
    ? raw
    : null;
}

/** @param exchange Python bridge shared with the MCP exchange tools (STEP needs it). */
export function buildExportRouter(exchange: ExchangeOptions): Router {
  const router = Router();
  router.use(guardRead());

  /** Query: format = ascii (default) | binary; name = file base name. */
  router.get('/stl', (req, res) => {
    const format = req.query['format'] === 'binary' ? 'binary' : 'ascii';
    const name = safeFileName(req.query['name']);
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
    const name = safeFileName(req.query['name'], 'model');
    const language = exportLanguage(req.query['language']);
    if (language === null) {
      res.status(400).json({
        error: 'Unknown language; use cadquery, build123d, openscad or freecad.',
      });
      return;
    }
    const result = applyCommand('export_code', {
      language,
      name,
    });
    const data = result.data as { text?: string; fileName?: string } | undefined;
    if (data?.text === undefined || data.fileName === undefined) {
      res.status(500).json({ error: result.summary });
      return;
    }
    sendDownload(res, data.fileName, 'text/plain; charset=utf-8', data.text);
  });

  /**
   * Query: name; language = cadquery (default) | build123d. Without the Python bridge, the exact
   * B-rep kernel writes the STEP itself (export_step_exact); 503 when neither is available.
   */
  router.get('/step', (req, res) => {
    const port = exchange.port;
    const name = safeFileName(req.query['name'], 'model');
    if (port === null) {
      const data = applyCommand('export_step_exact', {}).data as ExportStepExactData | undefined;
      if (data === undefined) {
        res.status(503).json({
          error:
            'STEP export needs the Python bridge (LLULL_PYTHON is off) or the exact OCC kernel (LLULL_KERNEL=occt).',
        });
        return;
      }
      sendDownload(res, `${name}.step`, 'model/step', data.step);
      return;
    }
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
