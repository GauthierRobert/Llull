/**
 * @layer server/tests
 *
 * HTTP + MCP end-to-end tests for the CAD-exchange surface:
 *   GET /export/code, GET /export/step, MCP tools export_step / import_step / import_code.
 *
 * index.ts reads LLULL_* env at import time, so each scenario loads a fresh module graph
 * (vi.resetModules) with the environment it needs.
 */

import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { BUILD123D_PYTHON, CADQUERY_PYTHON, probePython } from './exchangeTestSupport';

const hasCadQuery = probePython(CADQUERY_PYTHON).cadquery !== null;
const hasBuild123d =
  BUILD123D_PYTHON !== undefined && probePython(BUILD123D_PYTHON).build123d !== null;

interface LoadedServer {
  app: Express;
  applyCommand: (name: string, params: unknown) => { affected: string[]; isError: boolean };
  getLiveDoc: () => { entities: Record<string, { kind: string; name?: string }> };
  reset: () => void;
}

async function loadServer(env: Record<string, string | undefined>): Promise<LoadedServer> {
  vi.resetModules();
  const keys = [
    'LLULL_PYTHON',
    'LLULL_PYTHON_BUILD123D',
    'LLULL_ALLOW_CODE_EXECUTION',
    'LLULL_EXCHANGE_DIR',
  ];
  for (const key of keys) vi.stubEnv(key, env[key]);
  const { app } = await import('../src/index');
  const bus = await import('../src/commandBus');
  const live = await import('../src/liveDocument');
  const { installGeometryKernel } = await import('../src/geometryKernel');
  await installGeometryKernel();
  const reset = (): void => {
    live._resetLiveDoc();
    bus._resetHistory();
  };
  reset();
  return {
    app,
    applyCommand: bus.applyCommand as LoadedServer['applyCommand'],
    getLiveDoc: live.getLiveDoc as unknown as LoadedServer['getLiveDoc'],
    reset,
  };
}

/**
 * The first import of the whole server graph is a cold transform (seconds, much more under a
 * parallel run); do it once here, under a generous hook timeout, so no test pays for it against
 * the 5 s test timeout. Later `vi.resetModules()` + imports reuse the transformed modules.
 */
beforeAll(async () => {
  await import('../src/index');
  await import('../src/geometryKernel');
}, 120_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

function seedPlateWithHole(server: LoadedServer): void {
  const plate = server.applyCommand('add_box', {
    size: [40, 20, 8],
    position: [0, 0, 4],
    color: '#336699',
  });
  const hole = server.applyCommand('add_cylinder', { radius: 4, height: 20, position: [0, 0, 4] });
  const cut = server.applyCommand('boolean_subtract', {
    a: plate.affected[0],
    b: hole.affected[0],
  });
  expect(cut.isError).toBe(false);
  expect(cut.affected).toHaveLength(1);
  server.applyCommand('set_entity_name', { id: cut.affected[0], name: 'Base plate' });
}

// ---------------------------------------------------------------------------
// GET /export/code
// ---------------------------------------------------------------------------

describe('GET /export/code', () => {
  it('defaults to cadquery and sends an attachment', async () => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    server.applyCommand('add_box', { size: [10, 20, 30] });
    const res = await request(server.app).get('/export/code');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="model\.py"$/);
    expect(res.text).toContain('import cadquery as cq');
    expect(res.text).toContain('LLULL_TRACE');
    expect(res.text).toContain('box((10, 20, 30)');
  });

  it.each([
    ['build123d', 'model.py', 'build123d'],
    ['openscad', 'model.scad', 'cube('],
    ['freecad', 'model.FCMacro', 'FreeCAD'],
  ])('language=%s -> %s', async (language, fileName, marker) => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    server.applyCommand('add_box', { size: [10, 20, 30] });
    const res = await request(server.app).get('/export/code').query({ language });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${fileName}"`);
    expect(res.text).toContain(marker);
  });

  it('unknown language is a 400; name is sanitized into the filename', async () => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    server.applyCommand('add_box', { size: [1, 2, 3] });
    const res = await request(server.app)
      .get('/export/code')
      .query({ language: 'cobol', name: 'my part/../x' });
    expect(res.status).toBe(400);
    const ok = await request(server.app).get('/export/code').query({ name: 'my part/../x' });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('import cadquery as cq');
    const disposition = String(ok.headers['content-disposition']);
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.py"$/);
    expect(disposition).not.toContain('/');
  });

  it('works on an empty document (header-only program)', async () => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    const res = await request(server.app).get('/export/code');
    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /export/step
// ---------------------------------------------------------------------------

describe('GET /export/step without Python', () => {
  it('returns 503 with an explanatory error when LLULL_PYTHON=off', async () => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    server.applyCommand('add_box', { size: [10, 10, 10] });
    const res = await request(server.app).get('/export/step');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/LLULL_PYTHON/);
  });

  it('falls back to the exact OCC kernel: a STEP solid with analytic faces', async () => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    const { setGeometryKernel } = await import('@core/geometry/kernel');
    const { createNodeOcctKernel } = await import('../src/occtNode');
    setGeometryKernel(await createNodeOcctKernel());
    server.applyCommand('add_cylinder', { radius: 2, height: 5 });
    const res = await request(server.app).get('/export/step?name=part');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('part.step');
    expect(res.text).toMatch(/^ISO-10303-21;/);
    expect(res.text).toMatch(/CYLINDRICAL_SURFACE/);
  }, 120_000);

  it('returns a graceful 500 when the configured python cannot start', async () => {
    const server = await loadServer({ LLULL_PYTHON: '/nonexistent/python-xyz' });
    server.applyCommand('add_box', { size: [10, 10, 10] });
    const res = await request(server.app).get('/export/step');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/cannot start Python/);
  });
});

