/** 07 MSH M0: the pure mesh library (weld, topology, analysis, hull, subdivision, field) against the validation pack. */

import { describe, expect, it } from 'vitest';
import { analyzeIndexedMesh } from '@core/geometry/mesh/analysis';
import { MeshField } from '@core/geometry/mesh/field';
import { convexHull } from '@core/geometry/mesh/hull';
import { findSelfIntersections } from '@core/geometry/mesh/selfIntersection';
import { subdivideMesh } from '@core/geometry/mesh/subdivide';
import { minimumWallThickness } from '@core/geometry/mesh/wallThickness';
import { weldMesh } from '@core/geometry/mesh/weld';
import { cuboid, gridMesh, icosahedron, icosphere, packJson, relativeError, torus } from '../../helpers/meshFixtures';

const analyze = (mesh: { positions: number[]; indices: number[] }, selfIntersections = false): ReturnType<typeof analyzeIndexedMesh> =>
  analyzeIndexedMesh(mesh.positions, mesh.indices, { selfIntersections, maxListed: 20 });

describe('analysis (VC-MSH-01, 02)', () => {
  it('reproduces the icosphere convergence table (area and volume, 1e-9 relative)', () => {
    const table = packJson('icosphere_convergence.json') as {
      levels?: Array<{ level: number; faces: number; area: number; volume: number }>;
    };
    const rows = table.levels ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows.filter((r) => r.level <= 4)) {
      const analysis = analyze(icosphere(10, row.level));
      expect(analysis.faces).toBe(row.faces);
      expect(relativeError(analysis.area, row.area)).toBeLessThan(1e-9);
      expect(relativeError(analysis.volume as number, row.volume)).toBeLessThan(1e-9);
    }
  });

  it('gives chi 2 / genus 0 for the icosphere, chi 0 / genus 1 for the torus, one 48-edge loop for the upper half', () => {
    const sphere = analyze(icosphere(10, 3));
    expect([sphere.vertices, sphere.faces, sphere.eulerCharacteristic, sphere.genus, sphere.boundaryLoopCount, sphere.closed]).toEqual([
      642,
      1280,
      2,
      0,
      0,
      true,
    ]);
    const ring = analyze(torus(5, 2, 32, 16));
    expect([ring.vertices, ring.faces, ring.eulerCharacteristic, ring.genus, ring.closed]).toEqual([512, 1024, 0, 1, true]);
    expect(relativeError(ring.volume as number, 382.248110338)).toBeLessThan(1e-9);
    expect(relativeError(ring.area, 390.680247285)).toBeLessThan(1e-9);
    const full = icosphere(10, 3);
    const keep: number[] = [];
    for (let f = 0; f < full.indices.length; f += 3) {
      const z = [0, 1, 2].reduce((sum, k) => sum + (full.positions[(full.indices[f + k] as number) * 3 + 2] as number), 0) / 3;
      if (z > 0) keep.push(full.indices[f] as number, full.indices[f + 1] as number, full.indices[f + 2] as number);
    }
    const upper = analyze({ positions: full.positions, indices: keep });
    expect([upper.faces, upper.boundaryEdges, upper.boundaryLoopCount, upper.closed]).toEqual([624, 48, 1, false]);
    expect(upper.boundaryLoops[0]?.edges).toBe(48);
  });

  it('reports degenerate and duplicate faces, non-manifold edges, shells and inconsistent orientation', () => {
    const box = cuboid([0, 0, 0], [1, 1, 1]);
    const second = cuboid([5, 5, 5], [6, 6, 6]);
    const shifted = second.indices.map((i) => i + 8);
    const two = analyze({ positions: [...box.positions, ...second.positions], indices: [...box.indices, ...shifted] });
    expect(two.shellCount).toBe(2);
    expect(two.volume).toBeCloseTo(2, 12);
    expect(two.genus).toBe(0);
    const flipped = [...box.indices];
    [flipped[1], flipped[2]] = [flipped[2] as number, flipped[1] as number];
    expect(analyze({ positions: box.positions, indices: flipped }).orientationConsistent).toBe(false);
    const extra = analyze({ positions: box.positions, indices: [...box.indices, 0, 2, 3, 0, 0, 1] });
    expect(extra.duplicateFaces).toBe(1);
    expect(extra.degenerateFaces).toBe(1);
    expect(extra.nonManifoldEdgeCount).toBeGreaterThan(0);
    expect(extra.closed).toBe(false);
  });

  it('computes quality statistics and centroid', () => {
    const analysis = analyze(cuboid([0, 0, 0], [2, 2, 2]));
    expect(analysis.centroid?.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 1, 1]);
    expect(analysis.minAngleDeg).toBeCloseTo(45, 9);
    expect(analysis.aspectRatio.max).toBeGreaterThan(1);
    expect(analysis.edgeLength.max).toBeCloseTo(Math.hypot(2, 2), 12);
  });
});

