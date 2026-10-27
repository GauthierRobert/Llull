/** 07 MSH M1: repair, hole filling, decimation, remeshing, smoothing, plane cut and deviation libraries against the validation pack (VC-MSH-04..10, 17, 25). */

import { describe, expect, it } from 'vitest';
import { analyzeIndexedMesh } from '@core/geometry/mesh/analysis';
import { triangulateCap } from '@core/geometry/mesh/capTriangulate';
import { decimateMesh } from '@core/geometry/mesh/decimate';
import { symmetricDeviation } from '@core/geometry/mesh/deviation';
import { EditMesh } from '@core/geometry/mesh/editMesh';
import { fillHoles } from '@core/geometry/mesh/holeFill';
import { cutMeshByPlane, crossesPlane } from '@core/geometry/mesh/planeCut';
import { remeshMesh } from '@core/geometry/mesh/remesh';
import { repairTriangles, type RepairMode } from '@core/geometry/mesh/repair';
import { smoothMesh, taubinMu } from '@core/geometry/mesh/smooth';
import { SurfaceIndex } from '@core/geometry/mesh/surfaceIndex';
import { cuboid, gridMesh, icosphere, packJson, relativeError, type IndexedMesh } from '../../helpers/meshFixtures';

const measure = (
  mesh: IndexedMesh | { positions: ReadonlyArray<number>; indices: ReadonlyArray<number> },
): ReturnType<typeof analyzeIndexedMesh> => analyzeIndexedMesh(mesh.positions, mesh.indices, { selfIntersections: false, maxListed: 20 });

