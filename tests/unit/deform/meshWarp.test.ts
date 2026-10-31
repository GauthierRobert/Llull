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

describe('warpMesh work bound (01 DEF 17.7)', () => {
  const refused = (node: ReturnType<typeof deformNode>, tolerance: number): { code: string; message: string; ms: number } => {
    const started = Date.now();
    const result = warpMesh(boxMesh(10, 10, 100), node, { tolerance });
    const ms = Date.now() - started;
    if (result.ok) throw new Error(`warped: ${result.mesh.indices.length / 3} triangles`);
    return { code: result.code, message: result.message, ms };
  };

  it('an honest map that needs more work than the bound is refused BEFORE the pass that would cross it, with the remedy, in seconds', () => {
    const node = deformNode({ kind: 'twist', angleRad: 3 * Math.PI }, { region: region(0, 100, 'linear') });
    const result = refused(node, 1e-4);
    expect(result.code).toBe('DEF_BUDGET_EXCEEDED');
    expect(result.message).toContain("output mode 'exact'");
    expect(result.ms).toBeLessThan(60_000);
  }, 120_000);

  it('a fold (a bend radius inside the body) is refused, not refined to the floor', () => {
    const node = deformNode({ kind: 'bend', radius: 3, symmetric: false }, { region: region(0, 100) });
    const result = refused(node, 1e-4);
    expect(['DEF_APPROX_TOLERANCE', 'DEF_BUDGET_EXCEEDED']).toContain(result.code);
    expect(result.ms).toBeLessThan(60_000);
  }, 120_000);

  it('a refusal is remembered for the same node and mesh (the host asks again to name it) and not for another mesh', () => {
    const node = deformNode({ kind: 'twist', angleRad: 3 * Math.PI }, { region: region(0, 100, 'linear') });
    const first = warpMesh(boxMesh(10, 10, 100), node, { tolerance: 1e-4 });
    const started = Date.now();
    const again = warpMesh(boxMesh(10, 10, 100), node, { tolerance: 1e-4 });
    expect(again).toBe(first);
    expect(Date.now() - started).toBeLessThan(50);
    expect(warpMesh(boxMesh(10, 10, 100), node, { tolerance: 1e-4, maxTriangles: 7 })).not.toBe(first);
  }, 120_000);
});

describe('warpMesh attributes (rest positions carried by the weld remap, never by coordinates)', () => {
  /** The box with its first corner duplicated: triangle 0 uses vertex 8, a copy of vertex 0 at the same position. */
  function boxWithTwin(): MeshData {
    const box = boxMesh(10, 10, 100);
    const indices = [...box.indices];
    indices[0] = 8;
    return { positions: [...box.positions, box.positions[0] as number, box.positions[1] as number, box.positions[2] as number], indices };
  }

  it('twin vertices with the same attribute weld into one that carries it: the attribute of every welded vertex is its own rest position', () => {
    const mesh = boxWithTwin();
    const node = deformNode({ kind: 'twist', angleRad: 0.5 }, { region: region(0, 100, 'linear') });
    const result = warpMesh(mesh, node, { tolerance: 0.01, attributes: [mesh.positions] });
    if (!result.ok) throw new Error(result.message);
    expect(result.attributes[0]).toEqual(result.restPositions);
  });

  it('twin vertices whose attributes differ (the inner map folded two rest points onto one position) are refused by name, not given the first one attribute', () => {
    const mesh = boxWithTwin();
    const moved = [...mesh.positions];
    moved[24] = 5;
    const node = deformNode({ kind: 'twist', angleRad: 0.5 }, { region: region(0, 100, 'linear') });
    const result = warpMesh(mesh, node, { tolerance: 0.01, attributes: [moved] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DEF_APPROX_TOLERANCE');
    expect(result.message).toContain('collapses distinct points');
  });
});