describe('weld', () => {
  it('merges coincident corners in first-use order and drops unreferenced vertices', () => {
    const soupMesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 9, 9, 9], indices: [0, 1, 2, 3, 4, 5] };
    const welded = weldMesh(soupMesh, 1e-9);
    expect(welded.positions).toHaveLength(12);
    expect(welded.triangles).toEqual([0, 1, 2, 1, 3, 2]);
    expect(welded.mergedVertices).toBe(2);
    expect(weldMesh(soupMesh, 0).positions).toHaveLength(12);
    const near = weldMesh({ positions: [0, 0, 0, 1e-7, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 2, 3, 1, 2, 3] }, 1e-6);
    expect(near.positions).toHaveLength(9);
  });
});

describe('self intersections', () => {
  it('counts crossing triangle pairs of two interpenetrating cubes and none for disjoint ones', () => {
    const a = cuboid([0, 0, 0], [2, 2, 2]);
    const b = cuboid([0.9, 1.1, 0.7], [2.9, 3.1, 2.7]);
    const both = { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((i) => i + 8)] };
    const crossing = findSelfIntersections(both.positions, both.indices, 3);
    expect(crossing.count).toBeGreaterThan(0);
    expect(crossing.pairs.length).toBeLessThanOrEqual(3);
    const far = cuboid([10, 10, 10], [11, 11, 11]);
    const apart = { positions: [...a.positions, ...far.positions], indices: [...a.indices, ...far.indices.map((i) => i + 8)] };
    expect(findSelfIntersections(apart.positions, apart.indices, 3).count).toBe(0);
    expect(findSelfIntersections(a.positions, a.indices, 3).count).toBe(0);
  });
});

describe('convex hull (VC-MSH-11)', () => {
  it('hulls the cube corners with interior points to 8 vertices and 12 triangles of volume 1000', () => {
    const corners = cuboid([0, 0, 0], [10, 10, 10]).positions;
    const hull = convexHull([...corners, 5, 5, 5, 2, 7, 3]);
    expect(hull).not.toBeNull();
    const analysis = analyze({ positions: hull?.positions ?? [], indices: hull?.triangles ?? [] });
    expect([analysis.vertices, analysis.faces, analysis.closed]).toEqual([8, 12, true]);
    expect(relativeError(analysis.volume as number, 1000)).toBeLessThan(1e-12);
    expect(relativeError(analysis.area, 600)).toBeLessThan(1e-12);
  });

  it('hulls the icosahedron vertices and a torus within the stated bound', () => {
    const ico = icosahedron();
    const hull = convexHull(ico.positions);
    const analysis = analyze({ positions: hull?.positions ?? [], indices: hull?.triangles ?? [] });
    expect([analysis.vertices, analysis.faces]).toEqual([12, 20]);
    expect(relativeError(analysis.volume as number, 17.453559925)).toBeLessThan(1e-9);
    expect(relativeError(analysis.area, 34.6410161514)).toBeLessThan(1e-9);
    const ring = torus(5, 2, 64, 32);
    const ringHull = convexHull(ring.positions);
    const ringVolume = analyze({ positions: ringHull?.positions ?? [], indices: ringHull?.triangles ?? [] }).volume as number;
    expect(ringVolume).toBeLessThanOrEqual(545.061675019);
    expect(relativeError(ringVolume, 545.061675019)).toBeLessThan(0.016);
  });

  it('returns null for fewer than 4 points, collinear or coplanar points', () => {
    expect(convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0])).toBeNull();
    expect(convexHull([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0])).toBeNull();
    expect(convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])).toBeNull();
    expect(convexHull([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toBeNull();
  });
});

