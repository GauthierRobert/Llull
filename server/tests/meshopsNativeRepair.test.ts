/**
 * DES-7c step 7, slice 2: the native `repair` (five modes) and `fill_holes` of `llull-compute meshops` against the TypeScript engine, which is the oracle.
 * Result meshes must hash alike (positions and indices, byte for byte), reports must be equal and refusals must carry the same code and message.
 * Native runs need llull-compute (cargo build in solver/) and are skipped with a logged reason otherwise.
 */

import { describe, expect, it } from 'vitest';
import type { MeshEngineFailure, MeshOp, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import { meshDiagonal } from '@core/geometry/mesh/weld';
import type { MeshData } from '@core/model/types';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { box, grid, hashOf, icosphere, noisy, withHoles } from './meshopsNativeSupport';
import { bigHoleSphere, crackedPlane, flipFaces, gridWithHole, keepFaces, sideBySide, soupOf } from './meshopsRepairSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshopsNativeRepair: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });

const nativeRun = (input: { mesh: MeshData }, op: MeshOp): Promise<MeshOpResult | MeshEngineFailure> =>
  resolveDeferred(() => (engine as NonNullable<typeof engine>).run(input, op));

type RepairMode = 'weld' | 'clean' | 'orient' | 'stitch' | 'close_holes';

const repair = (mesh: MeshData, mode: RepairMode, extra: Partial<Extract<MeshOp, { op: 'repair' }>> = {}): MeshOp => {
  const weldTolerance = extra.weldTolerance ?? 1e-6 * meshDiagonal(mesh.positions);
  return { op: 'repair', mode, weldTolerance, maxGap: 100 * weldTolerance, maxBoundaryEdges: 1000, ...extra };
};

const fill = (extra: Partial<Extract<MeshOp, { op: 'fill_holes' }>> = {}): MeshOp => ({
  op: 'fill_holes',
  select: 'all',
  maxBoundaryEdges: 1000,
  fairing: 'curvature',
  refine: true,
  alpha: Math.SQRT2,
  ...extra,
});

/** Both engines on `op`: identical bytes and report, or the identical refusal. Returns the native answer. */
async function expectSame(mesh: MeshData, op: MeshOp): Promise<MeshOpResult | MeshEngineFailure> {
  const ts = tsMeshEngine.run({ mesh }, op);
  const nat = await nativeRun({ mesh }, op);
  if (isEngineFailure(ts)) {
    expect(nat).toEqual(ts);
    return nat;
  }
  if (isEngineFailure(nat)) throw new Error(`native: ${nat.code} ${nat.message}`);
  expect(hashOf(nat.mesh as MeshData)).toBe(hashOf(ts.mesh as MeshData));
  expect(nat.report).toEqual(ts.report);
  expect(nat.provenance).toMatchObject({
    engine: 'native',
    deterministic: true,
    algorithm: ts.provenance.algorithm,
    reference: ts.provenance.reference,
  });
  return nat;
}

const changesOf = (answer: MeshOpResult | MeshEngineFailure): Record<string, number> =>
  ((answer as MeshOpResult).report as { changes: Record<string, number> }).changes;

const ALL_MODES: readonly RepairMode[] = ['weld', 'clean', 'orient', 'stitch', 'close_holes'];

describe('native repair is bit-identical to the TypeScript engine (DES-7c step 7, slice 2)', () => {
  native('weld: an unwelded soup with copies moved within the tolerance, unused vertices and a repeated corner', async () => {
    const sphere = icosphere(10, 2);
    const tolerance = 1e-3;
    const soup = soupOf(sphere, tolerance / 4, 5);
    const damaged: MeshData = { positions: soup.positions, indices: [...soup.indices, 0, 0, 3] };
    for (const mode of ALL_MODES) {
      const answer = await expectSame(damaged, repair(damaged, mode, { weldTolerance: tolerance, maxGap: 0.01 }));
      expect(changesOf(answer)['welded']).toBeGreaterThan(0);
    }
    // exact weld (tolerance 0), and a tolerance far below the spacing
    await expectSame(soupOf(sphere, 0, 5), repair(sphere, 'weld', { weldTolerance: 0 }));
    await expectSame(soup, repair(soup, 'weld', { weldTolerance: 1e-12 }));
  });

  native('clean: degenerate (repeated corner, zero area) and duplicate faces in both windings', async () => {
    const sphere = icosphere(10, 2);
    const collinear: MeshData = { positions: [...sphere.positions, 0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [] };
    const n = sphere.positions.length / 3;
    const mesh: MeshData = {
      positions: collinear.positions,
      indices: [...sphere.indices, ...sphere.indices.slice(30, 33), ...sphere.indices.slice(60, 63).reverse(), 2, 2, 5, n, n + 1, n + 2],
    };
    const answer = await expectSame(mesh, repair(mesh, 'clean'));
    expect(changesOf(answer)).toMatchObject({ duplicatesRemoved: 2, degenerateRemoved: 2 });
    await expectSame(mesh, repair(mesh, 'weld'));
  });

  native('orient: a flipped patch, an inside-out closed shell, two shells and a non-manifold edge', async () => {
    const sphere = icosphere(10, 3);
    const patch = flipFaces(sphere, new Set([5, 6, 7, 40, 41, 300]));
    expect(changesOf(await expectSame(patch, repair(patch, 'orient')))['flipped']).toBeGreaterThan(0);
    const inside = flipFaces(sphere, new Set(Array.from({ length: sphere.indices.length / 3 }, (_, f) => f)));
    expect(changesOf(await expectSame(inside, repair(inside, 'orient')))['flipped']).toBe(sphere.indices.length / 3);
    const two = sideBySide([icosphere(3, 2), flipFaces(icosphere(3, 2), new Set([1, 2]))], 30);
    await expectSame(two, repair(two, 'orient'));
    // a third face on one edge: the shell is not oriented across it
    const fin: MeshData = {
      positions: [...sphere.positions, 30, 30, 30],
      indices: [...sphere.indices, sphere.indices[0] as number, sphere.indices[1] as number, sphere.positions.length / 3],
    };
    await expectSame(fin, repair(fin, 'orient'));
    await expectSame(
      grid(10, 6, (x, y) => x * y),
      repair(
        grid(10, 6, (x, y) => x * y),
        'orient',
      ),
    );
  });

  native('stitch: a crack, a gap too wide, a reverted merge, and close_holes after it', async () => {
    const cracked = crackedPlane(8, 1e-3);
    const merged = await expectSame(cracked, repair(cracked, 'stitch', { weldTolerance: 1e-6, maxGap: 2e-3 }));
    expect(changesOf(merged)['stitched']).toBeGreaterThan(0);
    await expectSame(cracked, repair(cracked, 'stitch', { weldTolerance: 1e-6, maxGap: 1e-4 }));
    await expectSame(cracked, repair(cracked, 'close_holes', { weldTolerance: 1e-6, maxGap: 2e-3 }));
    // 0.001 apart on either side of the grid cell 2^31 (cells of the size of the gap): the cell index is not narrowed to 32 bits
    const wrap: MeshData = {
      positions: [
        2147483.6475,
        0,
        0,
        2147483.6475 - 5,
        0,
        0,
        2147483.6475 - 5,
        5,
        0,
        2147483.6485,
        0,
        0,
        2147483.6485 + 5,
        0,
        0,
        2147483.6485 + 5,
        5,
        0,
      ],
      indices: [0, 1, 2, 3, 4, 5],
    };
    expect(changesOf(await expectSame(wrap, repair(wrap, 'stitch', { weldTolerance: 0, maxGap: 0.002 })))['stitched']).toBe(1);
    await expectSame(wrap, repair(wrap, 'stitch', { weldTolerance: 0, maxGap: 1e-300 }));
    // the corner v (2) is 0.001 from u (1): merging them would put a third face on the edge a-u, so the merge is reverted and said so
    const pinch: MeshData = {
      positions: [0, 0, 0, 1, 0, 0, 1, 0.001, 0, 0.5, 1, 0, 0.5, -1, 0, 0.5, 0.5, 1],
      indices: [0, 1, 3, 1, 0, 4, 0, 2, 5],
    };
    const reverted = await expectSame(pinch, repair(pinch, 'stitch', { weldTolerance: 1e-9, maxGap: 0.01 }));
    expect((reverted as MeshOpResult).report['notes']).toEqual([expect.stringContaining('stitch reverted')]);
    expect(changesOf(reverted)['stitched']).toBe(0);
  });

  native('close_holes: holes of a noisy sphere, a bigger loop, a loop over maxBoundaryEdges and a greedy loop', async () => {
    const holey = withHoles(noisy(icosphere(10, 4), 0.02), 20);
    const closed = await expectSame(holey, repair(holey, 'close_holes'));
    expect(changesOf(closed)['holesFilled']).toBeGreaterThanOrEqual(19);
    const big = bigHoleSphere(4, 3);
    await expectSame(big, repair(big, 'close_holes'));
    await expectSame(big, repair(big, 'close_holes', { maxBoundaryEdges: 6 }));
    const wide = gridWithHole(40, [10, 30, 10, 30], (x, y) => 0.2 * Math.sin(x) * y);
    await expectSame(wide, repair(wide, 'close_holes'));
    // 160 edges: above the 120 of the dynamic program, the greedy ear clip
    const greedy = gridWithHole(100, [30, 70, 30, 70], (x, y) => 0.1 * Math.sin(x) * Math.cos(y));
    const answer = await expectSame(greedy, repair(greedy, 'close_holes'));
    expect(changesOf(answer)['holesFilled']).toBe(2);
  });

  native('small shells: by face count and by volume, everything small keeps the largest', async () => {
    const parts = [icosphere(10, 3), icosphere(2, 2), icosphere(1, 1), grid(3, 3, () => 0)];
    const shells = sideBySide(parts, 40);
    for (const mode of ALL_MODES) {
      await expectSame(shells, repair(shells, mode, { smallComponents: { maxFaces: 100 } }));
      await expectSame(shells, repair(shells, mode, { smallComponents: { maxVolume: 50 } }));
    }
    const answer = await expectSame(shells, repair(shells, 'clean', { smallComponents: { maxFaces: 1e9, maxVolume: 1 } }));
    expect(changesOf(answer)['componentsRemoved']).toBe(3);
    await expectSame(shells, repair(shells, 'clean', { smallComponents: {} }));
  });

  native('a box, an empty mesh and meshes of one face', async () => {
    for (const mode of ALL_MODES) {
      await expectSame(box(10, 4), repair(box(10, 4), mode));
      const single: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
      await expectSame(single, repair(single, mode, { weldTolerance: 1e-6 }));
      await expectSame({ positions: [], indices: [] }, repair({ positions: [], indices: [] }, mode, { weldTolerance: 1e-6 }));
    }
  });
});

describe('native fill_holes is bit-identical to the TypeScript engine (DES-7c step 7, slice 2)', () => {
  native('every fairing, with and without refinement, for holes of several sizes', async () => {
    const mesh = bigHoleSphere(4, 11);
    for (const fairing of ['none', 'tangent', 'curvature'] as const)
      for (const refine of [false, true]) await expectSame(mesh, fill({ fairing, refine }));
    for (const alpha of [1, 2, 3.5]) {
      const answer = await expectSame(mesh, fill({ alpha }));
      expect((answer as MeshOpResult).report['totalLoops']).toBeGreaterThan(0);
    }
    const inserted = await expectSame(
      gridWithHole(30, [8, 22, 8, 22], (x, y) => 0.3 * Math.sin(x) * Math.cos(y)),
      fill({ alpha: 2 }),
    );
    const holes = (inserted as MeshOpResult).report['filled'] as Array<{ addedVertices: number }>;
    expect(holes.some((hole) => hole.addedVertices > 0)).toBe(true);
  });

  native('the holes of the benchmark sphere (6-edge fans), a big hole fairing against the surface, a flat hole', async () => {
    const holey = withHoles(noisy(icosphere(10, 5), 0.02), 50);
    await expectSame(holey, fill());
    await expectSame(
      gridWithHole(40, [10, 30, 10, 30], (x, y) => 0.2 * Math.sin(x) * y),
      fill({ alpha: 1.5 }),
    );
    await expectSame(
      gridWithHole(20, [5, 15, 5, 15], () => 0),
      fill(),
    );
  });

  native('selection: loop numbers, points, repeated entries, out-of-range numbers and a point on a closed mesh', async () => {
    const mesh = bigHoleSphere(4, 11);
    await expectSame(mesh, fill({ select: [2, 0, 2] }));
    await expectSame(mesh, fill({ select: [1] }));
    await expectSame(
      mesh,
      fill({
        select: {
          near: [
            [0, 0, 10],
            [0, 10, 0],
            [0, 0, 10],
          ],
        },
      }),
    );
    expect(await expectSame(mesh, fill({ select: [99] }))).toMatchObject({ code: 'MESH_HOLE_NOT_FOUND' });
    const closed = icosphere(10, 2);
    const refused = await expectSame(closed, fill({ select: { near: [[1.5, 2, 3e21]] } }));
    expect(refused).toMatchObject({ code: 'MESH_HOLE_NOT_FOUND', message: 'no boundary loop near [1.5, 2, 3e+21]: the mesh has none' });
    await expectSame(closed, fill());
    await expectSame(closed, fill({ select: [0] }));
  });

  native('loops that are skipped (all) or refused (chosen): too large, not simple, no triangulation', async () => {
    const wide = gridWithHole(30, [5, 25, 5, 25], () => 0);
    const skipped = await expectSame(wide, fill({ maxBoundaryEdges: 10 }));
    expect((skipped as MeshOpResult).report['skipped']).toHaveLength(2);
    expect(await expectSame(wide, fill({ select: [0, 1], maxBoundaryEdges: 10 }))).toMatchObject({ code: 'MESH_HOLE_TOO_LARGE' });
    // two squares sharing the corner 0: the boundary chain runs through it twice, one loop of 8 edges
    const touching: MeshData = {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, -1, 0, -1, -1, 0, -1, 0, 0],
      indices: [0, 1, 2, 0, 2, 3, 0, 5, 4, 0, 6, 5],
    };
    const notSimple = await expectSame(touching, fill());
    expect((notSimple as MeshOpResult).report['skipped']).toEqual([{ loop: 0, edges: 8, code: 'MESH_HOLE_NON_SIMPLE' }]);
    expect(await expectSame(touching, fill({ select: [0] }))).toMatchObject({ code: 'MESH_HOLE_NON_SIMPLE' });
    // a square pyramid without its base, with the two diagonals of the base present as edges of two closed tetrahedra: no triangulation
    const pyramid: MeshData = {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 1, 3, 3, 3, 3, 3, -3, 3, -3, 3, 3, -3, -3],
      // the pyramid sides, then the tetrahedra (0, 2, 5, 6) and (1, 3, 7, 8)
      indices: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4, 0, 2, 5, 0, 6, 2, 0, 5, 6, 2, 6, 5, 1, 3, 7, 1, 8, 3, 1, 7, 8, 3, 8, 7],
    };
    const none = await expectSame(pyramid, fill());
    expect((none as MeshOpResult).report['skipped']).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'MESH_HOLE_NO_TRIANGULATION' })]),
    );
    expect(await expectSame(pyramid, fill({ select: [0] }))).toBeDefined();
  });

  native('unrefined meshes: degenerate faces, duplicate faces and a soup are given as they are', async () => {
    const sphere = icosphere(10, 3);
    const damaged: MeshData = {
      positions: sphere.positions,
      indices: [...keepFaces(sphere, (f) => f % 97 !== 0).indices, 3, 3, 4, ...sphere.indices.slice(30, 33)],
    };
    await expectSame(damaged, fill());
    await expectSame(soupOf(sphere, 0, 3), fill());
  });
});

