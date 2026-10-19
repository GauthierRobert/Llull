/**
 * GET /crashes/latest (SC-A4): the newest local crash report (SC-D3) as JSON, for the UI's reviewed issue draft. Read-only; the UI shows
 * the user exactly what it would include and sends nothing itself. 404 when there is no report. The document itself is never returned.
 */
import fs from 'fs';
import path from 'path';
import { Router, type RequestHandler } from 'express';
import { crashReportsDir, readCrashReport } from './crashReports';
import { guardRead } from './security';

function readCommandLog(directory: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'commands.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function buildCrashRouter(restLimiter: RequestHandler): Router {
  const router = Router();
  router.get('/crashes/latest', restLimiter, guardRead(), (_req, res) => {
    const report = readCrashReport(crashReportsDir(process.env), 'latest');
    if (report === null) return void res.status(404).json({ error: 'No crash report.' });
    const { id, time, source, message, errorText, meta } = report;
    res.json({ id, time, source, message, errorText, meta, commandLog: readCommandLog(report.directory) });
  });
  return router;
}