describe('subdivision (VC-MSH-36)', () => {
  it('midpoint subdivision of the icosahedron keeps area and volume with 80 faces', () => {
    const ico = icosahedron();
    const result = subdivideMesh({ positions: ico.positions, triangles: ico.indices }, 'midpoint', 1);
    const analysis = analyze({ positions: result.positions, indices: result.triangles });
    expect(analysis.faces).toBe(80);
    expect(relativeError(analysis.area, 34.6410161514)).toBeLessThan(1e-12);
    expect(relativeError(analysis.volume as number, 17.453559925)).toBeLessThan(1e-12);
  });

  it('Loop subdivision stays closed with 4x faces and shrinks a convex body; open meshes keep their boundary', () => {
    const ico = icosahedron();
    const loop = subdivideMesh({ positions: ico.positions, triangles: ico.indices }, 'loop', 2);
    const analysis = analyze({ positions: loop.positions, indices: loop.triangles });
    expect([analysis.faces, analysis.closed]).toEqual([320, true]);
    expect(analysis.volume as number).toBeLessThan(17.453559925);
    const sheet = gridMesh(4, 4);
    const refined = subdivideMesh({ positions: sheet.positions, triangles: sheet.indices }, 'loop', 1);
    const sheetAnalysis = analyze({ positions: refined.positions, indices: refined.triangles });
    expect([sheetAnalysis.faces, sheetAnalysis.boundaryLoopCount]).toEqual([128, 1]);
    expect(sheetAnalysis.area).toBeLessThan(16);
    expect(sheetAnalysis.area).toBeGreaterThan(15);
  });
});

describe('mesh field', () => {
  const sphere = icosphere(10, 3);
  const field = new MeshField(sphere.positions, sphere.indices);

  it('signs points by the winding number and measures distance to the surface', () => {
    expect(field.winding([0, 0, 0])).toBeCloseTo(1, 1);
    expect(field.winding([30, 0, 0])).toBeCloseTo(0, 1);
    expect(field.signedDistance([0, 0, 0])).toBeCloseTo(-9.9, 0);
    expect(field.signedDistance([13, 0, 0])).toBeGreaterThan(2.9);
    expect(field.signedDistance([13, 0, 0])).toBeLessThan(3.1);
    expect(new MeshField([], []).distance([0, 0, 0])).toBe(Infinity);
  });

  it('classifies overlapping soups by winding number above 1/2', () => {
    const a = icosphere(10, 3);
    const b = icosphere(10, 3, [10, 0, 0]);
    const merged = new MeshField([...a.positions, ...b.positions], [...a.indices, ...b.indices.map((i) => i + a.positions.length / 3)]);
    expect(merged.winding([5, 0, 0])).toBeGreaterThan(1.5);
    expect(merged.signedDistance([5, 0, 0])).toBeLessThan(0);
    expect(merged.signedDistance([25, 0, 0])).toBeGreaterThan(0);
  });
});

describe('wall thickness (VC-MSH-28)', () => {
  it('finds 0.4 for a thin slab and the diameter for a solid sphere', () => {
    expect(minimumWallThickness(cuboid([0, 0, 0], [10, 10, 0.4])).min).toBeCloseTo(0.4, 9);
    expect(minimumWallThickness({ positions: [], indices: [] }).samples).toBe(0);
    const thick = minimumWallThickness(icosphere(10, 2));
    expect(thick.min).toBeGreaterThan(17);
  });
});
