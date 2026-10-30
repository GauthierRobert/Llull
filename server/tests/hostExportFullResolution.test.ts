/**
 * Host paths that hand a stored mesh to a native geometry consumer (DES-7c native twins, TECHNICAL_SPEC 13.21): `export_step_ap242`, `export_iges` and the STEP of
 * `GET /export/step` (`exportStepFile`) through the command choke point, and the FEA mesher (`runFeaMesh`), which reads the document without it. Every one of them hands
 * the consumer the STORED 327,680-triangle mesh, never the 80-triangle display level of detail of the document, or refuses by name (MESH_ASSET_LOD_ONLY,
 * MESH_ASSET_TOO_LARGE). The real content-addressed asset store; the kernel is a scripted stand-in that records what it is asked to build.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { MESH_FULL_READ_TRIANGLE_CAP } from '@core/geometry/mesh/assets';
import { type CadDocument, createEmptyDocument, type Entity, type MeshData } from '@core/model/types';
import { exportStepFile, type FeaHost } from '@protocol/index';
import { fakeXdeKernel } from '../../tests/helpers/fakeXdeKernel';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { applyCommandAsync } from '../src/commandBus';
import { createFeArtifactStore } from '../src/fea/artifactStore';
import { serverContext } from '../src/fea/context';
import { caeHooks } from '../src/fea/caeHooks';
import { runFeaMesh } from '../src/fea/feaMesh';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { defaultMeshAssetStore } from '../src/meshAssets/store';
import { noisy } from './meshopsNativeSupport';

process.env['LLULL_MESH_CACHE'] = path.join(mkdtempSync(path.join(tmpdir(), 'llull-host-export-')), 'cache');

/** Icosphere level 7 (327,680 triangles), standing in the document for an 80-triangle display level of detail. */
const TRIANGLES = 327_680;
/** The stored mesh a kernel can be asked to rebuild: below the 20,000-triangle limit of the exact kernel (5,120 triangles; the display level has 80). */
const KERNEL_TRIANGLES = 5_120;
let scan: MeshData;
let small: MeshData;

beforeAll(() => {
  scan = noisy(icosphere(10, 7), 0.02);
  small = noisy(icosphere(10, 4), 0.02);
}, 120_000);

/** A document with the stored mesh as `scan` (asset-backed, display level of detail of 80 triangles). `held: false` leaves the asset out of the store. */
function scanDocument(options: { held?: boolean; claimed?: number; stored?: MeshData } = {}): CadDocument {
  const reference =
    options.held === false
      ? { ...defaultMeshAssetStore().writeMesh(icosphere(3, 1)), key: '0'.repeat(64) }
      : defaultMeshAssetStore().writeMesh(options.stored ?? scan);
  const asset = { ...reference, triangles: options.claimed ?? reference.triangles };
  const entity: Entity = newEntity('mesh', 'scan', { mesh: icosphere(10, 1), asset }, [0, 0, 0], '#cccccc');
  return { ...createEmptyDocument(), units: 'mm', entities: { scan: entity }, order: ['scan'] };
}

const trianglesOf = (entity: Entity): number => (entity.kind === 'mesh' ? entity.mesh.indices.length / 3 : -1);

beforeEach(() => {
  _resetLiveDoc(scanDocument());
  _resetHistory();
});

afterEach(() => {
  setGeometryKernel(null);
});

