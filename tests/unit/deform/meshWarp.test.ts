import { describe, expect, it } from 'vitest';
import { estimateWarp, warpMesh } from '@core/geometry/deform/meshWarp';
import { predictedVolume } from '@core/geometry/deform/predictedVolume';
import { isClosedMesh } from '@core/geometry/meshClosure';
import { signedMeshVolume } from '@core/geometry/meshVolume';
import { findSelfIntersections } from '@core/geometry/mesh/selfIntersection';
import { weldMesh } from '@core/geometry/mesh/weld';
import type { DeformLaw } from '@core/model/deform';
import type { MeshData } from '@core/model/types';
import { WORLD_FRAME, deformNode, region } from './nodes';

/** Closed, outward-wound box with 8 shared vertices and 12 triangles, x/y in ±w/2, z in [0, h]. */
function boxMesh(w: number, d: number, h: number): MeshData {
  const [x, y] = [w / 2, d / 2];
  const positions = [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0, -x, -y, h, x, -y, h, x, y, h, -x, y, h];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions, indices };
}

const volume = (mesh: MeshData): number => signedMeshVolume(mesh.positions, mesh.indices);

describe('warpMesh', () => {
  it('keeps the mesh closed and outward, with the chordal deviation within tolerance', () => {
    const node = deformNode({ kind: 'twist', angleRad: Math.PI / 2 }, { region: region(0, 100, 'linear') });
    const result = warpMesh(boxMesh(10, 10, 100), node, { tolerance: 0.01 });
    if (!result.ok) throw new Error(result.message);
    expect(isClosedMesh(result.mesh)).toBe(true);
    expect(volume(result.mesh)).toBeCloseTo(10000, -1);
    expect(volume(result.mesh)).toBeGreaterThan(0);
    expect(result.maxChordError).toBeLessThanOrEqual(0.01);
    expect(result.sourceTriangles).toBe(12);
    expect(result.mesh.indices.length / 3).toBeGreaterThan(12);
    const welded = weldMesh(result.mesh, 1e-7);
    expect(findSelfIntersections(welded.positions, welded.triangles, 1).count).toBe(0);
  });

  it('is deterministic', () => {
    const node = deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region: region(0, 78.5) });
    const [first, second] = [
      warpMesh(boxMesh(10, 10, 78.5), node, { tolerance: 0.01 }),
      warpMesh(boxMesh(10, 10, 78.5), node, { tolerance: 0.01 }),
    ];
    expect(first).toEqual(second);
  });

  it('cuts edges at the region ends of a kinked law so no triangle straddles the kink', () => {
    const node = deformNode({ kind: 'stretch', factor: 1.5 }, { region: region(20, 60, 'none') });
    const result = warpMesh(boxMesh(10, 10, 100), node, { tolerance: 0.01 });
    if (!result.ok) throw new Error(result.message);
    const heights = new Set<number>();
    for (let v = 0; v < result.mesh.positions.length / 3; v++)
      heights.add(Math.round((result.mesh.positions[v * 3 + 2] as number) * 1e6) / 1e6);
    expect(heights).toContain(20);
    expect(heights).toContain(80);
    expect(volume(result.mesh)).toBeCloseTo(12000, 6);
  });

  it('an orientation-reversing affine map flips the winding so the volume stays positive', () => {
    const mirror: DeformLaw = {
      kind: 'affine',
      matrix: [
        [-1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      translation: [0, 0, 0],
    };
    const result = warpMesh(boxMesh(10, 20, 30), deformNode(mirror), { tolerance: 0.01 });
    if (!result.ok) throw new Error(result.message);
    expect(volume(result.mesh)).toBeCloseTo(6000, 9);
    expect(result.edgeLength).toBe(Infinity);
    expect(result.mesh.indices.length).toBe(36);
  });

  it('refuses a degenerate frame and an over-budget refinement with stable codes', () => {
    const bad = warpMesh(
      boxMesh(1, 1, 1),
      deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 1), frame: { ...WORLD_FRAME, axis: [0, 0, 0] } }),
      { tolerance: 0.01 },
    );
    expect(bad).toMatchObject({ ok: false, code: 'DEF_FRAME_DEGENERATE' });
    const node = deformNode({ kind: 'twist', angleRad: Math.PI * 20 }, { region: region(0, 100, 'linear') });
    const estimate = estimateWarp(boxMesh(10, 10, 100), node, 1e-6);
    expect(estimate?.triangles).toBeGreaterThan(4_000_000);
    expect(warpMesh(boxMesh(10, 10, 100), node, { tolerance: 1e-6 })).toMatchObject({ ok: false, code: 'DEF_BUDGET_EXCEEDED' });
    const capped = warpMesh(
      boxMesh(10, 10, 100),
      deformNode({ kind: 'twist', angleRad: Math.PI * 2 }, { region: region(0, 100, 'linear') }),
      { tolerance: 0.001, maxTriangles: 5000 },
    );
    expect(capped).toMatchObject({ ok: false, code: 'DEF_BUDGET_EXCEEDED' });
    expect(
      estimateWarp(
        boxMesh(1, 1, 1),
        deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 1), frame: { ...WORLD_FRAME, axis: [0, 0, 0] } }),
        0.01,
      ),
    ).toBeNull();
  });

  it('estimates only the triangles that meet the region', () => {
    const whole = estimateWarp(boxMesh(10, 10, 100), deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 100) }), 0.001);
    const outside = estimateWarp(boxMesh(10, 10, 100), deformNode({ kind: 'twist', angleRad: 1 }, { region: region(500, 600) }), 0.001);
    expect(outside?.triangles).toBe(12);
    expect(whole?.triangles).toBeGreaterThan(12);
  });
});

