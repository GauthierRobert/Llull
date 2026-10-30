/**
 * `fit_surface_to_mesh` with the harmonic map through the real host (DES-7c, TECHNICAL_SPEC 13.26): above the 25,000 triangles of the TypeScript engine the native `harmonic_map`
 * job answers (the event loop stays free, the job reports its stage), below them the result is the same surface bit for bit whichever engine ran, and without the native
 * engine the old refusal stands. The real binary; skipped with a logged reason when llull-compute is not built.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEntity } from '@core/commands/entity/newEntity';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { type CadDocument, createEmptyDocument, type NurbsSurfaceEntity } from '@core/model/types';
import { icosphere } from '../../tests/helpers/meshFixtures';
import { app } from '../src/index';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { _clearResultCache } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshFitHarmonicNativeHost: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

/** The upper hemisphere of an icosphere (a disk), as a mesh entity. */
function hemisphereDoc(level: number): { doc: CadDocument; triangles: number } {
  const sphere = icosphere(10, level);
  const indices: number[] = [];
  for (let t = 0; t < sphere.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => sphere.indices[t + k] as number);
    if (corners.every((v) => (sphere.positions[3 * v + 2] as number) > -1e-9)) indices.push(...corners);
  }
  const body = newEntity('mesh', 'cap', { mesh: { positions: sphere.positions, indices } }, [0, 0, 0], '#cccccc');
  return { doc: { ...createEmptyDocument(), units: 'mm', entities: { cap: body }, order: ['cap'] }, triangles: indices.length / 3 };
}

let server: Server;
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  void (server.address() as AddressInfo);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  _clearResultCache();
  _resetHistory();
});
afterEach(() => setMeshProcessingEngine(null));

const surfaceOf = (): NurbsSurfaceEntity =>
  Object.values(getLiveDoc().entities).find((e) => e.kind === 'nurbs_surface') as NurbsSurfaceEntity;
const fit = { id: 'cap', parameterization: 'harmonic', controlPoints: [6, 6] };

describe('fit_surface_to_mesh, harmonic, on regions past the TypeScript cap', () => {
  native(
    'a 41,000-triangle hemisphere is mapped by the native job: the stage is reported and the surface is made',
    async () => {
      const { doc, triangles } = hemisphereDoc(6);
      expect(triangles).toBeGreaterThan(25_000);
      _resetLiveDoc(doc);
      setMeshProcessingEngine(createNativeMeshEngine({ binary: BINARY as string }));
      const stages: string[] = [];
      const result = await applyCommandAsync('fit_surface_to_mesh', fit, {
        onProgress: (event) => void stages.push(`${event.op}:${event.stage}`),
      });
      expect(result.error, result.summary).toBeUndefined();
      expect(stages).toContain('harmonic_map:harmonic_map');
      expect((result.data as { parameterization: { method: string } }).parameterization.method).toBe('harmonic');
      expect(surfaceOf().surface.poles).toHaveLength(6);
    },
    240_000,
  );

  native(
    'a region the TypeScript engine can take gives the same surface bit for bit with or without the native engine',
    async () => {
      const { doc, triangles } = hemisphereDoc(5);
      expect(triangles).toBeLessThan(25_000);
      _resetLiveDoc(doc);
      setMeshProcessingEngine(null);
      expect((await applyCommandAsync('fit_surface_to_mesh', fit)).error).toBeUndefined();
      const withTs = JSON.stringify(surfaceOf().surface);
      _resetLiveDoc(doc);
      _resetHistory();
      _clearResultCache();
      setMeshProcessingEngine(createNativeMeshEngine({ binary: BINARY as string }));
      expect((await applyCommandAsync('fit_surface_to_mesh', fit)).error).toBeUndefined();
      expect(JSON.stringify(surfaceOf().surface)).toBe(withTs);
    },
    240_000,
  );

  it('without the native engine the old cap stands, named in the refusal', async () => {
    _resetLiveDoc(hemisphereDoc(6).doc);
    setMeshProcessingEngine(null);
    const refused = await applyCommandAsync('fit_surface_to_mesh', fit);
    expect(refused.error?.code).toBe('MESH_FIT_TOO_LARGE');
    expect(refused.summary).toContain('25000');
  });
});
