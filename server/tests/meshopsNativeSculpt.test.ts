/**
 * DES-7c step 7, slice 3: the native `sculpt` of `llull-compute meshops` against the TypeScript engine, which is the oracle. Result meshes must hash alike (positions and
 * indices, byte for byte), reports must be equal and refusals must carry the same code and message, for every brush, falloff, direction, symmetry plane, refinement and mask.
 * Native runs need llull-compute (cargo build in solver/) and are skipped with a logged reason otherwise.
 */

import { describe, expect, it } from 'vitest';
import type { MeshEngineFailure, MeshOp, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import type { MeshData } from '@core/model/types';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { composeMeshEngines } from '@core/geometry/mesh/engine';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { grid, hashOf, icosphere, noisy, withHoles } from './meshopsNativeSupport';
import { flipFaces, soupOf } from './meshopsRepairSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshopsNativeSculpt: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });

const nativeRun = (input: { mesh: MeshData }, op: MeshOp): Promise<MeshOpResult | MeshEngineFailure> =>
  resolveDeferred(() => (engine as NonNullable<typeof engine>).run(input, op));

type SculptOp = Extract<MeshOp, { op: 'sculpt' }>;
const BRUSHES = ['draw', 'inflate', 'grab', 'smooth', 'flatten', 'pinch', 'crease', 'layer'] as const;
const FALLOFFS = ['constant', 'linear', 'smooth', 'sphere'] as const;
const PLANES = ['yz', 'xz', 'xy'] as const;

const sculpt = (extra: Partial<SculptOp> = {}): SculptOp => ({
  op: 'sculpt',
  brush: 'draw',
  stamps: [[0, 0, 10]],
  radius: 3,
  strength: 0.4,
  falloff: 'smooth',
  direction: 'area_normal',
  taubin: false,
  ...extra,
});

/** Three stamps along a meridian of a sphere of radius 10 (the middle one slightly inside it: projected onto the surface). */
const STROKE: SculptOp['stamps'] = [
  [0, 0, 10],
  [2, 1, 9.6],
  [4, 2, 9],
];

/** Both engines on `op`: identical bytes and report, or the identical refusal. Returns the native answer. */
async function expectSame(mesh: MeshData, op: MeshOp, label = ''): Promise<MeshOpResult | MeshEngineFailure> {
  const ts = tsMeshEngine.run({ mesh }, op);
  const nat = await nativeRun({ mesh }, op);
  if (isEngineFailure(ts)) {
    expect(nat, label).toEqual(ts);
    return nat;
  }
  if (isEngineFailure(nat)) throw new Error(`${label} native: ${nat.code} ${nat.message}`);
  expect(hashOf(nat.mesh as MeshData), label).toBe(hashOf(ts.mesh as MeshData));
  expect(nat.report, label).toEqual(ts.report);
  expect(nat.provenance).toMatchObject({
    engine: 'native',
    deterministic: true,
    algorithm: ts.provenance.algorithm,
    reference: ts.provenance.reference,
  });
  return nat;
}

const reportOf = (answer: MeshOpResult | MeshEngineFailure): Record<string, unknown> => (answer as MeshOpResult).report;

describe('native sculpt is bit-identical to the TypeScript engine (DES-7c step 7, slice 3)', () => {
  const ball = noisy(icosphere(10, 4), 0.03);

  native('every brush with every falloff, the three directions and the three mirror planes, on a noisy closed sphere', async () => {
    let moved = 0;
    for (const [b, brush] of BRUSHES.entries()) {
      for (const [f, falloff] of FALLOFFS.entries()) {
        const k = b * FALLOFFS.length + f;
        const direction: SculptOp['direction'] = k % 3 === 0 ? 'normal' : k % 3 === 1 ? 'area_normal' : [0.3, 0.2, 1];
        const answer = await expectSame(
          ball,
          sculpt({
            brush,
            falloff,
            direction,
            stamps: STROKE,
            strength: brush === 'smooth' || brush === 'flatten' || brush === 'pinch' ? 0.6 : 0.3,
            taubin: k % 2 === 0,
            ...(k % 4 !== 3 ? { symmetry: PLANES[k % 3] as (typeof PLANES)[number] } : {}),
            ...(brush === 'layer' ? { maxHeight: 0.25 } : {}),
          }),
          `${brush} ${falloff} ${JSON.stringify(direction)}`,
        );
        moved += reportOf(answer)['movedVertices'] as number;
      }
    }
    expect(moved).toBeGreaterThan(1000);
  });

  native('open meshes (the height-field volume): waves, holes, a ridge, flatten with and without a plane point', async () => {
    const wavy = grid(10, 40, (x, y) => 0.4 * Math.sin(x / 1.5) * Math.cos(y / 2));
    const holey = withHoles(wavy, 6);
    for (const mesh of [wavy, holey]) {
      for (const brush of BRUSHES) {
        const answer = await expectSame(
          mesh,
          sculpt({
            brush,
            stamps: [
              [5, 5, 0.1],
              [6, 4, 0.1],
              [3, 7, 0],
            ],
            radius: 2,
            strength: 0.5,
            direction: brush === 'grab' ? [0, 0, 1] : 'area_normal',
          }),
          brush,
        );
        expect(reportOf(answer)['volumeBasis']).toBe('height-field-sum');
      }
    }
    await expectSame(wavy, sculpt({ brush: 'flatten', stamps: [[5, 5, 0]], radius: 2.5, strength: 0.5, planePoint: [5, 5, 0.1] }));
    await expectSame(
      wavy,
      sculpt({ brush: 'flatten', stamps: [[5, 5, 0]], radius: 2.5, strength: 0.5, symmetry: 'xz', planePoint: [5, 5, 0.1] }),
    );
  });

  native('a stroke of many stamps, stamps off the surface (projected), stamps on the mirror plane and mirror-equal stamps', async () => {
    const stamps: [number, number, number][] = Array.from({ length: 24 }, (_, i) => [
      Math.sin(i / 3) * 8,
      Math.cos(i / 3) * 3,
      9 + Math.cos(i / 5) * 0.4,
    ]);
    await expectSame(ball, sculpt({ stamps, radius: 2.5, strength: 0.15 }));
    await expectSame(ball, sculpt({ stamps, radius: 2.5, strength: 0.15, symmetry: 'yz', brush: 'inflate' }));
    // on the mirror plane (a centred plane, so the stamps are exactly on it): applied once; 1e-7 next to it, past the tolerance: twice
    const centred: MeshData = {
      ...grid(10, 40, () => 0),
      positions: grid(10, 40, () => 0).positions.map((v, i) => (i % 3 < 2 ? v - 5 : v)),
    };
    const onPlane = await expectSame(
      centred,
      sculpt({
        stamps: [
          [0, 1, 0],
          [1, 1, 0],
        ],
        radius: 0.8,
        symmetry: 'yz',
      }),
    );
    expect(reportOf(onPlane)['stampsApplied']).toBe(3);
    const nextTo = await expectSame(
      centred,
      sculpt({
        stamps: [
          [0, 1, 0],
          [1e-7, 1, 0],
        ],
        radius: 0.8,
        symmetry: 'yz',
      }),
    );
    expect(reportOf(nextTo)['stampsApplied']).toBe(3);
    // a stamp exactly on a vertex with a tiny radius moves that vertex only
    const vertex: [number, number, number] = [ball.positions[0] as number, ball.positions[1] as number, ball.positions[2] as number];
    const single = await expectSame(ball, sculpt({ stamps: [vertex], radius: 1e-6 }));
    expect(reportOf(single)['movedVertices']).toBe(1);
  });

  native(
    'refinement: long edges split inside the brush, mirrored, masked, on closed and open meshes, and the compacted vertex order',
    async () => {
      const coarse = icosphere(10, 3);
      for (const brush of ['draw', 'smooth', 'inflate'] as const) {
        const answer = await expectSame(
          coarse,
          sculpt({ brush, stamps: STROKE, radius: 3.5, refineEdge: 0.6, symmetry: 'xz', strength: 0.5 }),
        );
        expect(reportOf(answer)['refinedEdges']).toBeGreaterThan(50);
      }
      await expectSame(coarse, sculpt({ stamps: STROKE, radius: 3, refineEdge: 0.5, mask: { center: [2, 1, 9.6], radius: 2.5 } }));
      await expectSame(coarse, sculpt({ stamps: STROKE, radius: 3, refineEdge: 1e6 }));
      const open = grid(10, 12, (x, y) => Math.sin(x) * Math.cos(y));
      await expectSame(open, sculpt({ stamps: [[5, 5, 0]], radius: 3, refineEdge: 0.4 }));
      await expectSame(
        withHoles(open, 4),
        sculpt({
          stamps: [
            [5, 5, 0],
            [2, 8, 0],
          ],
          radius: 3,
          refineEdge: 0.3,
          symmetry: 'xz',
        }),
      );
      // unreferenced vertices: kept without refinement, dropped by it
      const loose: MeshData = { positions: [...coarse.positions, 99, 99, 99], indices: coarse.indices };
      expect(((await expectSame(loose, sculpt({ stamps: STROKE }))) as MeshOpResult).mesh?.positions.length).toBe(loose.positions.length);
      expect(((await expectSame(loose, sculpt({ stamps: STROKE, refineEdge: 1e6 }))) as MeshOpResult).mesh?.positions.length).toBe(
        coarse.positions.length,
      );
    },
  );

  native('the mask region: only the vertices inside it move', async () => {
    for (const brush of BRUSHES) {
      await expectSame(
        ball,
        sculpt({
          brush,
          stamps: STROKE,
          radius: 4,
          mask: { center: [1, 0.5, 9.8], radius: 2 },
          direction: brush === 'grab' ? [0, 1, 0] : 'normal',
        }),
      );
    }
  });

  native('degenerate input: repeated corners, duplicate faces, flipped faces, an unwelded soup and isolated vertices', async () => {
    const sphere = icosphere(10, 3);
    /** The vertices the repeated corners (0 0 5), (3 3 3) and (1 2 2) use. */
    const at = (v: number): [number, number, number] => [
      sphere.positions[v * 3] as number,
      sphere.positions[v * 3 + 1] as number,
      sphere.positions[v * 3 + 2] as number,
    ];
    const damaged: MeshData = {
      positions: [...sphere.positions, 0, 0, 10.5, 50, 50, 50],
      indices: [...sphere.indices, 0, 0, 5, 3, 3, 3, ...sphere.indices.slice(30, 36), 1, 2, 2],
    };
    for (const brush of BRUSHES) {
      for (const direction of ['normal', 'area_normal'] as const) {
        await expectSame(
          damaged,
          sculpt({ brush, direction, stamps: [at(0), at(3), at(1), [0, 0, 10]], radius: 5, strength: 0.5, symmetry: 'yz' }),
          `${brush} ${direction}`,
        );
      }
    }
    const flipped = flipFaces(sphere, new Set([4, 5, 6, 100, 101, 102, 103]));
    await expectSame(flipped, sculpt({ brush: 'inflate', stamps: STROKE, radius: 4, strength: 0.4 }));
    await expectSame(flipped, sculpt({ brush: 'smooth', stamps: STROKE, radius: 4, strength: 0.4, taubin: true }));
    const soup = soupOf(sphere, 1e-4, 9);
    await expectSame(soup, sculpt({ brush: 'smooth', stamps: STROKE, radius: 4, direction: 'normal', strength: 0.7 }));
    await expectSame(soup, sculpt({ brush: 'draw', stamps: STROKE, radius: 4, direction: 'normal' }));
    // faces of zero area (the height-field sum skips them) and an empty ring (smooth of an isolated vertex)
    const flat: MeshData = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 5, 5, 5], indices: [0, 1, 2, 0, 1, 3] };
    await expectSame(flat, sculpt({ brush: 'smooth', stamps: [[0.5, 0, 0]], radius: 3, strength: 0.5 }));
    await expectSame(flat, sculpt({ brush: 'draw', stamps: [[0.5, 0, 0]], radius: 3, strength: 0.5 }));
    // no triangles at all, and no stamps
    const empty: MeshData = { positions: [], indices: [] };
    await expectSame(empty, sculpt({ stamps: [] }));
    await expectSame(ball, sculpt({ stamps: [] }));
  });

  native('the refusals: a stamp too far from the surface (the first one is named), an empty mesh, too large a refinement', async () => {
    const first = await expectSame(ball, sculpt({ stamps: [[0, 0, 20]] }));
    expect(first).toMatchObject({
      code: 'MESH_SCULPT_STAMP_OFF_SURFACE',
      message: 'stamp 0 is farther than the radius 3 from the mesh surface',
    });
    const second = await expectSame(ball, sculpt({ stamps: STROKE.concat([[0, 0, 14]]), radius: 2.5 }));
    expect(second).toMatchObject({ code: 'MESH_SCULPT_STAMP_OFF_SURFACE', message: expect.stringContaining('stamp 3 is farther') });
    // off the surface but within the radius: projected onto it
    await expectSame(ball, sculpt({ stamps: [[0, 0, 13]], radius: 3.5 }));
    expect(await expectSame({ positions: [], indices: [] }, sculpt())).toMatchObject({ code: 'MESH_SCULPT_STAMP_OFF_SURFACE' });
    const coarse = icosphere(10, 3);
    const big = await expectSame(coarse, sculpt({ stamps: STROKE, radius: 5, refineEdge: 0.05, maxTriangles: 30_000 }));
    expect(big).toMatchObject({ code: 'MESH_SCULPT_RESULT_TOO_LARGE', message: expect.stringContaining('(limit 30000)') });
    // a limit that is not reached
    await expectSame(coarse, sculpt({ stamps: STROKE, radius: 3, refineEdge: 0.5, maxTriangles: 1e6 }));
  });

  native(
    'a bigger mesh: 81,920 triangles, a stroke with its mirror image',
    async () => {
      const large = noisy(icosphere(10, 6), 0.02);
      const answer = await expectSame(large, sculpt({ stamps: STROKE, radius: 3, strength: 0.4, symmetry: 'yz', refineEdge: 0.4 }));
      expect(reportOf(answer)['movedVertices']).toBeGreaterThan(500);
      await expectSame(large, sculpt({ brush: 'smooth', stamps: STROKE, radius: 4, strength: 0.5, taubin: true, direction: 'normal' }));
    },
    120_000,
  );
});