describe('the command paths: export_step_ap242, export_iges and GET /export/step', () => {
  beforeEach(() => _resetLiveDoc(scanDocument({ stored: small })));

  it.each([
    ['export_step_ap242', { schema: 'ap242', includeValidationProperties: false }],
    ['export_iges', {}],
  ])('%s hands the kernel the stored mesh', async (name, params) => {
    const seen: number[] = [];
    setGeometryKernel(fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) }).kernel);
    const result = await applyCommandAsync(name, params);
    expect(result.error, result.summary).toBeUndefined();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === KERNEL_TRIANGLES)).toBe(true);
    // the document keeps its display level of detail
    expect(trianglesOf(getLiveDoc().entities['scan'] as Entity)).toBe(80);
  });

  it('the STEP of exportStepFile (the exact kernel path of GET /export/step and the export_step tool) is built from the stored mesh', async () => {
    const seen: number[] = [];
    setGeometryKernel(fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) }).kernel);
    // the host passes the context that holds the asset store, as the route and the export_step tool do
    const file = await exportStepFile(getLiveDoc, null, { save: false, context: serverContext() });
    expect('error' in file, JSON.stringify(file).slice(0, 200)).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === KERNEL_TRIANGLES)).toBe(true);
  });

  it('a stored mesh above the exact kernel limit is read in full and refused by name, the kernel never asked (the note counts the 327,680 stored triangles, not the 80 displayed)', async () => {
    _resetLiveDoc(scanDocument());
    const seen: number[] = [];
    setGeometryKernel(fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) }).kernel);
    for (const [name, params] of [
      ['export_step_ap242', { schema: 'ap242', includeValidationProperties: false }],
      ['export_iges', {}],
    ] as const) {
      const result = await applyCommandAsync(name, params);
      expect(result.error?.code, name).toBe('XCH_NO_SOLIDS');
      expect(result.summary).toContain('327680 triangles');
    }
    const file = await exportStepFile(getLiveDoc, null, { save: false, context: serverContext() });
    expect(file).toMatchObject({ error: expect.stringContaining('327680 triangles') });
    expect(seen).toEqual([]);
  });

  it('an asset this machine does not hold is MESH_ASSET_LOD_ONLY, in both exports, and the kernel is never asked', async () => {
    _resetLiveDoc(scanDocument({ held: false, claimed: TRIANGLES }));
    const seen: number[] = [];
    setGeometryKernel(fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) }).kernel);
    for (const [name, params] of [
      ['export_step_ap242', { schema: 'ap242', includeValidationProperties: false }],
      ['export_iges', {}],
    ] as const) {
      const result = await applyCommandAsync(name, params);
      expect(result.error?.code, name).toBe('MESH_ASSET_LOD_ONLY');
    }
    const file = await exportStepFile(getLiveDoc, null, { save: false, context: serverContext() });
    expect(file).toMatchObject({ error: expect.stringContaining('display level of detail') });
    expect(seen).toEqual([]);
  });

  it('a reach above the cap is MESH_ASSET_TOO_LARGE', async () => {
    _resetLiveDoc(scanDocument({ claimed: MESH_FULL_READ_TRIANGLE_CAP + 1 }));
    setGeometryKernel(fakeXdeKernel().kernel);
    expect((await applyCommandAsync('export_step_ap242', { schema: 'ap242', includeValidationProperties: false })).error?.code).toBe(
      'MESH_ASSET_TOO_LARGE',
    );
    expect((await applyCommandAsync('export_iges', {})).error?.code).toBe('MESH_ASSET_TOO_LARGE');
  });
});

