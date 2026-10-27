/**
 * TECHNICAL_SPEC 13.11 on the real host paths: a command that reads triangles sees the stored mesh of an asset-backed body that its params
 * reach only through an instance and its component, in the synchronous and the resolving command bus, in `llull --doc` and in
 * `llull --server`; a reach that is too large or whose asset this machine lacks refuses by name on each of them. The real content-addressed
 * store, no fake engine.
 */

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { newEntity } from '@core/commands/entity/newEntity';
import { MESH_FULL_READ_TRIANGLE_CAP } from '@core/geometry/mesh/assets';
import { type CadDocument, createEmptyDocument, type Entity, type MeshData } from '@core/model/types';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { writeDocumentFile } from '../src/documentFile';
import { app } from '../src/index';
import { _resetHistory, applyCommand, applyCommandAsync } from '../src/commandBus';
import { _resetLiveDoc } from '../src/liveDocument';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { runCfdSolve } from '../src/cfd/flowSolve';
import { createFeArtifactStore } from '../src/fea/artifactStore';
import type { ComputeRunner } from '../src/native/computeJob';
import type { NativeDeps } from '../src/native/fatigueField';
import type { FeaHost } from '@protocol/index';
import { icosphere } from '../../tests/helpers/meshFixtures';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-mesh-reach-')), 'cache');

function cube(size: number): MeshData {
  const positions: number[] = [];
  for (let corner = 0; corner < 8; corner++) positions.push((corner & 1) * size, ((corner >> 1) & 1) * size, ((corner >> 2) & 1) * size);
  // prettier-ignore
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { positions, indices };
}

const BOUNDS = { min: [0, 0, 0], max: [10, 10, 10] } as const;

interface Fixture {
  readonly doc: CadDocument;
  readonly instance: string;
}

/** A display cube of edge 1 standing for a stored cube of edge 10, reached only through the instance of a component. */
function fixture(asset: { key: string; triangles: number }): Fixture {
  const entity: Entity = newEntity(
    'mesh',
    'scan',
    { mesh: cube(1), asset: { ...asset, vertices: 8, bounds: BOUNDS } },
    [0, 0, 0],
    '#cccccc',
  );
  const base: CadDocument = { ...createEmptyDocument(), units: 'm', entities: { scan: entity }, order: ['scan'] };
  const made = execute(base, 'create_component', { name: 'part', entityIds: ['scan'] });
  return { doc: made.document, instance: made.affected[0] as string };
}

const stored = (): { key: string; triangles: number } => ({ key: defaultMeshAssetStore().writeMesh(cube(10)).key, triangles: 12 });
const missing = { key: 'e'.repeat(64), triangles: 12 };
const huge = (): { key: string; triangles: number } => ({ key: stored().key, triangles: MESH_FULL_READ_TRIANGLE_CAP + 1 });

const measure = (instance: string): Record<string, unknown> => ({ entityId: instance });
const volumeOf = (data: unknown): number => (data as { volume: number }).volume;

describe('the command bus', () => {
  let current: Fixture;
  beforeEach(() => {
    current = fixture(stored());
    _resetLiveDoc(current.doc);
    _resetHistory();
  });

  it('synchronous and resolving: mass_properties of the instance reads the stored mesh of its component', async () => {
    expect(volumeOf(applyCommand('mass_properties', measure(current.instance)).data)).toBeCloseTo(1000, 6);
    const resolved = await applyCommandAsync('mass_properties', measure(current.instance));
    expect(volumeOf(resolved.data)).toBeCloseTo(1000, 6);
  });

  it('a query warns by name when the asset is not in the store, and a reach above the cap refuses', async () => {
    const lacking = fixture(missing);
    _resetLiveDoc(lacking.doc);
    const warned = applyCommand('mass_properties', measure(lacking.instance));
    expect(warned.error).toBeUndefined();
    expect((warned.data as { lodOnly?: string[] }).lodOnly).toEqual(['scan']);
    expect(warned.summary).toContain('MESH_ASSET_LOD_ONLY');
    const large = fixture(huge());
    _resetLiveDoc(large.doc);
    const tooLarge = await applyCommandAsync('mass_properties', measure(large.instance));
    expect(tooLarge.error?.code).toBe('MESH_ASSET_TOO_LARGE');
    expect(tooLarge.error?.ids).toEqual(['scan']);
  });
});