describe.skipIf(!hasCadQuery)('GET /export/step with CadQuery', () => {
  it('returns a real STEP file as an attachment', async () => {
    const server = await loadServer({ LLULL_PYTHON: CADQUERY_PYTHON });
    seedPlateWithHole(server);
    const res = await request(server.app)
      .get('/export/step')
      .query({ name: 'plate' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('model/step');
    expect(res.headers['content-disposition']).toBe('attachment; filename="plate.step"');
    const body = res.body as Buffer;
    expect(Number(res.headers['content-length'])).toBe(body.length);
    expect(body.subarray(0, 13).toString('utf8')).toBe('ISO-10303-21;');
    expect(body.toString('utf8')).toContain('Base plate');
  }, 120_000);

  it('returns 500 with the reason when the model has no solids', async () => {
    const server = await loadServer({ LLULL_PYTHON: CADQUERY_PYTHON });
    const res = await request(server.app).get('/export/step');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/no 3D solids/);
  });
});

describe.skipIf(!hasBuild123d)('GET /export/step with build123d', () => {
  it('uses LLULL_PYTHON_BUILD123D for language=build123d', async () => {
    const server = await loadServer({
      LLULL_PYTHON: CADQUERY_PYTHON,
      LLULL_PYTHON_BUILD123D: BUILD123D_PYTHON,
    });
    seedPlateWithHole(server);
    const res = await request(server.app)
      .get('/export/step')
      .query({ language: 'build123d' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 13).toString('utf8')).toBe('ISO-10303-21;');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// MCP end-to-end
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

let rpcId = 1;

function parseSse(text: string, id: number): unknown {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const parsed = JSON.parse(line.slice(6)) as { id?: number; result?: unknown };
    if (parsed.id === id) return parsed.result;
  }
  return undefined;
}

async function rpc(
  app: Express,
  sessionId: string | null,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result: unknown; sessionId: string | null }> {
  const id = rpcId++;
  let req = request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (sessionId !== null) req = req.set('mcp-session-id', sessionId);
  const res = await req.send({ jsonrpc: '2.0', id, method, params });
  expect(res.status).toBe(200);
  const header = res.headers['mcp-session-id'];
  return { result: parseSse(res.text, id), sessionId: typeof header === 'string' ? header : null };
}

async function mcpSession(app: Express): Promise<string> {
  const init = await rpc(app, null, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'exchange-test', version: '0.0.1' },
  });
  expect(init.sessionId).not.toBeNull();
  await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-session-id', init.sessionId as string)
    .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return init.sessionId as string;
}

async function callTool(
  app: Express,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { result } = await rpc(app, sessionId, 'tools/call', { name, arguments: args });
  expect(result).toBeDefined();
  return result as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text ?? '').join('\n');
}

describe('MCP exchange tools without Python', () => {
  it('export_step explains how to enable the bridge (isError)', async () => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    server.applyCommand('add_box', { size: [10, 10, 10] });
    const sessionId = await mcpSession(server.app);
    const result = await callTool(server.app, sessionId, 'export_step', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Python bridge/);
  });

  it('import_code is refused by default, and the document is untouched', async () => {
    const server = await loadServer({ LLULL_PYTHON: CADQUERY_PYTHON });
    server.applyCommand('add_box', { size: [10, 10, 10] });
    const sessionId = await mcpSession(server.app);
    const result = await callTool(server.app, sessionId, 'import_code', { code: 'result = 1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/LLULL_ALLOW_CODE_EXECUTION=1/);
    expect(Object.keys(server.getLiveDoc().entities)).toHaveLength(1);
  });

  it('import_step with no input reports a clear error when Python is configured but args are missing', async () => {
    const server = await loadServer({ LLULL_PYTHON: CADQUERY_PYTHON });
    const sessionId = await mcpSession(server.app);
    const result = await callTool(server.app, sessionId, 'import_step', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/stepBase64 or path/);
  });

  it('tools/list serves the exchange tools', async () => {
    const server = await loadServer({ LLULL_PYTHON: 'off' });
    const sessionId = await mcpSession(server.app);
    const { result } = await rpc(server.app, sessionId, 'tools/list', {});
    const names = (result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const tool of ['export_step', 'import_step', 'import_code']) {
      expect(names).toContain(tool);
    }
  });
});

describe.skipIf(!hasCadQuery)('MCP exchange tools with CadQuery', () => {
  let server: LoadedServer;
  let sessionId: string;

  beforeAll(async () => {
    server = await loadServer({ LLULL_PYTHON: CADQUERY_PYTHON, LLULL_ALLOW_CODE_EXECUTION: '1' });
    sessionId = await mcpSession(server.app);
  }, 60_000);

  it('export_step returns stepBase64 in structuredContent and never in the text', async () => {
    server.reset();
    seedPlateWithHole(server);
    const result = await callTool(server.app, sessionId, 'export_step', { name: 'plate' });
    expect(result.isError).toBeFalsy();
    const stepBase64 = result.structuredContent?.['stepBase64'];
    expect(typeof stepBase64).toBe('string');
    expect(Buffer.from(stepBase64 as string, 'base64').toString('utf8')).toContain('ISO-10303-21');
    expect(textOf(result)).not.toContain(stepBase64 as string);
    expect(textOf(result)).toMatch(/plate\.step/);
    expect(result.structuredContent?.['fileName']).toBe('plate.step');
  }, 120_000);

  it('import_step adds the STEP solids (named) to the live document', async () => {
    server.reset();
    seedPlateWithHole(server);
    const exported = await callTool(server.app, sessionId, 'export_step', {});
    const stepBase64 = exported.structuredContent?.['stepBase64'] as string;
    server.reset();
    const imported = await callTool(server.app, sessionId, 'import_step', { stepBase64 });
    expect(imported.isError).toBeFalsy();
    const entities = Object.values(server.getLiveDoc().entities);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.kind).toBe('mesh');
    expect(entities[0]?.name).toBe('Base plate');
  }, 120_000);

  it('import_code replaces the live document from exported parametric code', async () => {
    server.reset();
    seedPlateWithHole(server);
    server.applyCommand('set_parameter', { name: 'width', expression: '40' });
    const code = (await request(server.app).get('/export/code')).text;
    expect(code).toContain('LLULL_TRACE');

    server.reset();
    server.applyCommand('add_sphere', { radius: 3 });
    const before = Object.keys(server.getLiveDoc().entities);
    const result = await callTool(server.app, sessionId, 'import_code', { code });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/parametric/);
    const after = server.getLiveDoc();
    const kinds = Object.values(after.entities).map((e) => e.kind);
    expect(Object.keys(after.entities)).not.toEqual(before);
    expect(kinds).not.toContain('sphere');
    expect(Object.values(after.entities).map((e) => e.name)).toContain('Base plate');
  }, 120_000);

  it('import_code with a raw script appends meshes and reports success', async () => {
    server.reset();
    const result = await callTool(server.app, sessionId, 'import_code', {
      code: 'import cadquery as cq\nresult = cq.Workplane().box(10,20,30)\n',
      mode: 'append',
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/non-llull/);
    expect(Object.values(server.getLiveDoc().entities).map((e) => e.kind)).toEqual(['mesh']);
  }, 120_000);

  it('import_code surfaces script errors and leaves the document unchanged', async () => {
    server.reset();
    server.applyCommand('add_sphere', { radius: 3 });
    const result = await callTool(server.app, sessionId, 'import_code', {
      code: 'raise RuntimeError("kaboom 7")\n',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/kaboom 7/);
    expect(Object.values(server.getLiveDoc().entities).map((e) => e.kind)).toEqual(['sphere']);
  }, 120_000);
});

describe.skipIf(!hasCadQuery)('MCP exchange tools with an exchange directory', () => {
  let server: LoadedServer;
  let sessionId: string;
  let exchangeDir: string;

  beforeAll(async () => {
    exchangeDir = await mkdtemp(path.join(tmpdir(), 'llull-xchg-'));
    server = await loadServer({
      LLULL_PYTHON: CADQUERY_PYTHON,
      LLULL_ALLOW_CODE_EXECUTION: '1',
      LLULL_EXCHANGE_DIR: exchangeDir,
    });
    sessionId = await mcpSession(server.app);
  }, 60_000);

  afterAll(async () => {
    await rm(exchangeDir, { recursive: true, force: true });
  });

  it('export_step saves into the directory, import_step reads it back by path', async () => {
    server.reset();
    seedPlateWithHole(server);
    const exported = await callTool(server.app, sessionId, 'export_step', { name: 'saved' });
    expect(exported.isError).toBeFalsy();
    expect(exported.structuredContent?.['savedTo']).toBe(path.join(exchangeDir, 'saved.step'));
    expect(
      (await readFile(path.join(exchangeDir, 'saved.step'), 'utf8')).startsWith('ISO-10303-21'),
    ).toBe(true);
    server.reset();
    const imported = await callTool(server.app, sessionId, 'import_step', { path: 'saved.step' });
    expect(imported.isError).toBeFalsy();
    expect(Object.values(server.getLiveDoc().entities).map((e) => e.name)).toEqual(['Base plate']);
  }, 120_000);

  it('import_code reads a script by path', async () => {
    server.reset();
    await writeFile(
      path.join(exchangeDir, 'raw.py'),
      'import cadquery as cq\nresult = cq.Workplane().box(5,5,5)\n',
    );
    const result = await callTool(server.app, sessionId, 'import_code', { path: 'raw.py' });
    expect(result.isError).toBeFalsy();
    expect(Object.keys(server.getLiveDoc().entities)).toHaveLength(1);
  }, 120_000);

  it('rejects path traversal and absolute paths', async () => {
    server.reset();
    for (const bad of ['../etc/passwd', '/etc/passwd']) {
      const step = await callTool(server.app, sessionId, 'import_step', { path: bad });
      expect(step.isError).toBe(true);
      expect(textOf(step)).toMatch(/inside the exchange directory/);
      const code = await callTool(server.app, sessionId, 'import_code', { path: bad });
      expect(code.isError).toBe(true);
      expect(textOf(code)).toMatch(/inside the exchange directory/);
    }
    expect(Object.keys(server.getLiveDoc().entities)).toHaveLength(0);
  });
});