describe('the composite engine routes sculpt by size (DES-7c step 7, slice 3)', () => {
  const composite = (): ReturnType<typeof composeMeshEngines> => composeMeshEngines([tsMeshEngine, engine as NonNullable<typeof engine>]);
  const provenanceOf = (result: MeshOpResult | MeshEngineFailure): string => (result as MeshOpResult).provenance.engine;
  /** 5,120 and 20,480 triangles (spheres), 14,792 and 15,138 (grids on each side of the 15,000 threshold) and 81,920. */
  const wavyGrid = (n: number): MeshData => grid(10, n, (x, y) => 0.4 * Math.sin(x / 1.5) * Math.cos(y / 2));
  const small = noisy(icosphere(10, 4), 0.02);
  const middle = noisy(icosphere(10, 5), 0.02);
  const large = noisy(icosphere(10, 6), 0.02);
  const sphereOp = sculpt({ stamps: STROKE, symmetry: 'xz' });
  const gridOp = sculpt({ stamps: [[5, 5, 0.1]], symmetry: 'xz' });

  native('up to 15,000 triangles sculpt stays in process, above it goes native, with the same result', async () => {
    expect([small, wavyGrid(86), wavyGrid(87), middle, large].map((mesh) => mesh.indices.length / 3)).toEqual([
      5_120, 14_792, 15_138, 20_480, 81_920,
    ]);
    for (const [mesh, op, by] of [
      [small, sphereOp, 'ts'],
      [wavyGrid(86), gridOp, 'ts'],
      [wavyGrid(87), gridOp, 'native'],
      [middle, sphereOp, 'native'],
      [large, sphereOp, 'native'],
    ] as const) {
      const routed = await resolveDeferred(() => composite().run({ mesh }, op));
      expect(isEngineFailure(routed) ? routed : provenanceOf(routed), `${mesh.indices.length / 3} triangles`).toBe(by);
      const oracle = tsMeshEngine.run({ mesh }, op) as MeshOpResult;
      expect(hashOf((routed as MeshOpResult).mesh as MeshData)).toBe(hashOf(oracle.mesh as MeshData));
      expect((routed as MeshOpResult).report).toEqual(oracle.report);
    }
  });

  native('outside the resolving host path the native engine hands over, so the in-process answer still works', () => {
    _clearResultCache();
    const answered = composite().run({ mesh: large }, sculpt({ stamps: STROKE, brush: 'crease' }));
    expect(provenanceOf(answered)).toBe('ts');
  });

  native(
    'a job the native engine cannot take (a NaN strength, a result that is not finite) falls back to the TypeScript engine, which answers alike',
    async () => {
      for (const strength of [Number.NaN, 1e308]) {
        const op = sculpt({ stamps: STROKE, strength });
        expect(await nativeRun({ mesh: middle }, op), `strength ${strength}`).toMatchObject({ code: 'MESH_ENGINE_UNSUPPORTED' });
        const routed = await resolveDeferred(() => composite().run({ mesh: middle }, op));
        expect(provenanceOf(routed)).toBe('ts');
        expect(hashOf((routed as MeshOpResult).mesh as MeshData)).toBe(
          hashOf((tsMeshEngine.run({ mesh: middle }, op) as MeshOpResult).mesh as MeshData),
        );
      }
    },
    60_000,
  );

  native('the cap: 4,000,000 triangles, listed by the composite and refused by name above it', () => {
    expect(composite().capabilities().get('sculpt')).toBe(4_000_000);
    const huge = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(4_000_001 * 3).fill(0) };
    expect(composite().run({ mesh: huge }, sculpt())).toMatchObject({ code: 'MESH_ENGINE_CAP_EXCEEDED' });
  });

  native('the native answer carries the version and the algorithm of the TypeScript one in its provenance', async () => {
    const answer = (await nativeRun({ mesh: small }, sculpt({ brush: 'crease', stamps: STROKE }))) as MeshOpResult;
    expect(answer.provenance).toMatchObject({ engine: 'native', deterministic: true, version: expect.stringContaining('llull-compute@') });
    expect(answer.provenance.algorithm).toContain('sculpt brush crease');
  });
});
