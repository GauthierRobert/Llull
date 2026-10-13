/**
 * POST /import/dwg: DWG -> ASCII DXF (`dwgConvert.ts`), then `import_dxf` / `import_survey_dxf` on the command bus.
 * Body: raw `application/octet-stream` bytes (params in the query string) or JSON
 * `{ base64, target, ...params }`. `target` = drawing (default) | survey.
 * Query/body params: sourceUnit, layers (comma list / array), and for survey: name, sources,
 * keepZeroElevation. 400 bad magic/body, 413 too big, 503 no converter, 504 timeout.
 */

import express, { Router, type RequestHandler } from 'express';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { applyCommand } from './commandBus';
import { convertDwgLimited, dwgConfigFromEnv, DwgConvertError } from './dwgConvert';
import { guardMutation } from './security';
import { actorOf } from './audit';
import type { DwgImportResponseBody, ErrorResponseBody } from '@mcp/restProtocol';

const LIST_KEYS = new Set(['layers', 'sources']);
const BOOLEAN_KEYS = new Set(['keepZeroElevation']);
const DRAWING_KEYS = ['sourceUnit', 'layers'];
const SURVEY_KEYS = ['name', 'layers', 'sources', 'sourceUnit', 'keepZeroElevation'];

/** Lists: comma string or array; booleans: "true"/"1". */
function coerce(key: string, value: unknown): unknown {
  if (LIST_KEYS.has(key)) {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return items.map((item) => String(item).trim()).filter((item) => item !== '');
  }
  if (BOOLEAN_KEYS.has(key)) return value === true || value === 'true' || value === '1';
  return value;
}

function commandParams(target: 'drawing' | 'survey', source: Record<string, unknown>, text: string): Record<string, unknown> {
  const params: Record<string, unknown> = { text };
  for (const key of target === 'survey' ? SURVEY_KEYS : DRAWING_KEYS) {
    if (source[key] !== undefined && source[key] !== '') params[key] = coerce(key, source[key]);
  }
  return params;
}

export function buildImportRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  const limit = (): number => dwgConfigFromEnv().maxBytes;
  // Body parsers are built per request so LLULL_DWG_MAX_BYTES is honoured; JSON gets +33% for base64.
  const raw: RequestHandler = (req, res, next) => express.raw({ type: 'application/octet-stream', limit: limit() })(req, res, next);
  const json: RequestHandler = (req, res, next) => express.json({ limit: Math.ceil(limit() * 1.4) + 4096 })(req, res, next);

  router.post('/dwg', restLimiter, guardMutation(), raw, json, (req, res) => {
    const body: unknown = req.body;
    let bytes: Buffer;
    let source: Record<string, unknown>;
    if (Buffer.isBuffer(body)) {
      bytes = body;
      source = req.query;
    } else if (isRecord(body) && typeof body['base64'] === 'string') {
      bytes = Buffer.from(body['base64'], 'base64');
      source = { ...req.query, ...body };
    } else {
      return void res.status(400).json({ error: 'Send the DWG as application/octet-stream bytes or JSON { "base64": "..." }.' });
    }
    const target = source['target'] ?? 'drawing';
    if (target !== 'drawing' && target !== 'survey') return void res.status(400).json({ error: 'target must be "drawing" or "survey".' });
    convertDwgLimited(bytes)
      .then((text) => {
        const command = target === 'survey' ? 'import_survey_dxf' : 'import_dxf';
        const result = applyCommand(command, commandParams(target, source, text), undefined, actorOf(res, 'rest'));
        res.status(200).json({ ...result, command, dxfBytes: Buffer.byteLength(text) } satisfies DwgImportResponseBody);
      })
      .catch((error: unknown) =>
        res.status(error instanceof DwgConvertError ? error.status : 500).json({ error: errorMessage(error) } satisfies ErrorResponseBody),
      );
  });

  return router;
}
