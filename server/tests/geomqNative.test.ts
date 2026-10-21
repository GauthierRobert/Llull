/**
 * VC-FPR-37 and VC-THM-64 (RS1 RS-6): the native `GeometryQueryEngine` (`llull-compute geomq`) against the TypeScript engine, which is the
 * oracle. Engine batches on seeded meshes, then the three callers end to end: check_assembly thickness rays, compute_view_factors with and
 * without obstruction (VC-THM-09 plates + an obstructed cavity), check_motion_clearance on the analytic bar (VC-FPR-18 / 19) with the
 * up-front distance batch. Every number must be identical, only the provenance differs. Native runs need llull-compute (cargo build in
 * solver/) and are skipped with a logged reason otherwise; the fallback and installation tests always run.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { getGeometryQueryEngine, meshBvhEngine, setGeometryQueryEngine } from '@core/geometry/geometryQueries';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { RigidTransform } from '@core/geometry/meshBvh';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { type CadDocument, type MeshData, type Vec3, createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { NATIVE_GEOMETRY_LIMITS, createNativeGeometryQueryEngine, installGeometryQueryEngine } from '../src/native/geometryQueryEngine';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('geomqNative: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? meshBvhEngine : createNativeGeometryQueryEngine(BINARY);

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const ctxOf = (geometryQueries: ExecutionContext['geometryQueries'] = null): ExecutionContext => ({
  ...defaultContext(),
  kernel,
  geometryQueries,
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Latitude-longitude sphere, radius jittered per vertex. */
function noisySphere(random: () => number, center: Vec3, radius: number, rings: number, segments: number): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j < segments; j++) {
      const [polar, azimuth] = [(Math.PI * i) / rings, (2 * Math.PI * j) / segments];
      const r = radius * (1 + 0.3 * (random() - 0.5));
      positions.push(
        center[0] + r * Math.sin(polar) * Math.cos(azimuth),
        center[1] + r * Math.sin(polar) * Math.sin(azimuth),
        center[2] + r * Math.cos(polar),
      );
    }
  }
  const at = (i: number, j: number): number => i * segments + (j % segments);
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
  return { positions, indices };
}

const turn = (deg: number, translation: Vec3): RigidTransform => {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return { rotation: [c, -s, 0, s, c, 0, 0, 0, 1], translation };
};

describe('native geometry query engine = TypeScript engine (VC-FPR-37)', () => {
  const random = seeded(37);
  const meshes = [noisySphere(random, [0, 0, 0], 10, 24, 36), noisySphere(random, [3, 0, 0], 5, 12, 18)];

  native('names itself, lifts the TS caps and is deterministic', () => {
    expect(engine.provenance).toEqual({ engine: 'llull-geomq', device: 'cpu', deterministic: true });
    expect(engine.limits).toBe(NATIVE_GEOMETRY_LIMITS);
    expect(engine.limits.maxViewFactorFacets).toBeGreaterThan(meshBvhEngine.limits.maxViewFactorFacets);
    expect(engine.limits.maxThicknessRays).toBeGreaterThan(meshBvhEngine.limits.maxThicknessRays);
  });

  native('placed distances and pose batches: same hits, distances and witnesses', () => {
    const queries = Array.from({ length: 300 }, (_, k) => ({
      a: k % 2,
      b: (k + 1) % 2,
      placement: k % 9 === 0 ? null : turn(k * 7, [((k % 13) - 6) * 4, ((k % 5) - 2) * 3, (k % 3) - 1]),
      maxDistance: k % 4 === 0 ? Infinity : (k % 7) * 2,
    }));
    expect(engine.placedDistanceBatch(meshes, queries)).toEqual(meshBvhEngine.placedDistanceBatch(meshes, queries));
    const poses = [
      [null, turn(30, [20, 0, 0])],
      [turn(10, [1, 2, 3]), null],
    ];
    expect(engine.minDistanceBatch(meshes, poses, [[0, 1]], 100)).toEqual(meshBvhEngine.minDistanceBatch(meshes, poses, [[0, 1]], 100));
    expect(engine.placedDistanceBatch(meshes, [])).toEqual([]);
  });

  native('rays: same t, triangle and point; misses stay null', () => {
    const [mesh] = meshes as [MeshData];
    const rays = Array.from({ length: 500 }, (_, k) => ({
      origin: [((k % 11) - 5) * 3, ((k % 7) - 3) * 3, ((k % 5) - 2) * 3] as Vec3,
      direction: [Math.cos(k), Math.sin(k), Math.cos(3 * k)] as Vec3,
      tMin: k % 2 === 0 ? 0 : 1e-6,
    }));
    const hits = engine.rayCastBatch(mesh, rays, Infinity);
    expect(hits).toEqual(meshBvhEngine.rayCastBatch(mesh, rays, Infinity));
    expect(hits.filter((hit) => hit === null).length).toBeGreaterThan(0);
    expect(engine.rayCastBatch(mesh, rays.slice(0, 20), 4)).toEqual(meshBvhEngine.rayCastBatch(mesh, rays.slice(0, 20), 4));
    expect(engine.rayCastBatch(mesh, [], 1)).toEqual([]);
  });
});

