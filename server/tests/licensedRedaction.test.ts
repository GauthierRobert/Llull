/**
 * TR-MAT-32: licensed (licensed-no-redistribution) material values are redacted from answers to a non-local client, over MCP and REST;
 * a loopback peer (CLI, desktop) still reads them. A relayed request (X-Forwarded-For) is not a local peer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { libraryHash } from '@core/commands/materials/libraryFormat';
import type { MaterialLibrary } from '@core/model/materialLibrary';
import { app } from '../src/index';
import { applyCommand, _resetHistory } from '../src/commandBus';
import { _resetLiveDoc } from '../src/liveDocument';
import { createLibraryStorePort } from '../src/libraries/libraryStore';
import { INITIALIZE_PARAMS, type McpToolResult } from './mcpTestSupport';

const SENTINEL = 123.456789;
const REMOTE = { 'X-Forwarded-For': '203.0.113.9' };
const model = (id: string, property: string, value: number, unit: string, basis: string): Record<string, unknown> => ({
  id,
  property,
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis,
  provenance: { citation: 'synthetic', locator: 'Table 3.7.6.0(b)' },
});
const file = {
  format: 'llull-material-library',
  schemaVersion: 1,
  id: 'mmpds',
  version: '2024',
  title: 'Licensed',
  licence: 'licensed-no-redistribution',
  exportMarking: { regime: 'none' },
  storage: 'private',
  sources: {},
  materials: [
    {
      id: 'aa7075_t6',
      name: 'aa7075_t6',
      designation: '7075',
      specs: [],
      licence: 'licensed-no-redistribution',
      exportMarking: { regime: 'none' },
      propertyModels: [model('density', 'density', 2.81, 'g/cm^3', 'company'), model('Ftu.A', 'Ftu', SENTINEL, 'ksi', 'A')],
    },
  ],
};
const ALLOWABLE = { material: 'aa7075_t6', property: 'Ftu', basis: 'A' };

let directory = '';
const previousDirectory = process.env['LLULL_LIBRARIES_DIR'];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-redact-'));
  process.env['LLULL_LIBRARIES_DIR'] = directory;
  _resetLiveDoc();
  _resetHistory();
  const library = file as unknown as MaterialLibrary;
  createLibraryStorePort().register(library, libraryHash(library));
  const imported = applyCommand('import_material_library', { libraryId: 'mmpds', version: '2024', sha256: libraryHash(library) });
  expect(imported.isError, imported.summary).toBe(false);
});

afterEach(() => {
  if (previousDirectory === undefined) delete process.env['LLULL_LIBRARIES_DIR'];
  else process.env['LLULL_LIBRARIES_DIR'] = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

const command = (name: string, params: Record<string, unknown>, headers: Record<string, string> = {}): request.Test =>
  request(app).post('/command').set(headers).send({ name, params });

async function mcpCall(headers: Record<string, string>, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const post = (session?: string): request.Test => {
    const req = request(app)
      .post('/mcp')
      .set(headers)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream');
    return session !== undefined ? req.set('mcp-session-id', session) : req;
  };
  const rpc = async (body: object, session?: string): Promise<request.Response> => {
    const res = await post(session).send(body);
    expect(res.status).toBe(200);
    return res;
  };
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS });
  const session = init.headers['mcp-session-id'] as string;
  await post(session).send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'enable_toolset', arguments: { toolset: 'materials' } } },
    session,
  );
  const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, session);
  const line = res.text.split('\n').find((entry) => entry.startsWith('data: ') && entry.includes('"id":3'));
  return (JSON.parse((line ?? '').slice('data: '.length)) as { result: McpToolResult }).result;
}

describe('licensed values and non-local clients (TR-MAT-32)', () => {
  it('REST /command: a loopback peer reads the value, a relayed peer gets redacted data with basis and locator kept', async () => {
    const local = await command('get_material_allowable', ALLOWABLE);
    expect(local.body.data).toMatchObject({ available: true, value: SENTINEL, unit: 'ksi', basis: 'A' });
    const remote = await command('get_material_allowable', ALLOWABLE, REMOTE);
    expect(remote.status).toBe(200);
    expect(JSON.stringify(remote.body)).not.toContain(String(SENTINEL));
    expect(remote.body.data).toMatchObject({
      redacted: true,
      available: true,
      basis: 'A',
      unit: 'ksi',
      modelId: 'Ftu.A',
      provenance: { citation: 'synthetic', locator: 'Table 3.7.6.0(b)' },
    });
    expect(remote.body.data.value).toBeUndefined();
    expect(remote.body.summary).toContain('redacted: true');
  });

  it('REST /command: get_material and evaluate_property lose values (and the resolved density) for a remote peer', async () => {
    const material = await command('get_material', { material: 'aa7075_t6' }, REMOTE);
    expect(JSON.stringify(material.body)).not.toContain(String(SENTINEL));
    expect(JSON.stringify(material.body)).not.toContain('"kgPerM3"');
    expect(material.body.data.redacted).toBe(true);
    expect(material.body.data.values.map((entry: { id: string; basis: string }) => [entry.id, entry.basis])).toEqual([
      ['density', 'company'],
      ['Ftu.A', 'A'],
    ]);
    expect(material.body.data.record.licence).toBe('licensed-no-redistribution');
    const evaluated = await command('evaluate_property', { material: 'aa7075_t6', property: 'Ftu', at: {} }, REMOTE);
    expect(JSON.stringify(evaluated.body)).not.toContain(String(SENTINEL));
    expect(evaluated.body.data).toMatchObject({ redacted: true, basis: 'A' });
    const localMaterial = await command('get_material', { material: 'aa7075_t6' });
    expect(JSON.stringify(localMaterial.body)).toContain(String(SENTINEL));
  });

  it('MCP: a relayed session gets the redacted answer, a loopback session the value', async () => {
    const local = await mcpCall({}, 'get_material_allowable', ALLOWABLE);
    expect(JSON.stringify(local)).toContain(String(SENTINEL));
    const remote = await mcpCall(REMOTE, 'get_material_allowable', ALLOWABLE);
    expect(remote.isError).toBe(false);
    expect(JSON.stringify(remote)).not.toContain(String(SENTINEL));
    expect(remote.structuredContent).toMatchObject({ redacted: true, basis: 'A', provenance: { locator: 'Table 3.7.6.0(b)' } });
  });

  it('a non-licensed record is not redacted for a remote peer', async () => {
    applyCommand('define_material_record', {
      id: 'open',
      designation: 'x',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    applyCommand('set_material_property', {
      material: 'open',
      property: 'Ftu',
      value: 77,
      unit: 'ksi',
      basis: 'A',
      source: { citation: 'synthetic' },
    });
    const remote = await command('get_material_allowable', { material: 'open', property: 'Ftu', basis: 'A' }, REMOTE);
    expect(remote.body.data).toMatchObject({ value: 77 });
    expect(remote.body.data.redacted).toBeUndefined();
  });
});
