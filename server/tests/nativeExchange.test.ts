/**
 * The native transports (fatigue_field, fea_map_field, fea_render) through `POST /exchange` and the `llull --server` CLI path: each runs
 * remotely against the live document and the process artifact store, and answers the same data as the local in-process run (timings
 * aside). With `llull-compute` built (cargo build --release in solver/) the native jobs really run; without it both sides answer the same
 * NATIVE_TOOL_MISSING / TypeScript-fallback outcome, so the routing is still proven.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary } from '@cae/results/summary';
import { createFeArtifactStore, defaultFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { buildExchangeRouter } from '../src/exchangeRoutes';
import { _resetLiveDoc } from '../src/liveDocument';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runNativeTool } from '../src/native/tools';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { feFatigue } from '../../tests/unit/cae/fatigue/feFixtures';
import { gridMesh } from '../../tests/unit/cae/gridMesh';
import { thermoFixture, withThermalSource } from '../../tests/unit/cae/thermomech/fixtures';

type Json = Record<string, unknown>;
type FeArtifact = FeMeshArtifact | FeResultsArtifact;

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('nativeExchange: llull-compute not built: both sides answer NATIVE_TOOL_MISSING (routing still checked)');

let dir = '';
let server: Server;
let url = '';
const previousCache = process.env['LLULL_FEA_CACHE'];
const app = express()
  .use(express.json({ limit: '50mb' }))
  .use(buildExchangeRouter((_req, _res, next) => next(), { port: null, allowCodeExecution: false }));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-native-exchange-'));
  process.env['LLULL_FEA_CACHE'] = path.join(dir, 'server-cache');
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousCache === undefined) delete process.env['LLULL_FEA_CACHE'];
  else process.env['LLULL_FEA_CACHE'] = previousCache;
  rmSync(dir, { recursive: true, force: true });
  _resetLiveDoc();
});

/** The same case remotely (live document + process store) and locally (a fresh store holding the same artifacts). */
function stage(doc: CadDocument, artifacts: readonly FeArtifact[]): { local: FeaHost; store: FeArtifactCache } {
  for (const artifact of artifacts) defaultFeArtifactStore().put(artifact);
  _resetLiveDoc(doc);
  const store = createFeArtifactStore(mkdtempSync(path.join(dir, 'local-')));
  for (const artifact of artifacts) store.put(artifact);
  const local: FeaHost = {
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
  return { local, store };
}

/** An outcome without its timings (elapsed ms in data and summary). */
function stable(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\d+ ms\b/g, 'N ms');
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/elapsedMs|referenceMs/.test(key))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

async function localRun(name: string, params: Json, host: FeaHost, store: FeArtifactCache): Promise<unknown> {
  return stable(await runNativeTool(name, params, host, { store, runner: createComputeRunner(process.env), env: process.env }));
}

async function remoteRun(name: string, params: Json): Promise<unknown> {
  const response = await request(app).post('/exchange').send({ name, params, client: 'cli' });
  expect(response.status).toBe(200);
  return stable(response.body);
}

async function cliRun(argv: readonly string[]): Promise<{ code: number; json: Json }> {
  const out: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
  const code = await runCli([...argv, '--server', url, '--json'], io);
  return { code, json: JSON.parse(out.join('\n')) as Json };
}