type V3 = [number, number, number];
const quad = (name: string, ring: V3[]): { name: string; vertices: V3[] } => ({ name, vertices: ring });

describe('callers through the native engine (VC-THM-64, VC-FPR-37)', () => {
  const withoutProvenance = (data: unknown): unknown =>
    Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([key]) => key !== 'geometryQueries'));

  native(
    'compute_view_factors: VC-THM-09 plates and an obstructed cavity give the TS matrix',
    () => {
      const plates = [
        quad('floor', [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ]),
        quad('ceiling', [
          [0, 0, 1],
          [0, 1, 1],
          [1, 1, 1],
          [1, 0, 1],
        ]),
        quad('wall', [
          [0, 0, 0],
          [0, 0, 1],
          [1, 0, 1],
          [1, 0, 0],
        ]),
      ];
      const blocker = {
        vertices: [
          [0.1, 0.45, 0.2],
          [0.1, 0.55, 0.8],
          [0.9, 0.5, 0.8],
          [0.9, 0.4, 0.2],
        ] as V3[],
      };
      for (const extra of [{}, { obstruction: true }, { obstruction: true, blockers: [blocker] }]) {
        const params = { lengthUnit: 'm', surfaces: plates, maxFacetSize: { value: 0.4, unit: 'm' }, ...extra };
        const viaNative = execute(createEmptyDocument(), 'compute_view_factors', params, ctxOf(engine));
        const viaTs = execute(createEmptyDocument(), 'compute_view_factors', params, ctxOf());
        expect(viaNative.rejected, viaNative.summary).toBeUndefined();
        expect(withoutProvenance(viaNative.data)).toEqual(withoutProvenance(viaTs.data));
        if ('obstruction' in extra) expect((viaNative.data as Record<string, unknown>)['geometryQueries']).toEqual(engine.provenance);
      }
      const open = execute(createEmptyDocument(), 'compute_view_factors', { lengthUnit: 'm', surfaces: plates.slice(0, 2) }, ctxOf(engine));
      expect((open.data as { matrix: number[][] }).matrix[0]?.[1]).toBeCloseTo(0.199825, 5);
    },
    120_000,
  );

  native('check_assembly: wall-thickness rays give the TS statistics', () => {
    let doc = createEmptyDocument();
    for (const [name, params] of [
      ['add_box', { size: [40, 30, 4], position: [0, 0, 0] }],
      ['add_cylinder', { radius: 6, height: 25, position: [60, 0, 0] }],
    ] as const) {
      const result = execute(doc, name, params, ctxOf());
      expect(result.rejected).toBeUndefined();
      doc = result.document;
    }
    const params = { minWallMm: 5, raysPerPart: 400 };
    const viaNative = execute(doc, 'check_assembly', params, ctxOf(engine));
    const viaTs = execute(doc, 'check_assembly', params, ctxOf());
    expect((viaNative.data as Record<string, unknown>)['geometryQueries']).toEqual(engine.provenance);
    expect(withoutProvenance(viaNative.data)).toEqual(withoutProvenance(viaTs.data));
  });

  native('check_motion_clearance: VC-FPR-18 / 19 on the analytic bar through the up-front native batch', () => {
    const step = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => {
      const result = execute(doc, name, params, ctxOf());
      expect(result.rejected, result.summary).toBeUndefined();
      return result.document;
    };
    for (const faceX of [105, 95]) {
      let doc = step(createEmptyDocument(), 'add_box', { size: [100, 10, 10], position: [50, 0, 0] });
      const bar = Object.keys(doc.entities)[0] ?? '';
      doc = step(doc, 'add_box', { size: [20, 400, 40], position: [faceX + 10, 0, 0] });
      doc = step(doc, 'add_rigid_body', { id: 'bar_body', entityIds: [bar], massKg: 1 });
      doc = step(doc, 'add_body_joint', {
        id: 'bar_j',
        kind: 'revolute',
        child: 'bar_body',
        anchor: [0, 0, 0],
        axis: [0, 0, 1],
        initialRpm: 60,
      });
      const params = { crankAxis: 'bar_j', duration: 1, sampleRate: 360 };
      const viaNative = execute(doc, 'check_motion_clearance', params, ctxOf(engine));
      expect(JSON.stringify(viaNative.data)).toBe(JSON.stringify(execute(doc, 'check_motion_clearance', params, ctxOf()).data));
      const data = viaNative.data as { minClearance: { mm: number } | null; status: string };
      if (faceX === 105) expect(data.minClearance?.mm).toBeCloseTo(4.8750780275, 3);
      else expect(data.status).toBe('fail');
    }
  });
});