describe('the FEA mesher (a host path without the choke point)', () => {
  /** The analysis of the stored part: material, idealization and a fixed face. */
  function analysisOf(doc: CadDocument): { doc: CadDocument; analysisId: string } {
    let next = execute(doc, 'create_material', { name: 'st', density: 0.0078 }).document;
    next = execute(next, 'assign_material', { materialName: 'st', entityIds: ['scan'] }).document;
    const created = execute(next, 'create_analysis', { name: 'a', analysisType: 'static' });
    const analysisId = created.affected[0] ?? '';
    next = execute(created.document, 'set_part_idealization', { analysisId, entityId: 'scan' }).document;
    next = execute(next, 'add_fea_constraint', {
      analysisId,
      name: 'fix',
      kind: 'fixed',
      target: { entityId: 'scan', facesNear: [[0, 0, 10]] },
    }).document;
    return { doc: next, analysisId };
  }

  async function meshWith(
    doc: CadDocument,
    kernel: ReturnType<typeof fakeXdeKernel>['kernel'] | null,
    midsurfaceSeen: number[] = [],
  ): Promise<{ parts: Record<string, unknown>[]; code: string | undefined }> {
    const { doc: analysed, analysisId } = analysisOf(doc);
    const requests: Record<string, unknown>[] = [];
    const host: FeaHost = {
      getDoc: () => analysed,
      applyCommand: () => ({ summary: 'recorded.', affected: [analysisId], isError: false }),
    };
    const store = createFeArtifactStore(mkdtempSync(path.join(tmpdir(), 'llull-host-fea-')));
    const result = await runFeaMesh(analysisId, host, {
      mesher: (request) => {
        requests.push(request);
        return Promise.resolve({ ok: true, nodes: [[1, 0, 0, 0]], blocks: [], nodeSets: {}, faceSets: {}, targets: {} });
      },
      store,
      hooks: {
        ...caeHooks,
        // shell and plane-stress parts are built from the geometry of the document the hook is given
        partMidsurface: (view, ...rest) => {
          midsurfaceSeen.push(trianglesOf(view.entities['scan'] as Entity));
          return caeHooks.partMidsurface(view, ...rest);
        },
      },
      kernel: () => kernel,
    });
    return {
      parts: (requests[0]?.['parts'] as Record<string, unknown>[] | undefined) ?? [],
      code: result.isError ? ((result.data as { code?: string } | undefined)?.code ?? result.summary) : undefined,
    };
  }

  it('hands the mesher the facets of the stored mesh (no kernel: the STL of the stored triangles), not the 80 of the display level of detail', async () => {
    const { parts, code } = await meshWith(scanDocument(), null);
    expect(code).toBeUndefined();
    const geometry = parts[0]?.['geometry'] as { kind: string; stlBase64: string };
    expect(geometry.kind).toBe('stl');
    expect(Buffer.from(geometry.stlBase64, 'base64').readUInt32LE(80)).toBe(TRIANGLES);
  });

  it('gives the shell and plane-stress idealisation the stored mesh too (partMidsurface), not the display level of detail', async () => {
    const seen: number[] = [];
    await meshWith(scanDocument(), null, seen);
    expect(seen).toEqual([TRIANGLES]);
  });

  it('builds the exact path (the kernel STEP) from the stored mesh too', async () => {
    const seen: number[] = [];
    const fake = fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) });
    const { parts } = await meshWith(
      scanDocument(),
      Object.assign(fake.kernel, { exportStep: () => 'ISO-10303-21;\nEND-ISO-10303-21;\n' }),
    );
    expect((parts[0]?.['geometry'] as { kind: string }).kind).toBe('step');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === TRIANGLES)).toBe(true);
  });

  it('refuses by name: an asset this machine does not hold, a reach above the cap; the mesher is never called', async () => {
    const lost = await meshWith(scanDocument({ held: false, claimed: TRIANGLES }), null);
    expect(lost.code).toBe('MESH_ASSET_LOD_ONLY');
    expect(lost.parts).toEqual([]);
    const big = await meshWith(scanDocument({ claimed: MESH_FULL_READ_TRIANGLE_CAP + 1 }), null);
    expect(big.code).toBe('MESH_ASSET_TOO_LARGE');
    expect(big.parts).toEqual([]);
  });
});

describe('the HTTP routes that run the STEP export (no Python: the exact kernel writes it)', () => {
  let app: import('express').Express;
  beforeAll(async () => {
    process.env['LLULL_PYTHON'] = 'off';
    ({ app } = await import('../src/index'));
  });

  it('GET /export/step and POST /exchange export_step hand the kernel the stored mesh, not the display level of detail', async () => {
    const { default: request } = await import('supertest');
    _resetLiveDoc(scanDocument({ stored: small }));
    const seen: number[] = [];
    setGeometryKernel(fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) }).kernel);
    const download = await request(app).get('/export/step?name=part');
    expect(download.status, download.text.slice(0, 200)).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === KERNEL_TRIANGLES)).toBe(true);
    // a fresh kernel: the first one keeps the shape it built
    seen.length = 0;
    setGeometryKernel(fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) }).kernel);
    const tool = await request(app).post('/exchange').send({ name: 'export_step', params: {} });
    expect(tool.status, JSON.stringify(tool.body).slice(0, 600)).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === KERNEL_TRIANGLES)).toBe(true);
  });

  it('an asset this machine does not hold is a named refusal on the route, not a STEP of the display mesh', async () => {
    const { default: request } = await import('supertest');
    _resetLiveDoc(scanDocument({ held: false, claimed: TRIANGLES }));
    const seen: number[] = [];
    setGeometryKernel(fakeXdeKernel({ onSolid: (entity) => void seen.push(trianglesOf(entity)) }).kernel);
    const download = await request(app).get('/export/step');
    expect(download.status).toBeGreaterThanOrEqual(500);
    expect(String(download.body.error)).toContain('display level of detail');
    expect(seen).toEqual([]);
  });
});