function mappedCase(): { doc: CadDocument; analysisId: string; artifacts: FeArtifact[] } {
  const base = thermoFixture();
  const mesh = (grid: ReturnType<typeof gridMesh>, inputHash = ''): FeMeshArtifact => ({
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash,
    nodes: grid.nodes,
    blocks: [{ type: 'C3D4', entityId: base.boxId, elements: grid.elements.map((nodes, i) => [i + 1, ...nodes]) }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  });
  const source = withThermalSource(base, { mesh: mesh(gridMesh({ cells: [6, 5, 4], size: [10, 10, 10] })) });
  const { analysisId } = base;
  let doc = execute(source.fixture.doc, 'set_temperature_field', {
    analysisId,
    source: { kind: 'thermal_result', analysisId: source.thermalId, time: 'last', mapping: 'interpolate' },
  }).document;
  const target = mesh(
    gridMesh({ cells: [9, 7, 6], size: [10.4, 10.2, 10.2], origin: [-0.2, -0.1, -0.1], firstNodeId: 5000 }),
    analysisInputHash(doc, analysisId, 'mesh'),
  );
  const scratch = createFeArtifactStore(mkdtempSync(path.join(dir, 'mesh-')));
  const targetHash = scratch.put(target);
  doc = execute(
    doc,
    'record_fe_mesh',
    { analysisId, summary: meshSummary(target, targetHash) },
    { ...defaultContext(), feaArtifacts: scratch },
  ).document;
  return { doc, analysisId, artifacts: [source.thermalMesh, source.results, target] };
}

describe('native transports through POST /exchange and llull --server', () => {
  it('fatigue_field runs remotely on the live document and answers the local data (VC-FAT-43 field, hot spots)', async () => {
    const fixture = feFatigue({ cells: [6, 3, 3], steps: 200, seed: 5 });
    const { local, store } = stage(fixture.doc, [fixture.mesh, fixture.results]);
    const params = { caseId: fixture.caseId, verify: true };
    const remote = (await remoteRun('fatigue_field', params)) as Json;
    expect(remote).toEqual({ ...((await localRun('fatigue_field', params, local, store)) as Json), changed: false });
    if (BINARY !== null) {
      expect(remote).toMatchObject({ isError: false, data: { nodes: 112, engine: 'native-cpu', verification: { identical: true } } });
      expect(((remote['data'] as Json)['computeFatigue'] as Json)['selection']).toBe('all_nodes');
    } else expect(remote).toMatchObject({ isError: true, data: { code: 'NATIVE_TOOL_MISSING' } });
    const cli = await cliRun(['fatigue_field', `caseId=${fixture.caseId}`, 'verify=true']);
    expect(cli.code).toBe(BINARY !== null ? EXIT_OK : 1);
    expect(stable(cli.json['data'])).toEqual(remote['data']);
  });

  it('fea_map_field maps remotely into the process store with the local report and field', async () => {
    const { doc, analysisId, artifacts } = mappedCase();
    const { local, store } = stage(doc, artifacts);
    const remote = (await remoteRun('fea_map_field', { analysisId })) as Json;
    expect(remote).toEqual({ ...((await localRun('fea_map_field', { analysisId }, local, store)) as Json), changed: false });
    if (BINARY !== null) {
      expect(remote).toMatchObject({ isError: false, data: { engine: 'native-cpu' } });
      const key = String((remote['data'] as Json)['key']);
      expect(defaultFeArtifactStore().get(key)).toEqual(store.get(key));
      const cli = await cliRun(['fea_map_field', `analysisId=${analysisId}`]);
      expect(cli).toMatchObject({ code: EXIT_OK, json: { data: { key, cached: true } } });
    } else expect(remote).toMatchObject({ isError: true, data: { code: 'NATIVE_TOOL_MISSING' } });
  });

  it('fea_render draws remotely the same plot as locally (cpu twin, else the TypeScript fallback)', async () => {
    const fixture = feFatigue({ cells: [8, 4, 4], steps: 4 });
    const { local, store } = stage(fixture.doc, [fixture.mesh, fixture.results]);
    const params = { analysisId: fixture.analysisId, width: 480, height: 320, raster: 'cpu' };
    const remote = (await remoteRun('fea_render', params)) as Json;
    expect(remote).toEqual({ ...((await localRun('fea_render', params, local, store)) as Json), changed: false });
    const data = remote['data'] as Json;
    expect(String(data['svg'])).toMatch(/^<svg/);
    expect((data['raster'] as Json)['engine']).toBe(BINARY !== null ? 'native-cpu' : 'ts');
    const cli = await cliRun(['fea_render', `analysisId=${fixture.analysisId}`, 'width=480', 'height=320', 'raster=cpu']);
    expect(cli.code).toBe(EXIT_OK);
    expect((cli.json['data'] as Json)['svg']).toBe(data['svg']);
  });

  it('refuses a bad native call remotely like locally, and other names still 404', async () => {
    _resetLiveDoc();
    expect(await remoteRun('fatigue_field', {})).toEqual({
      summary: 'fatigue_field: caseId is required.',
      affected: [],
      isError: true,
      changed: false,
    });
    expect((await request(app).post('/exchange').send({ name: 'add_box', params: {} })).status).toBe(404);
  });
});
