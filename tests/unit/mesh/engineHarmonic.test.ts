/** The `harmonic_map` op of the mesh-processing port (TECHNICAL_SPEC 13.26): the TypeScript engine answers it, the region cut-out gives the map of the whole mesh bit for bit, the engines' caps route it. */

import { describe, expect, it } from 'vitest';
import { resolveMeshEngine } from '@core/geometry/mesh/engine';
import { MESH_TS_HARMONIC_CAP, isEngineFailure, type MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { harmonicMap } from '@core/geometry/mesh/harmonicMap';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { regionHarmonic } from '@core/commands/mesh/harmonicRegion';
import { gridMesh, icosphere } from '../../helpers/meshFixtures';

describe('harmonic_map in the TypeScript engine', () => {
  const grid = gridMesh(10, 10);

  it('answers the map of its whole input, ascending vertices with their (u, v), and lists the op with the 25,000 triangle cap', () => {
    const answer = tsMeshEngine.run({ mesh: grid }, { op: 'harmonic_map' });
    expect(isEngineFailure(answer)).toBe(false);
    const harmonic = isEngineFailure(answer) ? null : answer.harmonic;
    expect(harmonic?.vertices).toEqual(Array.from({ length: 121 }, (_, v) => v));
    expect(harmonic?.uv).toHaveLength(242);
    expect(harmonic).toMatchObject({ weights: 'cotangent', boundaryVertices: 40, interiorVertices: 81 });
    expect(tsMeshEngine.capabilities().get('harmonic_map')).toBe(MESH_TS_HARMONIC_CAP);
  });

  it('refuses with the codes of the map: a closed sphere, a starved budget', () => {
    expect(tsMeshEngine.run({ mesh: icosphere(10, 2) }, { op: 'harmonic_map' })).toMatchObject({ code: 'MESH_FIT_NOT_DISK' });
    expect(tsMeshEngine.run({ mesh: grid }, { op: 'harmonic_map', maxIterations: 1 })).toMatchObject({ code: 'MESH_FIT_PARAM_FOLDED' });
  });
});

describe('regionHarmonic', () => {
  it('cuts the region out and maps the vertex numbers back: the same map, bit for bit, as the map of the region inside the whole mesh', () => {
    const mesh = gridMesh(10, 12);
    // the cells with i, j in 3..8 of the 12 x 12 grid: 36 cells, 72 triangles
    const faces = Array.from({ length: mesh.indices.length / 3 }, (_, f) => f).filter((f) => {
      const cell = Math.floor(f / 2);
      const [i, j] = [cell % 12, Math.floor(cell / 12)];
      return i >= 3 && i < 9 && j >= 3 && j < 9;
    });
    const direct = harmonicMap(mesh, faces);
    const cut = regionHarmonic(tsMeshEngine, mesh, faces);
    if ('code' in direct || 'code' in cut) throw new Error('the region maps');
    expect(new Map([...cut.uv].sort((a, b) => a[0] - b[0]))).toEqual(new Map([...direct.uv].sort((a, b) => a[0] - b[0])));
    expect(cut.corners).toEqual(direct.corners);
    expect({ ...cut, uv: null }).toEqual({ ...direct, uv: null });
  });

  it('passes the refusals of the region and the failures of the engine on as they are', () => {
    const sphere = icosphere(10, 2);
    const all = Array.from({ length: sphere.indices.length / 3 }, (_, f) => f);
    expect(regionHarmonic(tsMeshEngine, sphere, all)).toMatchObject({ code: 'MESH_FIT_NOT_DISK' });
    const absent: MeshProcessingEngine = {
      name: 'absent',
      capabilities: () => new Map(),
      run: () => ({ code: 'MESH_ENGINE_UNSUPPORTED', message: 'x' }),
    };
    expect(regionHarmonic(absent, sphere, all)).toEqual({ code: 'MESH_ENGINE_UNSUPPORTED', message: 'x' });
    expect(resolveMeshEngine(absent).capabilities().get('harmonic_map')).toBe(MESH_TS_HARMONIC_CAP);
  });
});