describe('the llull CLI', () => {
  let server: Server;
  let url = '';
  let dir = '';

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(tmpdir(), 'llull-mesh-reach-cli-'));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function cli(args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    };
    const code = await runCli([...args, '--json'], io);
    return { code, json: JSON.parse(out.join('')) as Record<string, unknown> };
  }

  const docFile = (name: string, built: Fixture): string => {
    const file = path.join(dir, name);
    writeDocumentFile(file, built.doc);
    return file;
  };

  it('--doc: reads the stored mesh through the instance; a missing asset and a reach above the cap refuse by name', async () => {
    const ok = fixture(stored());
    const read = await cli(['mass_properties', `entityId=${ok.instance}`, '--doc', docFile('ok.llull.json', ok)]);
    expect(read.code).toBe(EXIT_OK);
    expect(volumeOf(read.json['data'])).toBeCloseTo(1000, 6);
    const lacking = fixture(missing);
    const lost = await cli(['mass_properties', `entityId=${lacking.instance}`, '--doc', docFile('lost.llull.json', lacking)]);
    expect(lost.code).toBe(EXIT_OK);
    expect((lost.json['data'] as { lodOnly?: string[] }).lodOnly).toEqual(['scan']);
    const large = fixture(huge());
    const refused = await cli(['mass_properties', `entityId=${large.instance}`, '--doc', docFile('large.llull.json', large)]);
    expect(refused.code).toBe(EXIT_COMMAND_ERROR);
    expect(JSON.stringify(refused.json)).toContain('MESH_ASSET_TOO_LARGE');
  });

  it('--server: the backend reads the stored mesh through the instance', async () => {
    const built = fixture(stored());
    _resetLiveDoc(built.doc);
    _resetHistory();
    const read = await cli(['exec', 'mass_properties', `entityId=${built.instance}`, '--server', url]);
    expect(read.code).toBe(EXIT_OK);
    expect(volumeOf(read.json['data'])).toBeCloseTo(1000, 6);
    const large = fixture(huge());
    _resetLiveDoc(large.doc);
    const refused = await cli(['exec', 'mass_properties', `entityId=${large.instance}`, '--server', url]);
    expect(refused.code).toBe(EXIT_COMMAND_ERROR);
    expect(JSON.stringify(refused.json)).toContain('MESH_ASSET_TOO_LARGE');
  });
});

describe('host-built jobs read the stored mesh of an asset-backed body, or refuse by name', () => {
  const stored = icosphere(0.5, 3); // 1280 triangles in the store, 80 in the document
  const asset = (): { key: string; triangles: number } => ({ key: defaultMeshAssetStore().writeMesh(stored).key, triangles: 1280 });

  function cfdDoc(ref: { key: string; triangles: number }): CadDocument {
    const entity: Entity = newEntity(
      'mesh',
      'ball',
      { mesh: icosphere(0.5, 1), asset: { ...ref, vertices: 642, bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] } } },
      [0, 0, 0],
      '#cccccc',
    );
    const base: CadDocument = { ...createEmptyDocument(), units: 'm', entities: { ball: entity }, order: ['ball'] };
    return execute(base, 'create_cfd_case', {
      id: 're100',
      entityIds: ['ball'],
      freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.01 } },
      reference: { areaM2: 0.7853981634, lengthM: 1 },
      cellsPerReferenceLength: 8,
    }).document;
  }
  const missingRunner = (): ComputeRunner => ({
    binary: null,
    run: () => Promise.reject(new Error('never started')),
    version: () => Promise.resolve('unknown'),
  });
  const host = (doc: CadDocument): FeaHost => ({ getDoc: () => doc, applyCommand: () => ({ summary: '', affected: [], isError: true }) });
  const deps = (): NativeDeps => ({
    store: createFeArtifactStore(mkdtempSync(path.join(tmpdir(), 'llull-reach-fe-'))),
    runner: missingRunner(),
  });

  it('cfd_solve is handed the stored mesh (it gets as far as the missing binary) and refuses an asset this machine lacks', async () => {
    const built = await runCfdSolve('re100', {}, host(cfdDoc(asset())), deps());
    expect(built).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_MISSING' } });
    const lacking = await runCfdSolve('re100', {}, host(cfdDoc({ key: 'f'.repeat(64), triangles: 1280 })), deps());
    expect(lacking).toMatchObject({ isError: true, data: { code: 'MESH_ASSET_LOD_ONLY' } });
    expect(JSON.stringify(lacking)).toContain("'ball'");
  });
});
