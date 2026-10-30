/**
 * The cap of `cut` in the TypeScript engine (DES-7c step 7 slice 4, TECHNICAL_SPEC 13.15.1): `cut` is one pass over the triangles and costs 1.3 s at
 * 1,310,720, so its cap is `MESH_TS_CUT_CAP` (4,000,000) instead of the 200,000 of the other editing ops (the command on a stored 327,680-triangle mesh is in `server/tests/meshCutNativeHost.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import { MESH_TS_CUT_CAP, MESH_TS_TRIANGLE_CAP, type MeshOp, type MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { icosphere } from '../../helpers/meshFixtures';

const cut: MeshOp = { op: 'cut', origin: [0, 0, 1], normal: [0, 0, 1], side: 1, cap: true, epsilon: 1e-11 };

describe('the TypeScript cap of cut', () => {
  it('is 4,000,000 for cut and stays 200,000 for every other editing op', () => {
    expect(MESH_TS_CUT_CAP).toBe(4_000_000);
    const caps = tsMeshEngine.capabilities();
    expect(caps.get('cut')).toBe(MESH_TS_CUT_CAP);
    for (const op of ['repair', 'fill_holes', 'decimate', 'remesh', 'smooth', 'deviation', 'segment', 'sculpt', 'analyze'] as const)
      expect(caps.get(op), op).toBe(MESH_TS_TRIANGLE_CAP);
  });

  it('refuses a cut above the cap by name, and answers one between 200,000 and the cap', () => {
    const composite = composeMeshEngines([tsMeshEngine]);
    const huge = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>((MESH_TS_CUT_CAP + 1) * 3).fill(0) };
    expect(composite.run({ mesh: huge }, cut)).toMatchObject({ code: 'MESH_ENGINE_CAP_EXCEEDED' });
    const sphere = icosphere(10, 7);
    expect(sphere.indices.length / 3).toBeGreaterThan(MESH_TS_TRIANGLE_CAP);
    const half = composite.run({ mesh: sphere }, cut);
    expect(half).toMatchObject({ report: { loops: 1, uncapped: 0 } });
    expect((half as MeshOpResult).report['capTriangles']).toBeGreaterThan(1000);
  });
});