describe('fallback and installation', () => {
  it('a binary that cannot run is logged and answered by the TS engine, whose numbers and name it reports', () => {
    const broken = createNativeGeometryQueryEngine('/nonexistent/llull-compute');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mesh = noisySphere(seeded(1), [0, 0, 0], 2, 4, 6);
      const rays = [{ origin: [0, 0, 0] as Vec3, direction: [1, 0, 0] as Vec3 }];
      expect(broken.rayCastBatch(mesh, rays, Infinity)).toEqual(meshBvhEngine.rayCastBatch(mesh, rays, Infinity));
      expect(broken.provenance).toEqual(meshBvhEngine.provenance);
      expect(broken.viewFactorExchange?.([], null)).toEqual([]);
      // not answered: compute_view_factors then runs its TypeScript reference
      expect(broken.viewFactorExchange?.([[]], null)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('geomq ray failed'));
      // a failed distance batch too large for the TS fallback throws (check_motion_clearance then skips its prefetch)
      const many = Array.from({ length: 10_001 }, () => ({ a: 0, b: 0, placement: null, maxDistance: 1 }));
      expect(() => broken.placedDistanceBatch([mesh], many)).toThrow(/too many for the TypeScript fallback/);
      expect(broken.placedDistanceBatch([mesh], many.slice(0, 3))).toEqual(meshBvhEngine.placedDistanceBatch([mesh], many.slice(0, 3)));
    } finally {
      warn.mockRestore();
    }
  });

  it('installs only when llull-compute exists, and null removes it', () => {
    const before = getGeometryQueryEngine();
    try {
      expect(installGeometryQueryEngine({ LLULL_COMPUTE: '/nonexistent/llull-compute' })).toBe(false);
      expect(getGeometryQueryEngine()).toBeNull();
      if (BINARY !== null) {
        expect(installGeometryQueryEngine({ LLULL_COMPUTE: BINARY })).toBe(true);
        expect(getGeometryQueryEngine()?.provenance.engine).toBe('llull-geomq');
      }
    } finally {
      setGeometryQueryEngine(before);
    }
  });
});
