/**
 * @layer server/tests
 * POST /import/dwg and the import_dwg exchange tool, with a fake converter script (no LibreDWG
 * needed): success lands entities in the live document, no converter -> 503, bad magic -> 400,
 * slow converter -> 504.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

const DXF = [
  '0',
  'SECTION',
  '2',
  'ENTITIES',
  '0',
  'LINE',
  '8',
  'WALLS',
  '10',
  '0',
  '20',
  '0',
  '30',
  '0',
  '11',
  '5',
  '21',
  '0',
  '31',
  '0',
  '0',
  'POINT',
  '8',
  'TOPO',
  '10',
  '1',
  '20',
  '1',
  '30',
  '12.5',
  '0',
  'POINT',
  '8',
  'TOPO',
  '10',
  '2',
  '20',
  '1',
  '30',
  '13.5',
  '0',
  'POINT',
  '8',
  'TOPO',
  '10',
  '1',
  '20',
  '2',
  '30',
  '14.5',
  '0',
  'ENDSEC',
  '0',
  'EOF',
].join('\n');

const DWG = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(64)]);

let dir: string;
let okScript: string;
let slowScript: string;

interface Loaded {
  app: Express;
  getLiveDoc: () => { entities: Record<string, { kind: string; layer?: string }> };
}

async function load(env: Record<string, string | undefined>): Promise<Loaded> {
  vi.resetModules();
  for (const key of ['LLULL_DWG2DXF', 'LLULL_ODA_CONVERTER', 'LLULL_DWG_TIMEOUT_MS']) {
    vi.stubEnv(key, env[key]);
  }
  vi.stubEnv('LLULL_PYTHON', 'off');
  const { app } = await import('../src/index');
  const live = await import('../src/liveDocument');
  const bus = await import('../src/commandBus');
  const { installGeometryKernel } = await import('../src/geometryKernel');
  await installGeometryKernel();
  live._resetLiveDoc();
  bus._resetHistory();
  return { app, getLiveDoc: live.getLiveDoc as unknown as Loaded['getLiveDoc'] };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'llull-fake-dwg-'));
  okScript = path.join(dir, 'fake-dwg2dxf.js');
  slowScript = path.join(dir, 'slow-dwg2dxf.js');
  // argv: -y -o <out.dxf> <in.dwg> — the fake ignores the input and writes a known DXF.
  await writeFile(
    okScript,
    `#!/usr/bin/env node\nconst fs = require('fs');\nconst out = process.argv[process.argv.indexOf('-o') + 1];\nfs.writeFileSync(out, ${JSON.stringify(DXF)});\n`,
    { mode: 0o755 },
  );
  await writeFile(slowScript, '#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n', {
    mode: 0o755,
  });
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /import/dwg', () => {
  it('converts and imports a drawing into the live document', async () => {
    const { app, getLiveDoc } = await load({ LLULL_DWG2DXF: okScript });
    const res = await request(app)
      .post('/import/dwg?target=drawing&sourceUnit=m')
      .set('Content-Type', 'application/octet-stream')
      .send(DWG);
    expect(res.status).toBe(200);
    expect(res.body.isError).toBe(false);
    expect(res.body.command).toBe('import_dxf');
    expect(res.body.affected.length).toBeGreaterThan(0);
    expect(Object.keys(getLiveDoc().entities).length).toBeGreaterThan(0);
  }, 60_000);

  it('imports a survey point group from base64 JSON', async () => {
    const { app, getLiveDoc } = await load({ LLULL_DWG2DXF: okScript });
    const res = await request(app)
      .post('/import/dwg')
      .send({ base64: DWG.toString('base64'), target: 'survey', name: 'Topo', layers: ['TOPO'] });
    expect(res.status).toBe(200);
    expect(res.body.command).toBe('import_survey_dxf');
    expect(res.body.isError).toBe(false);
    expect(Object.keys(getLiveDoc().entities).length).toBeGreaterThan(0);
  }, 60_000);

  it('answers 503 with install instructions when no converter is available', async () => {
    const { app } = await load({ LLULL_DWG2DXF: 'off' });
    const res = await request(app)
      .post('/import/dwg')
      .set('Content-Type', 'application/octet-stream')
      .send(DWG);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/libredwg-tools/);
  }, 60_000);

  it('answers 503 when the configured executable does not exist', async () => {
    const { app } = await load({ LLULL_DWG2DXF: path.join(dir, 'does-not-exist') });
    const res = await request(app)
      .post('/import/dwg')
      .set('Content-Type', 'application/octet-stream')
      .send(DWG);
    expect(res.status).toBe(503);
  }, 60_000);

  it('answers 400 for bytes without the AC10xx header', async () => {
    const { app } = await load({ LLULL_DWG2DXF: okScript });
    const res = await request(app)
      .post('/import/dwg')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('0\nSECTION\n2\nENTITIES\n'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Not a DWG/);
  }, 60_000);

  it('answers 400 for an unknown target and for a missing body', async () => {
    const { app } = await load({ LLULL_DWG2DXF: okScript });
    const bad = await request(app)
      .post('/import/dwg?target=nope')
      .set('Content-Type', 'application/octet-stream')
      .send(DWG);
    expect(bad.status).toBe(400);
    const empty = await request(app).post('/import/dwg').send({});
    expect(empty.status).toBe(400);
  }, 60_000);

  it('answers 504 when the converter exceeds the timeout, and cleans its temp dir', async () => {
    const { app } = await load({ LLULL_DWG2DXF: slowScript, LLULL_DWG_TIMEOUT_MS: '300' });
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('llull-dwg-'));
    const res = await request(app)
      .post('/import/dwg')
      .set('Content-Type', 'application/octet-stream')
      .send(DWG);
    expect(res.status).toBe(504);
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('llull-dwg-'));
    expect(after.length).toBeLessThanOrEqual(before.length);
  }, 60_000);
});