describe('predictedVolume (independent of the deformed surface)', () => {
  const bar = boxMesh(10, 10, 100);
  it('twist keeps the volume, stretch adds the stretched slab, affine multiplies by |det|', () => {
    const twist = predictedVolume(bar, deformNode({ kind: 'twist', angleRad: 3 }, { region: region(0, 100) }));
    expect(twist?.predicted).toBeCloseTo(10000, 8);
    const stretch = predictedVolume(bar, deformNode({ kind: 'stretch', factor: 1.5 }, { region: region(20, 60, 'none') }));
    expect(stretch?.predicted).toBeCloseTo(12000, 6);
    const affine = predictedVolume(
      bar,
      deformNode({
        kind: 'affine',
        matrix: [
          [-1, 0, 0],
          [0, 2, 0],
          [0, 0, 3],
        ],
        translation: [0, 0, 0],
      }),
    );
    expect(affine?.predicted).toBeCloseTo(60000, 6);
  });
  it('taper integrates s(z)^2 and bend (R - y)/R over the cross-sections', () => {
    const taper = predictedVolume(bar, deformNode({ kind: 'taper', scaleEnd: 0.5, flat: false }, { region: region(0, 100, 'smooth') }));
    expect(taper?.predicted).toBeCloseTo(5928.571428, 3);
    const offset = predictedVolume(
      boxMesh(10, 10, 78.5398163397),
      deformNode(
        { kind: 'bend', radius: 50, symmetric: false },
        { region: region(0, 78.5398163397), frame: { ...WORLD_FRAME, origin: [0, -5, 0] } },
      ),
    );
    expect(offset?.predicted).toBeCloseTo(7068.58347, 2);
  });
  it('is null for a degenerate frame, an empty mesh or a region-less non-affine law', () => {
    const law: DeformLaw = { kind: 'twist', angleRad: 1 };
    expect(predictedVolume(bar, deformNode(law, { region: region(0, 1), frame: { ...WORLD_FRAME, axis: [0, 0, 0] } }))).toBeNull();
    expect(predictedVolume({ positions: [], indices: [] }, deformNode(law, { region: region(0, 1) }))).toBeNull();
    expect(predictedVolume(bar, deformNode(law))).toBeNull();
  });
  it('handles meshes of more than 200000 vertices (no argument-spread limits)', () => {
    const triangles = 70_000;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let t = 0; t < triangles; t++) {
      const z = (t / triangles) * 100;
      positions.push(0, 0, z, 1, 0, z, 0, 1, z + 0.001);
      indices.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    const result = predictedVolume({ positions, indices }, deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 100) }));
    expect(result).not.toBeNull();
    expect(Number.isFinite(result?.predicted)).toBe(true);
  });
  it('winding does not matter', () => {
    const reversed = { positions: bar.positions, indices: [...bar.indices].reverse() };
    expect(predictedVolume(reversed, deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 100) }))?.predicted).toBeCloseTo(
      10000,
      8,
    );
  });
});
