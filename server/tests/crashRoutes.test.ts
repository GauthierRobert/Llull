/** GET /crashes/latest (SC-A4): the newest local crash report with its command log, 404 without one. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { app } from '../src/index';
import { crashReportsDir, writeCrashReport } from '../src/crashReports';

let dataDir = '';
let previous: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'llull-crash-routes-'));
  previous = process.env['LLULL_DATA_DIR'];
  process.env['LLULL_DATA_DIR'] = dataDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env['LLULL_DATA_DIR'];
  else process.env['LLULL_DATA_DIR'] = previous;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /crashes/latest', () => {
  it('404 when there is no report', async () => {
    const res = await request(app).get('/crashes/latest');
    expect(res.status).toBe(404);
  });

  it('returns the newest report with its replay log and never the document', async () => {
    const options = { directory: crashReportsDir(process.env) };
    writeCrashReport({ source: 'command-threw', error: new Error('older') }, { ...options, now: Date.UTC(2026, 9, 19, 10) });
    writeCrashReport(
      {
        source: 'command-threw',
        error: new Error('boom'),
        documentJson: '{"secret":true}',
        commandLog: {
          replayFrom: 'empty',
          commands: [{ name: 'add_box', params: { size: [1, 1, 1] } }],
          failing: { name: 'fillet_edges', params: { radius: 2 } },
        },
      },
      { ...options, now: Date.UTC(2026, 9, 19, 11) },
    );
    const res = await request(app).get('/crashes/latest');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('boom');
    expect(res.body.commandLog.failing.name).toBe('fillet_edges');
    expect(res.body.commandLog.commands).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