describe('the composite engine routes repair and fill_holes by size (DES-7c step 7, slice 2)', () => {
  const composite = (): ReturnType<typeof composeMeshEngines> => composeMeshEngines([tsMeshEngine, engine as NonNullable<typeof engine>]);
  const provenanceOf = (result: MeshOpResult | MeshEngineFailure): string => (result as MeshOpResult).provenance.engine;
  /** 20,480 triangles (a sphere), 39,762 (a grid) and 81,920 (a sphere), each with holes. */
  const small = withHoles(noisy(icosphere(10, 5), 0.02), 12);
  const middle = withHoles(
    noisy(
      grid(10, 141, (x, y) => Math.sin(x) * Math.cos(y)),
      0.01,
    ),
    12,
  );
  const large = withHoles(noisy(icosphere(10, 6), 0.02), 24);

  native('below 50,000 triangles repair stays in process, above it goes native; fill_holes switches at 30,000', async () => {
    const [low, between, high] = [small, middle, large].map((mesh) => mesh.indices.length / 3) as [number, number, number];
    expect([low < 30_000, between > 30_000 && between < 50_000, high > 50_000]).toEqual([true, true, true]);
    for (const [mesh, repairBy, fillBy] of [
      [small, 'ts', 'ts'],
      [middle, 'ts', 'native'],
      [large, 'native', 'native'],
    ] as const) {
      for (const [op, by] of [
        [repair(mesh, 'close_holes'), repairBy],
        [fill(), fillBy],
      ] as const) {
        const routed = await resolveDeferred(() => composite().run({ mesh }, op));
        expect(isEngineFailure(routed) ? routed : provenanceOf(routed), `${mesh.indices.length / 3} triangles, ${op.op}`).toBe(by);
        // the result is the same whichever engine produced it
        const oracle = tsMeshEngine.run({ mesh }, op) as MeshOpResult;
        expect(hashOf((routed as MeshOpResult).mesh as MeshData)).toBe(hashOf(oracle.mesh as MeshData));
        expect((routed as MeshOpResult).report).toEqual(oracle.report);
      }
    }
  });

  native('outside the resolving host path the native engine hands over, so the in-process answer still works', () => {
    // a finished job answers without a scope, so start with none kept
    _clearResultCache();
    const answered = composite().run({ mesh: large }, repair(large, 'orient'));
    expect(provenanceOf(answered)).toBe('ts');
    expect(provenanceOf(composite().run({ mesh: large }, fill()))).toBe('ts');
  });

  native('a job the native engine cannot take (a NaN tolerance) falls back to the TypeScript engine, which answers alike', async () => {
    const op = repair(large, 'clean', { weldTolerance: Number.NaN });
    expect(await nativeRun({ mesh: large }, op)).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED' });
    const routed = await resolveDeferred(() => composite().run({ mesh: large }, op));
    expect(provenanceOf(routed)).toBe('ts');
  });

  native('the caps: 4,000,000 triangles for both ops, listed by the composite', () => {
    expect(composite().capabilities().get('repair')).toBe(4_000_000);
    expect(composite().capabilities().get('fill_holes')).toBe(4_000_000);
    const huge = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(4_000_001 * 3).fill(0) };
    for (const op of [repair(huge, 'weld'), fill()])
      expect(composite().run({ mesh: huge }, op)).toMatchObject({ code: 'MESH_ENGINE_CAP_EXCEEDED' });
  });

  native('the native answer carries the version and the algorithm of the TypeScript one in its provenance', async () => {
    const answer = (await nativeRun({ mesh: small }, repair(small, 'orient'))) as MeshOpResult;
    expect(answer.provenance).toMatchObject({ engine: 'native', deterministic: true, version: expect.stringContaining('llull-compute@') });
  });
});