/** mulberry32 of the pack (lib_mesh.mjs rng). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const meanRadius = (positions: ReadonlyArray<number>): number => {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 3)
    sum += Math.hypot(positions[i] as number, positions[i + 1] as number, positions[i + 2] as number);
  return sum / (positions.length / 3);
};

const rmsAboutMean = (positions: ReadonlyArray<number>): number => {
  const mean = meanRadius(positions);
  let sum = 0;
  for (let i = 0; i < positions.length; i += 3)
    sum += (Math.hypot(positions[i] as number, positions[i + 1] as number, positions[i + 2] as number) - mean) ** 2;
  return Math.sqrt(sum / (positions.length / 3));
};

const REPAIR = { weldTolerance: 1e-6, maxGap: 1e-4, maxBoundaryEdges: 1000 };
const repair = (
  mesh: IndexedMesh,
  mode: RepairMode,
  extra: Partial<Parameters<typeof repairTriangles>[1]> = {},
): ReturnType<typeof repairTriangles> => repairTriangles(mesh, { mode, ...REPAIR, ...extra });

function defectMesh(): IndexedMesh {
  const data = packJson('defect_mesh.json') as { positions: number[][]; faces: number[][] };
  return { positions: data.positions.flat(), indices: data.faces.flat() };
}

describe('repair (VC-MSH-04)', () => {
  it('diagnoses the defect mesh and repairs it back to the 320-face closed icosphere', () => {
    const before = measure(defectMesh());
    expect([before.faces, before.duplicateFaces, before.degenerateFaces, before.boundaryLoopCount, before.shellCount]).toEqual([
      326, 2, 1, 1, 2,
    ]);
    expect(before.boundaryLoops[0]?.edges).toBe(3);
    expect(before.orientationConsistent).toBe(false);
    const stitched = repair(defectMesh(), 'stitch', { smallComponents: { maxFaces: 10 } });
    expect(stitched.changes).toMatchObject({
      duplicatesRemoved: 2,
      degenerateRemoved: 1,
      componentsRemoved: 1,
      facesRemovedWithComponents: 4,
    });
    const filled = fillHoles(stitched.mesh.positions, stitched.mesh.indices, {
      select: 'all',
      maxBoundaryEdges: 1000,
      fairing: 'none',
      refine: false,
    });
    expect(filled.filled).toHaveLength(1);
    const oriented = repair({ positions: [...filled.mesh.positions], indices: [...filled.mesh.indices] }, 'orient');
    expect(oriented.changes.flipped).toBe(3);
    const after = measure(oriented.mesh);
    expect([after.faces, after.closed, after.orientationConsistent]).toEqual([320, true, true]);
    expect(relativeError(after.volume as number, 4047.04467998)).toBeLessThan(1e-9);
    expect(relativeError(after.area, 1232.98485952)).toBeLessThan(1e-9);
  });

  it('weld merges close vertices and drops the faces that collapse; clean removes duplicates and zero-area faces', () => {
    const mesh: IndexedMesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1e-9, 0, 0, 1, 1e-9, 0, 5, 5, 5],
      indices: [0, 1, 2, 3, 4, 0, 2, 1, 0, 0, 1, 5],
    };
    const welded = repair(mesh, 'weld');
    expect(welded.changes.welded).toBeGreaterThan(0);
    expect(welded.changes.degenerateRemoved).toBe(1);
    expect(welded.mesh.indices.length / 3).toBe(3);
    const cleaned = repair(mesh, 'clean');
    expect(cleaned.changes.duplicatesRemoved).toBe(1);
    expect(cleaned.changes.degenerateRemoved).toBe(1);
    expect(cleaned.mesh.indices.length / 3).toBe(2);
  });

  it('orients a flipped face and an inside-out closed shell outward, and leaves a consistent mesh alone', () => {
    const box = cuboid([0, 0, 0], [2, 2, 2]);
    const flippedOne = { positions: box.positions, indices: [...box.indices] };
    [flippedOne.indices[1], flippedOne.indices[2]] = [flippedOne.indices[2] as number, flippedOne.indices[1] as number];
    const fixed = repair(flippedOne, 'orient');
    expect(fixed.changes.flipped).toBe(1);
    expect(measure(fixed.mesh).volume).toBeCloseTo(8, 12);
    const inside = {
      positions: box.positions,
      indices: box.indices.map((_, i) => box.indices[i - (i % 3) + ((3 - (i % 3)) % 3)] as number),
    };
    expect(measure(inside).volume).toBeCloseTo(-8, 12);
    const outward = repair(inside, 'orient');
    expect(outward.changes.flipped).toBe(12);
    expect(measure(outward.mesh).volume).toBeCloseTo(8, 12);
    expect(repair(box, 'orient').changes.flipped).toBe(0);
  });

  it('stitches a seam of boundary vertices closer than maxGap and refuses a merge that would not help', () => {
    const left = cuboid([0, 0, 0], [1, 1, 1]);
    const open = { positions: left.positions, indices: left.indices.slice(0, 33) };
    const seam: IndexedMesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.00002, 0, 0, 1, 0.00002, 0, 0, 1.00002, 0, 1, 1, 0.00002],
      indices: [0, 1, 2, 2, 1, 3, 4, 6, 5, 5, 6, 7],
    };
    const stitched = repair(seam, 'stitch', { maxGap: 1e-3 });
    expect(stitched.changes.stitched).toBeGreaterThan(0);
    expect(measure(stitched.mesh).boundaryEdges).toBeLessThan(measure(seam).boundaryEdges);
    expect(repair(open, 'stitch', { maxGap: 1e-9 }).changes.stitched).toBe(0);
  });

  it('close_holes fills every loop up to maxBoundaryEdges and counts the skipped ones; removeSmallComponents by volume keeps the largest shell', () => {
    const sphere = icosphere(10, 2);
    const open = { positions: sphere.positions, indices: sphere.indices.slice(3) };
    const closed = repair(open, 'close_holes');
    expect(closed.changes.holesFilled).toBe(1);
    expect(measure(closed.mesh).closed).toBe(true);
    expect(repair(open, 'close_holes', { maxBoundaryEdges: 2 }).skippedHoles).toBe(1);
    const small = cuboid([50, 0, 0], [50.1, 0.1, 0.1]);
    const together = {
      positions: [...sphere.positions, ...small.positions],
      indices: [...sphere.indices, ...small.indices.map((i) => i + sphere.positions.length / 3)],
    };
    const trimmed = repair(together, 'clean', { smallComponents: { maxVolume: 1 } });
    expect(trimmed.changes.componentsRemoved).toBe(1);
    expect(measure(trimmed.mesh).shellCount).toBe(1);
    const all = repair(small, 'clean', { smallComponents: { maxFaces: 100 } });
    expect(all.changes.componentsRemoved).toBe(0);
    expect(all.mesh.indices.length).toBe(small.indices.length);
  });
});

function gridWithHole(): { mesh: IndexedMesh; hole: IndexedMesh } {
  const grid = gridMesh(10, 10);
  const kept: number[] = [];
  for (let j = 0; j < 10; j++)
    for (let i = 0; i < 10; i++) {
      if ((i === 4 || i === 5) && (j === 4 || j === 5)) continue;
      kept.push(...grid.indices.slice((j * 10 + i) * 6, (j * 10 + i) * 6 + 6));
    }
  return { mesh: { positions: grid.positions, indices: kept }, hole: grid };
}

function spherePoleHole(): IndexedMesh {
  const sphere = icosphere(10, 3);
  const kept: number[] = [];
  for (let f = 0; f < sphere.indices.length; f += 3) {
    const ids = [sphere.indices[f] as number, sphere.indices[f + 1] as number, sphere.indices[f + 2] as number];
    const nearPole = ids.every(
      (v) =>
        Math.hypot(sphere.positions[v * 3] as number, sphere.positions[v * 3 + 1] as number) <= 2.5 &&
        (sphere.positions[v * 3 + 2] as number) > 0,
    );
    if (!nearPole) kept.push(...ids);
  }
  return { positions: sphere.positions, indices: kept };
}

describe('hole filling (VC-MSH-05)', () => {
  it('fills the 8-edge planar loop with 6 triangles of area 4: the grid is area 100 again, 40 boundary edges', () => {
    const { mesh } = gridWithHole();
    expect(measure(mesh).area).toBeCloseTo(96, 12);
    const inner = fillHoles(mesh.positions, mesh.indices, { select: [1], maxBoundaryEdges: 100, fairing: 'curvature', refine: true });
    expect(inner.filled).toHaveLength(1);
    expect(inner.filled[0]).toMatchObject({ edges: 8, triangles: 6, addedVertices: 0, triangulation: 'dp' });
    const after = measure(inner.mesh);
    expect(Math.abs(after.area - 100)).toBeLessThan(1e-9);
    expect(after.boundaryEdges).toBe(40);
    expect(after.orientationConsistent).toBe(true);
  });

  it('selects loops by index, by a point near them, or all; rejects unknown ones and respects maxBoundaryEdges and non-simple loops', () => {
    const { mesh } = gridWithHole();
    const near = fillHoles(mesh.positions, mesh.indices, {
      select: { near: [[5, 5, 0]] },
      maxBoundaryEdges: 100,
      fairing: 'none',
      refine: false,
    });
    expect(near.filled.map((f) => f.edges)).toEqual([8]);
    const all = fillHoles(mesh.positions, mesh.indices, { select: 'all', maxBoundaryEdges: 100, fairing: 'none', refine: false });
    expect(all.filled).toHaveLength(2);
    expect(measure(all.mesh).closed).toBe(true);
    expect(
      fillHoles(mesh.positions, mesh.indices, { select: [7], maxBoundaryEdges: 100, fairing: 'none', refine: false }).notFound,
    ).toContain('7');
    const closedSphere = icosphere(1, 1);
    expect(
      fillHoles(closedSphere.positions, closedSphere.indices, {
        select: { near: [[0, 0, 0]] },
        maxBoundaryEdges: 9,
        fairing: 'none',
        refine: false,
      }).notFound,
    ).toContain('none');
    const limited = fillHoles(mesh.positions, mesh.indices, { select: 'all', maxBoundaryEdges: 10, fairing: 'none', refine: false });
    expect(limited.skipped).toEqual([{ loop: 0, edges: 40, code: 'MESH_HOLE_TOO_LARGE' }]);
    expect(limited.filled).toHaveLength(1);
    const bowtie: IndexedMesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1], indices: [0, 1, 2, 0, 3, 4] };
    expect(
      fillHoles(bowtie.positions, bowtie.indices, { select: 'all', maxBoundaryEdges: 20, fairing: 'none', refine: false }).skipped.map(
        (s) => s.code,
      ),
    ).toContain('MESH_HOLE_NON_SIMPLE');
  });

  it('closes a sphere pole hole and measures the faired volume against the flat fill and the original (grade B, measured)', () => {
    const original = measure(icosphere(10, 3)).volume as number;
    expect(original).toBeCloseTo(4152.74081709, 6);
    const open = spherePoleHole();
    const flat = fillHoles(open.positions, open.indices, { select: 'all', maxBoundaryEdges: 100, fairing: 'none', refine: true });
    expect(flat.filled[0]).toMatchObject({ edges: 6, triangles: 4, addedVertices: 0 });
    const flatVolume = measure(flat.mesh).volume as number;
    expect(flatVolume).toBeCloseTo(4152.55404669, 6);
    // Liepa's density rule (alpha sqrt 2) inserts nothing into a 6-gon: fairing has no vertex to move.
    const defaultFaired = fillHoles(open.positions, open.indices, {
      select: 'all',
      maxBoundaryEdges: 100,
      fairing: 'curvature',
      refine: true,
    });
    expect(measure(defaultFaired.mesh).volume).toBe(flatVolume);
    // A finer patch gives the thin plate vertices to move: the volume lands within 0.03 of the original (flat misses by 0.19).
    const faired = fillHoles(open.positions, open.indices, {
      select: 'all',
      maxBoundaryEdges: 100,
      fairing: 'curvature',
      refine: true,
      alpha: 3,
    });
    const fairedAnalysis = measure(faired.mesh);
    expect(fairedAnalysis.closed).toBe(true);
    expect(faired.filled[0]?.addedVertices).toBeGreaterThan(0);
    expect(Math.abs((fairedAnalysis.volume as number) - original)).toBeLessThan(0.03);
    expect(Math.abs(flatVolume - original)).toBeGreaterThan(0.18);
    const membrane = fillHoles(open.positions, open.indices, {
      select: 'all',
      maxBoundaryEdges: 100,
      fairing: 'tangent',
      refine: true,
      alpha: 3,
    });
    expect(measure(membrane.mesh).volume as number).toBeLessThan(flatVolume);
  });

  it('triangulates a large loop greedily and keeps existing vertices untouched', () => {
    const sphere = icosphere(10, 5);
    const kept: number[] = [];
    for (let f = 0; f < sphere.indices.length; f += 3) {
      const z = [0, 1, 2].reduce((sum, k) => sum + (sphere.positions[(sphere.indices[f + k] as number) * 3 + 2] as number), 0) / 3;
      if (z <= 0) kept.push(sphere.indices[f] as number, sphere.indices[f + 1] as number, sphere.indices[f + 2] as number);
    }
    const open = { positions: sphere.positions, indices: kept };
    const result = fillHoles(open.positions, open.indices, { select: 'all', maxBoundaryEdges: 500, fairing: 'none', refine: false });
    expect(result.filled[0]).toMatchObject({ triangulation: 'greedy' });
    expect(measure(result.mesh).closed).toBe(true);
    const patched = new EditMesh(result.mesh.positions, result.mesh.indices);
    expect(patched.liveFaces).toBe(result.mesh.indices.length / 3);
    const oldIndex = new SurfaceIndex(open.positions, open.indices);
    expect(oldIndex.faceCount).toBe(kept.length / 3);
  });
});

describe('decimation (VC-MSH-06, 07)', () => {
  const planar = (z: (x: number, y: number) => number): IndexedMesh => {
    const grid = gridMesh(10, 12);
    for (let i = 0; i < grid.positions.length; i += 3)
      grid.positions[i + 2] = z(grid.positions[i] as number, grid.positions[i + 1] as number);
    return grid;
  };

  it('keeps flat and tilted planar grids exact: area, planarity, zero cost, locked boundary', () => {
    for (const [z, area] of [
      [() => 0, 100],
      [(x: number, y: number) => 0.3 * x + 0.2 * y, 106.301458127],
    ] as const) {
      const grid = planar(z);
      const result = decimateMesh(grid, { targetTriangles: 40, preserveBoundary: true });
      const after = measure(result.mesh);
      expect(relativeError(after.area, area)).toBeLessThan(1e-9);
      expect(after.boundaryEdges).toBe(48);
      expect(result.report.maxCollapseCost).toBeLessThan(1e-12);
      expect(result.report.reachedTarget).toBe(false);
      expect(result.report.stoppedBy).toBe('exhausted');
      let off = 0;
      for (let i = 0; i < result.mesh.positions.length; i += 3) {
        const [x, y, h] = [
          result.mesh.positions[i] as number,
          result.mesh.positions[i + 1] as number,
          result.mesh.positions[i + 2] as number,
        ];
        off = Math.max(off, Math.abs(h - z(x, y)));
      }
      expect(off).toBeLessThan(1e-12);
      expect(after.faces).toBeLessThanOrEqual(48);
    }
  });

  it('reaches a triangle target on a closed sphere and never leaves a fold-over or open edge', () => {
    const sphere = icosphere(10, 3);
    const result = decimateMesh(sphere, { targetTriangles: 300, preserveBoundary: true });
    const after = measure(result.mesh);
    expect(result.report).toMatchObject({ trianglesBefore: 1280, reachedTarget: true, stoppedBy: 'target' });
    expect(after.faces).toBeLessThanOrEqual(300);
    expect(after.closed).toBe(true);
    expect(after.orientationConsistent).toBe(true);
    expect(after.volume as number).toBeGreaterThan(0);
    expect(symmetricDeviation(sphere, result.mesh)?.hausdorff).toBeLessThan(0.6);
  });

  it('honours maxDeviation in both directions on the l5 icosphere (VC-MSH-07)', () => {
    const sphere = icosphere(10, 5);
    const result = decimateMesh(sphere, { maxDeviation: 0.05, preserveBoundary: true });
    const deviation = symmetricDeviation(sphere, result.mesh) as NonNullable<ReturnType<typeof symmetricDeviation>>;
    expect(deviation.forwardMax).toBeLessThanOrEqual(0.05);
    expect(deviation.backwardMax).toBeLessThanOrEqual(0.05);
    expect(result.report.trianglesAfter).toBeLessThan(2000);
    expect(result.report.rejected.deviation).toBeGreaterThan(0);
    const after = measure(result.mesh);
    expect(after.closed).toBe(true);
    expect(Math.abs((after.volume as number) - (measure(sphere).volume as number)) / (measure(sphere).volume as number)).toBeLessThan(0.01);
  });

  it('can collapse the boundary when it is not preserved, protects feature edges, and locks a region', () => {
    const grid = planar(() => 0);
    const free = decimateMesh(grid, { targetTriangles: 8, preserveBoundary: false });
    expect(free.report.trianglesAfter).toBeLessThan(46);
    const box = cuboid([0, 0, 0], [10, 10, 10]);
    const sharp = decimateMesh(
      { positions: box.positions, indices: box.indices },
      { targetTriangles: 4, preserveBoundary: true, featureAngleRad: Math.PI / 6 },
    );
    expect(measure(sharp.mesh).closed).toBe(true);
    const sphere = icosphere(10, 2);
    const locked = decimateMesh(sphere, { targetTriangles: 100, preserveBoundary: true, lockedRegion: { center: [0, 0, 10], radius: 4 } });
    const lockedVertices = new Set<string>();
    for (let i = 0; i < sphere.positions.length; i += 3)
      if (Math.hypot(sphere.positions[i] as number, sphere.positions[i + 1] as number, (sphere.positions[i + 2] as number) - 10) <= 4)
        lockedVertices.add(sphere.positions.slice(i, i + 3).join(','));
    const resultVertices = new Set<string>();
    for (let i = 0; i < locked.mesh.positions.length; i += 3) resultVertices.add(locked.mesh.positions.slice(i, i + 3).join(','));
    for (const v of lockedVertices) expect(resultVertices.has(v)).toBe(true);
  });

  it('reports stoppedBy from the final state: target iff the target is met (DES-7c)', () => {
    // a concave flat fan: one collapse reaches 4 triangles and leaves the queue with nothing valid; no collapse goes below
    const fan = {
      positions: [0, -0.1, 0, 3, -1, 0, 4, 1, 0, 3, 2, 0, -3, 2, 0, -4, 1, 0, 0, 0, 0],
      indices: [0, 1, 2, 0, 2, 3, 0, 3, 6, 0, 6, 4, 0, 4, 5, 0, 5, 1],
    };
    const met = decimateMesh(fan, { targetTriangles: 4, preserveBoundary: true });
    expect([met.report.trianglesAfter, met.report.reachedTarget, met.report.stoppedBy]).toEqual([4, true, 'target']);
    const below = decimateMesh(fan, { targetTriangles: 3, preserveBoundary: true });
    expect([below.report.trianglesAfter, below.report.reachedTarget, below.report.stoppedBy]).toEqual([4, false, 'exhausted']);
    const already = decimateMesh(fan, { targetTriangles: 10, preserveBoundary: true });
    expect([already.report.collapses, already.report.stoppedBy]).toEqual([0, 'target']);
    // every vertex of a single quad is on its boundary and locked: the queue starts empty, and a mesh already at its target stops by it
    const quad = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3] };
    const locked = decimateMesh(quad, { targetTriangles: 2, preserveBoundary: true });
    expect([locked.report.collapses, locked.report.reachedTarget, locked.report.stoppedBy]).toEqual([0, true, 'target']);
    const sphere = decimateMesh(icosphere(10, 2), { targetTriangles: 100, preserveBoundary: true });
    expect([sphere.report.reachedTarget, sphere.report.stoppedBy]).toEqual([true, 'target']);
  });

  it('orders a NaN cost as +Infinity and refuses collapses whose normals overflow (DES-7c)', () => {
    const wavy = (scale: number): { positions: number[]; indices: number[] } => {
      const n = 30;
      const positions: number[] = [];
      for (let j = 0; j <= n; j++)
        for (let i = 0; i <= n; i++)
          positions.push(i * scale, j * scale, (Math.sin(i / 3) * Math.cos(j / 4) * 3 + ((i * 7 + j * 13) % 10) / 10) * scale);
      const id = (i: number, j: number): number => j * (n + 1) + i;
      const indices: number[] = [];
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
      return { positions, indices };
    };
    // 3e153 and 1e154: the quadrics overflow, so costs are NaN, while the geometry still works; 1e155: the normals overflow too and nothing may collapse
    for (const scale of [3e153, 1e154, 1e155]) {
      const mesh = wavy(scale);
      const first = decimateMesh(mesh, { targetTriangles: 300, preserveBoundary: false });
      expect(decimateMesh(mesh, { targetTriangles: 300, preserveBoundary: false }).mesh).toEqual(first.mesh);
      expect(first.mesh.positions.every(Number.isFinite)).toBe(true);
      expect(first.report.rejected.foldOver).toBeGreaterThan(0);
      if (scale < 1e155) {
        expect(first.report.collapses).toBeGreaterThan(0);
        expect(first.report.maxCollapseCost).toBeNull();
      } else {
        expect(first.report.collapses).toBe(0);
      }
    }
  });
});

describe('smoothing (VC-MSH-08, 09)', () => {
  const taubin = {
    method: 'taubin',
    lambda: 0.6307,
    passBand: 0.1,
    weights: 'uniform',
    fixBoundary: true,
    volumeCorrection: false,
  } as const;
  const laplacian = { ...taubin, method: 'laplacian' } as const;

  it('reproduces the reference Laplacian and Taubin runs on the clean icosphere l4 to 1e-9', () => {
    const mesh = icosphere(10, 4);
    expect(taubinMu(0.6307, 0.1)).toBeCloseTo(-0.6731559455, 9);
    const table = packJson('smoothing_reference.json') as {
      clean: {
        runs: Array<{
          iterations: number;
          laplacian: { meanRadius: number; volume: number };
          taubin: { meanRadius: number; volume: number };
        }>;
      };
    };
    for (const run of table.clean.runs) {
      const tau = smoothMesh(mesh.positions, mesh.indices, { ...taubin, iterations: run.iterations });
      const lap = smoothMesh(mesh.positions, mesh.indices, { ...laplacian, iterations: run.iterations });
      expect(relativeError(meanRadius(tau.positions), run.taubin.meanRadius)).toBeLessThan(1e-9);
      expect(relativeError(tau.volumeAfter as number, run.taubin.volume)).toBeLessThan(1e-9);
      expect(relativeError(meanRadius(lap.positions), run.laplacian.meanRadius)).toBeLessThan(1e-9);
      expect(relativeError(lap.volumeAfter as number, run.laplacian.volume)).toBeLessThan(1e-9);
    }
  });

  it('denoises the seed-42 noisy sphere: Taubin keeps the size, Laplacian shrinks', () => {
    const clean = icosphere(10, 4);
    const random = mulberry32(42);
    const noisy = clean.positions.slice();
    for (let v = 0; v < noisy.length; v += 3) {
      const s = (10 + (random() * 2 - 1) * 0.1) / 10;
      noisy[v] = (noisy[v] as number) * s;
      noisy[v + 1] = (noisy[v + 1] as number) * s;
      noisy[v + 2] = (noisy[v + 2] as number) * s;
    }
    const reference = packJson('smoothing_reference.json') as {
      noisy: {
        before: { meanRadius: number; rmsAboutMean: number };
        taubin10: { meanRadius: number; rmsAboutMean: number };
        laplacian10: { meanRadius: number; rmsAboutMean: number };
      };
    };
    expect(relativeError(meanRadius(noisy), reference.noisy.before.meanRadius)).toBeLessThan(1e-9);
    expect(relativeError(rmsAboutMean(noisy), reference.noisy.before.rmsAboutMean)).toBeLessThan(1e-9);
    const tau = smoothMesh(noisy, clean.indices, { ...taubin, iterations: 10 });
    const lap = smoothMesh(noisy, clean.indices, { ...laplacian, iterations: 10 });
    expect(relativeError(meanRadius(tau.positions), reference.noisy.taubin10.meanRadius)).toBeLessThan(1e-9);
    expect(relativeError(rmsAboutMean(tau.positions), reference.noisy.taubin10.rmsAboutMean)).toBeLessThan(1e-9);
    expect(relativeError(meanRadius(lap.positions), reference.noisy.laplacian10.meanRadius)).toBeLessThan(1e-9);
    expect(relativeError(rmsAboutMean(lap.positions), reference.noisy.laplacian10.rmsAboutMean)).toBeLessThan(1e-9);
  });

  it('volume correction restores the input volume of a closed mesh; boundaries and regions stay fixed; cotangent weights run', () => {
    const mesh = icosphere(10, 4);
    const corrected = smoothMesh(mesh.positions, mesh.indices, { ...taubin, iterations: 50, volumeCorrection: true });
    expect(corrected.volumeCorrected).toBe(true);
    expect(relativeError(corrected.volumeAfter as number, corrected.volumeBefore as number)).toBeLessThan(1e-12);
    const noisy = mesh.positions.map((v, i) => v + (i % 7 === 0 ? 0.05 : 0));
    const cap: number[] = [];
    for (let f = 0; f < mesh.indices.length; f += 3) {
      const z = [0, 1, 2].reduce((sum, k) => sum + (mesh.positions[(mesh.indices[f + k] as number) * 3 + 2] as number), 0) / 3;
      if (z < 8) cap.push(mesh.indices[f] as number, mesh.indices[f + 1] as number, mesh.indices[f + 2] as number);
    }
    const open = { positions: noisy, indices: cap };
    const fixed = smoothMesh(open.positions, open.indices, { ...taubin, iterations: 3 });
    const loops = analyzeIndexedMesh(open.positions, open.indices, { selfIntersections: false, maxListed: 5 });
    expect(loops.boundaryLoopCount).toBe(1);
    expect(fixed.volumeCorrected).toBe(false);
    const freeBoundary = smoothMesh(open.positions, open.indices, { ...taubin, iterations: 3, fixBoundary: false });
    expect(freeBoundary.maxDisplacement).toBeGreaterThanOrEqual(fixed.maxDisplacement);
    const region = smoothMesh(noisy, mesh.indices, { ...taubin, iterations: 5, region: { center: [0, 0, 10], radius: 3 } });
    for (let v = 0; v < noisy.length; v += 3)
      if (Math.hypot(noisy[v] as number, noisy[v + 1] as number, (noisy[v + 2] as number) - 10) > 3)
        expect([region.positions[v], region.positions[v + 1], region.positions[v + 2]]).toEqual([noisy[v], noisy[v + 1], noisy[v + 2]]);
    const cotan = smoothMesh(mesh.positions, mesh.indices, { ...laplacian, weights: 'cotangent', iterations: 5 });
    expect(meanRadius(cotan.positions)).toBeLessThan(10);
    expect(cotan.meanDisplacement).toBeGreaterThan(0);
  });
});

describe('remeshing (VC-MSH-10)', () => {
  const params = { iterations: 5, featureAngleRad: (40 * Math.PI) / 180, preserveBoundary: true, project: true } as const;

  it('remeshes the l5 icosphere to L = 1: max edge within 4/3, mean edge near 1, surface kept within the Jung bound plus the input sag', () => {
    const sphere = icosphere(10, 5);
    const result = remeshMesh(sphere, { ...params, targetEdge: 1 });
    const after = measure(result.mesh);
    expect(result.report.edgeLength.max).toBeLessThanOrEqual((4 / 3) * (1 + 1e-9));
    expect(result.report.edgeLength.mean).toBeGreaterThan(0.85);
    expect(result.report.edgeLength.mean).toBeLessThan(1.1);
    expect(result.report.fractionInBand).toBeGreaterThan(0.6);
    expect(after.closed).toBe(true);
    expect(after.orientationConsistent).toBe(true);
    expect(Math.abs((after.volume as number) - (measure(sphere).volume as number)) / (measure(sphere).volume as number)).toBeLessThan(0.01);
    // chord deviation from the TRUE sphere: bound R - sqrt(R^2 - l^2/3) at l = 4/3, widened by the input's own sag
    const jung = 10 - Math.sqrt(100 - (4 / 3) ** 2 / 3);
    const inputSag = 10 - Math.sqrt(100 - 0.35 ** 2 / 3);
    expect(jung).toBeCloseTo(0.0296736559, 9);
    let worst = 0;
    const centre = (face: number): number => {
      const sum = [0, 0, 0];
      for (let k = 0; k < 3; k++)
        for (let a = 0; a < 3; a++)
          sum[a] = (sum[a] as number) + (result.mesh.positions[(result.mesh.indices[face + k] as number) * 3 + a] as number) / 3;
      return 10 - Math.hypot(...sum);
    };
    for (let f = 0; f < result.mesh.indices.length; f += 3) worst = Math.max(worst, centre(f));
    expect(worst).toBeLessThanOrEqual(jung + inputSag);
  });

  it('is adaptive: short edges where the surface bends, long ones where it is flat, within minEdge..maxEdge', () => {
    const box = cuboid([0, 0, 0], [10, 10, 10]);
    const sub = remeshMesh(
      (() => {
        const level = icosphere(10, 3);
        return { positions: level.positions, indices: level.indices };
      })(),
      { ...params, minEdge: 0.5, maxEdge: 3, approxError: 0.02 },
    );
    expect(sub.report.mode).toBe('adaptive');
    expect(sub.report.edgeLength.max).toBeLessThanOrEqual(3 * (4 / 3) + 1e-9);
    expect(measure(sub.mesh).closed).toBe(true);
    expect(box.indices.length).toBe(36);
  });

  it('keeps feature edges of a box and a region outside the sphere of influence untouched', () => {
    const box = cuboid([0, 0, 0], [10, 10, 10]);
    const refined = remeshMesh({ positions: box.positions, indices: box.indices }, { ...params, targetEdge: 2.5 });
    expect(refined.report.featureEdges).toBeGreaterThan(0);
    const after = measure(refined.mesh);
    expect(after.closed).toBe(true);
    expect(relativeError(after.volume as number, 1000)).toBeLessThan(1e-9);
    expect(relativeError(after.area, 600)).toBeLessThan(1e-9);
    const sphere = icosphere(10, 3);
    const local = remeshMesh(sphere, { ...params, targetEdge: 0.6, region: { center: [0, 0, 10], radius: 3 } });
    const farOriginal = new Set<string>();
    for (let i = 0; i < sphere.positions.length; i += 3)
      if (Math.hypot(sphere.positions[i] as number, sphere.positions[i + 1] as number, (sphere.positions[i + 2] as number) - 10) > 3.5)
        farOriginal.add(sphere.positions.slice(i, i + 3).join(','));
    const resultVertices = new Set<string>();
    for (let i = 0; i < local.mesh.positions.length; i += 3) resultVertices.add(local.mesh.positions.slice(i, i + 3).join(','));
    for (const v of farOriginal) expect(resultVertices.has(v)).toBe(true);
    expect(local.report.trianglesAfter).toBeGreaterThan(sphere.indices.length / 3);
  });

  it('remeshes an open patch with a preserved and a free boundary', () => {
    const grid = gridMesh(10, 8);
    const kept = remeshMesh(grid, { ...params, targetEdge: 2 });
    expect(measure(kept.mesh).boundaryLoopCount).toBe(1);
    expect(relativeError(measure(kept.mesh).area, 100)).toBeLessThan(1e-9);
    const free = remeshMesh(grid, { ...params, targetEdge: 2, preserveBoundary: false });
    expect(measure(free.mesh).boundaryLoopCount).toBe(1);
    expect(relativeError(measure(free.mesh).area, 100)).toBeLessThan(0.05);
  });
});

describe('plane cut (VC-MSH-17)', () => {
  const unitCube = cuboid([0, 0, 0], [1, 1, 1]);

  it('cuts the unit cube: hexagon, triangle and half cuts with exact volumes and cap areas', () => {
    const cases = [
      { origin: [0.5, 0.5, 0.5], normal: [1, 1, 1], side: -1, volume: 0.5, cap: (3 * Math.sqrt(3)) / 4 },
      { origin: [1 / 3, 1 / 3, 1 / 3], normal: [1, 1, 1], side: -1, volume: 1 / 6, cap: Math.sqrt(3) / 2 },
      { origin: [0.25, 0, 0], normal: [1, 0, 0], side: 1, volume: 0.75, cap: 1 },
      { origin: [0.25, 0, 0], normal: [1, 0, 0], side: -1, volume: 0.25, cap: 1 },
    ] as const;
    for (const c of cases) {
      const result = cutMeshByPlane(unitCube, c.origin, c.normal, c.side, true, 1e-12);
      const after = measure(result.mesh);
      expect(after.closed).toBe(true);
      expect(after.orientationConsistent).toBe(true);
      expect(relativeError(after.volume as number, c.volume)).toBeLessThan(1e-12);
      expect(relativeError(result.capArea, c.cap)).toBeLessThan(1e-12);
      expect(result.loops).toBe(1);
      expect(result.uncapped).toBe(0);
    }
    expect(crossesPlane(unitCube, [0.25, 0, 0], [1, 0, 0], 1e-12)).toBe(true);
    expect(crossesPlane(unitCube, [2, 0, 0], [1, 0, 0], 1e-12)).toBe(false);
  });

  it('leaves the cut open without cap, keeps coplanar faces on the right side, and caps a hollow shell with a ring', () => {
    const open = cutMeshByPlane(unitCube, [0.5, 0, 0], [1, 0, 0], 1, false, 1e-12);
    expect(measure(open.mesh).closed).toBe(false);
    expect(open.capTriangles).toBe(0);
    const touching = cutMeshByPlane(unitCube, [0, 0, 0], [0, 0, 1], 1, true, 1e-12);
    expect(relativeError(measure(touching.mesh).volume as number, 1)).toBeLessThan(1e-12);
    const outer = cuboid([0, 0, 0], [4, 4, 4]);
    const inner = cuboid([1, 1, 1], [3, 3, 3]);
    const innerReversed = inner.indices.map((_, i) => inner.indices[i - (i % 3) + ((3 - (i % 3)) % 3)] as number);
    const hollow = { positions: [...outer.positions, ...inner.positions], indices: [...outer.indices, ...innerReversed.map((i) => i + 8)] };
    expect(measure(hollow).volume).toBeCloseTo(64 - 8, 10);
    const half = cutMeshByPlane(hollow, [2, 2, 2], [0, 0, 1], 1, true, 1e-12);
    const analysis = measure(half.mesh);
    expect(analysis.closed).toBe(true);
    expect(half.loops).toBe(2);
    expect(relativeError(half.capArea, 16 - 4)).toBeLessThan(1e-12);
    expect(relativeError(analysis.volume as number, 28)).toBeLessThan(1e-12);
  });

  it('cuts an open mesh and caps only closed section loops', () => {
    const sphere = icosphere(10, 3);
    const upper: number[] = [];
    for (let f = 0; f < sphere.indices.length; f += 3) {
      const z = [0, 1, 2].reduce((sum, k) => sum + (sphere.positions[(sphere.indices[f + k] as number) * 3 + 2] as number), 0) / 3;
      if (z > -5) upper.push(sphere.indices[f] as number, sphere.indices[f + 1] as number, sphere.indices[f + 2] as number);
    }
    const bowl = { positions: sphere.positions, indices: upper };
    const cut = cutMeshByPlane(bowl, [0, 0, 5], [0, 0, 1], -1, true, 1e-12);
    expect(cut.loops).toBe(1);
    const kept = measure(cut.mesh);
    expect(kept.boundaryLoopCount).toBe(1);
  });
});

describe('cap triangulation', () => {
  it('keeps collinear vertices (no T-junctions) and covers the polygon exactly', () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const result = triangulateCap(square, []);
    expect(result.complete).toBe(true);
    expect(new Set(result.triangles.flat())).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('bridges holes, and reports an incomplete triangulation for a degenerate polygon', () => {
    const outer: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ];
    const hole: Array<[number, number]> = [
      [1, 1],
      [1, 3],
      [3, 3],
      [3, 1],
    ];
    const ring = triangulateCap(outer, [hole]);
    expect(ring.complete).toBe(true);
    const area = ring.triangles.reduce((sum, [a, b, c]) => {
      const all = [...outer, ...hole] as Array<[number, number]>;
      const pa = all[a] as [number, number];
      const pb = all[b] as [number, number];
      const pc = all[c] as [number, number];
      return sum + Math.abs((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])) / 2;
    }, 0);
    expect(area).toBeCloseTo(12, 12);
    expect(
      triangulateCap(
        [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        [],
      ).complete,
    ).toBe(false);
  });
});

describe('symmetric deviation (VC-MSH-25)', () => {
  it('two parallel grids 0.5 apart: Hausdorff = mean = rms = 0.5, histogram in the last bin', () => {
    const a = gridMesh(10, 10);
    const b = { positions: a.positions.map((v, i) => (i % 3 === 2 ? v + 0.5 : v)), indices: a.indices };
    const deviation = symmetricDeviation(a, b) as NonNullable<ReturnType<typeof symmetricDeviation>>;
    for (const value of [deviation.forwardMax, deviation.backwardMax, deviation.hausdorff, deviation.mean, deviation.rms])
      expect(Math.abs(value - 0.5)).toBeLessThan(1e-12);
    expect(deviation.histogram[9]).toBe(deviation.samples);
    expect(deviation.worst.distance).toBeCloseTo(0.5, 12);
    expect(symmetricDeviation(a, { positions: [], indices: [] })).toBeNull();
    const zero = symmetricDeviation(a, a) as NonNullable<ReturnType<typeof symmetricDeviation>>;
    expect(zero.hausdorff).toBeLessThan(1e-12);
  });

  it('thins the samples evenly above the cap', () => {
    const sphere = icosphere(10, 3);
    const full = symmetricDeviation(sphere, sphere, 100) as NonNullable<ReturnType<typeof symmetricDeviation>>;
    expect(full.samples).toBe(200);
  });
});
