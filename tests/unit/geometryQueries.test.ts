/** PHY-21 TR-FPR-19: GeometryQueryEngine port — default engine vs direct meshBvh, ordering, empty batches, injection into both callers. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import {
  type GeometryQueryEngine,
  getGeometryQueryEngine,
  meshBvhEngine,
  resolveGeometryQueries,
  setGeometryQueryEngine,
} from '@core/geometry/geometryQueries';
import { type RigidTransform, buildMeshBvh, bvhMinDistance, bvhRayCast } from '@core/geometry/meshBvh';
import type { GeometryKernel } from '@core/geometry/kernel';
import { type MeshData, createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

const box = (min: [number, number, number], size: number): MeshData => {
  const [x, y, z] = min;
  const positions: number[] = [];
  for (const dx of [0, size]) for (const dy of [0, size]) for (const dz of [0, size]) positions.push(x + dx, y + dy, z + dz);
  const indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return { positions, indices };
};

const near = box([0, 0, 0], 10);
const far = box([30, 0, 0], 10);
const moved = (translation: [number, number, number]): RigidTransform => ({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation });
const quarterTurnZ: RigidTransform = { rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1], translation: [5, 0, 0] };

describe('GeometryQueryEngine default engine (meshBvh)', () => {
  it('names itself and is deterministic', () => {
    expect(meshBvhEngine.provenance).toEqual({ engine: 'meshBvh', device: 'cpu', deterministic: true });
    expect(meshBvhEngine.limits).toEqual({ maxViewFactorFacets: 400, maxThicknessRays: 200_000 });
  });

  it('minDistanceBatch equals direct bvhMinDistance with the relative placement, in [pose][pair] order', () => {
    const poses = [
      [null, null],
      [moved([0, 0, 0]), moved([0, 5, 0])],
      [null, quarterTurnZ],
    ];
    const result = meshBvhEngine.minDistanceBatch([near, far], poses, [[0, 1]], 100);
    expect(result).toHaveLength(3);
    const direct = bvhMinDistance(buildMeshBvh(near), buildMeshBvh(far), 100, null);
    expect(result[0]?.[0]).toEqual(direct);
    expect(result[0]?.[0]?.distance).toBeCloseTo(20, 9);
    // mesh 1 translated by (0, 5, 0) relative to mesh 0 keeps the x gap
    expect(result[1]?.[0]?.distance).toBeCloseTo(20, 9);
    const turned = bvhMinDistance(buildMeshBvh(near), buildMeshBvh(far), 100, quarterTurnZ);
    expect(result[2]?.[0]).toEqual(turned);
  });

  it('maxDistance prunes to null and pair order follows the input', () => {
    const [row] = meshBvhEngine.minDistanceBatch(
      [near, far],
      [[null, null]],
      [
        [0, 1],
        [1, 0],
        [0, 0],
      ],
      5,
    );
    expect(row?.[0]).toBeNull();
    expect(row?.[1]).toBeNull();
    expect(row?.[2]?.distance).toBe(0);
  });

  it('rayCastBatch equals direct bvhRayCast, keeps input order and honours tMin', () => {
    const rays = [
      { origin: [-5, 5, 5] as [number, number, number], direction: [1, 0, 0] as [number, number, number] },
      { origin: [5, 5, 50] as [number, number, number], direction: [0, 0, -1] as [number, number, number] },
      { origin: [-5, 50, 5] as [number, number, number], direction: [1, 0, 0] as [number, number, number] },
      { origin: [-5, 5, 5] as [number, number, number], direction: [1, 0, 0] as [number, number, number], tMin: 8 },
    ];
    const hits = meshBvhEngine.rayCastBatch(near, rays, Infinity);
    const tree = buildMeshBvh(near);
    expect(hits).toEqual(rays.map((ray) => bvhRayCast(tree, ray.origin, ray.direction, Infinity, ray.tMin ?? 0)));
    expect(hits.map((hit) => hit?.t ?? null)).toEqual([5, 40, null, 15]);
  });

  it('segmentOcclusionBatch tests each open segment and honours skip indices', () => {
    const wall: [[number, number, number], [number, number, number], [number, number, number]] = [
      [0, -10, -10],
      [0, 10, -10],
      [0, 0, 10],
    ];
    const through = { start: [-1, 0, 0] as [number, number, number], end: [1, 0, 0] as [number, number, number], skip: [] };
    const result = meshBvhEngine.segmentOcclusionBatch([wall], [through, { ...through, end: [-0.5, 0, 0] }, { ...through, skip: [0] }]);
    expect(result).toEqual([true, false, false]);
  });

  it('empty batches return empty arrays', () => {
    expect(meshBvhEngine.minDistanceBatch([near], [], [[0, 0]], 1)).toEqual([]);
    expect(meshBvhEngine.minDistanceBatch([near], [[null]], [], 1)).toEqual([[]]);
    expect(meshBvhEngine.rayCastBatch(near, [], 1)).toEqual([]);
    expect(meshBvhEngine.segmentOcclusionBatch([], [])).toEqual([]);
  });
});

describe('installation and resolution', () => {
  it('resolve falls back to the default engine; the installed engine reaches defaultContext', () => {
    expect(resolveGeometryQueries(null)).toBe(meshBvhEngine);
    expect(resolveGeometryQueries(undefined)).toBe(meshBvhEngine);
    expect(getGeometryQueryEngine()).toBeNull();
    expect(defaultContext().geometryQueries).toBeNull();
    const fake = { ...meshBvhEngine };
    setGeometryQueryEngine(fake);
    try {
      expect(defaultContext().geometryQueries).toBe(fake);
      expect(resolveGeometryQueries(getGeometryQueryEngine())).toBe(fake);
    } finally {
      setGeometryQueryEngine(null);
    }
  });
});

interface Spy {
  readonly engine: GeometryQueryEngine;
  readonly calls: { rays: number; occlusion: number; segments: number };
}

/** Delegates to the default engine but counts calls, reports other provenance and caps the facet count at 4. */
function spyEngine(maxViewFactorFacets: number, maxThicknessRays = 200_000): Spy {
  const calls = { rays: 0, occlusion: 0, segments: 0 };
  const engine: GeometryQueryEngine = {
    provenance: { engine: 'fake-native', device: 'test-gpu', deterministic: false },
    limits: { maxViewFactorFacets, maxThicknessRays },
    minDistanceBatch: (...args) => meshBvhEngine.minDistanceBatch(...args),
    rayCastBatch: (mesh, rays, maxT) => {
      calls.rays += rays.length;
      return meshBvhEngine.rayCastBatch(mesh, rays, maxT);
    },
    segmentOcclusionBatch: (occluders, segments) => {
      calls.occlusion += 1;
      calls.segments += segments.length;
      return meshBvhEngine.segmentOcclusionBatch(occluders, segments);
    },
  };
  return { engine, calls };
}

type V3 = [number, number, number];
const square = (name: string, z: number, up: boolean): { name: string; vertices: V3[] } => {
  const ring: V3[] = [
    [0, 0, z],
    [1, 0, z],
    [1, 1, z],
    [0, 1, z],
  ];
  return { name, vertices: up ? ring : [...ring].reverse() };
};
const surfaces = [square('floor', 0, true), square('ceiling', 1, false)];
const blocker = {
  vertices: [
    [-1, -1, 0.5],
    [2, -1, 0.5],
    [2, 2, 0.5],
    [-1, 2, 0.5],
  ] as V3[],
};

describe('injected engine is used by compute_view_factors', () => {
  const run = (params: Record<string, unknown>, geometryQueries?: GeometryQueryEngine | null): ReturnType<typeof execute> =>
    execute(
      createEmptyDocument(),
      'compute_view_factors',
      { lengthUnit: 'm', surfaces, ...params },
      { ...defaultContext(), geometryQueries: geometryQueries ?? null },
    );
  type Out = { matrix: number[][]; geometryQueries?: GeometryQueryEngine['provenance'] };

  it('obstruction goes through the engine, results equal the default engine, provenance surfaces', () => {
    const spy = spyEngine(400);
    const injected = run({ obstruction: true, blockers: [blocker] }, spy.engine);
    const standard = run({ obstruction: true, blockers: [blocker] });
    expect(spy.calls.occlusion).toBe(1);
    expect(spy.calls.segments).toBeGreaterThan(0);
    const data = injected.data as Out;
    expect(data.geometryQueries).toEqual(spy.engine.provenance);
    expect(data.matrix).toEqual((standard.data as Out).matrix);
    expect((standard.data as Out).geometryQueries).toEqual(meshBvhEngine.provenance);
    expect(data.matrix[0]?.[1]).toBe(0);
  });

  it('without obstruction the engine is not called and no provenance is reported', () => {
    const spy = spyEngine(400);
    const result = run({}, spy.engine);
    expect(spy.calls.occlusion).toBe(0);
    expect((result.data as Out).geometryQueries).toBeUndefined();
  });

  it('the facet cap is the engine limit (TS default 400, a native engine may raise or lower it)', () => {
    const tight = run({ maxFacetSize: { value: 0.3, unit: 'm' } }, spyEngine(4).engine);
    expect(tight.rejected).toBe(true);
    expect(tight.error?.code).toBe('THM_FACET_LIMIT');
    expect(run({}, spyEngine(4).engine).rejected).toBeUndefined();
    const refined = { maxFacetSize: { value: 0.3, unit: 'm' } };
    expect(run(refined).rejected).toBeUndefined();
    expect(run({}, null).rejected).toBeUndefined();
  });
});

describe('injected engine is used by check_assembly', () => {
  let kernel: GeometryKernel;
  beforeAll(async () => {
    kernel = await createManifoldKernel();
  });
  const ctxOf = (geometryQueries?: GeometryQueryEngine | null): ExecutionContext => ({
    ...defaultContext(),
    kernel,
    geometryQueries: geometryQueries ?? null,
  });
  const sceneDoc = (): ReturnType<typeof createEmptyDocument> =>
    execute(createEmptyDocument(), 'add_box', { size: [20, 20, 20], position: [0, 0, 0] }, ctxOf()).document;

  it('wall-thickness rays go through the engine; same numbers as the default; provenance in data', () => {
    const doc = sceneDoc();
    const spy = spyEngine(400);
    const injected = execute(doc, 'check_assembly', { minWallMm: 1, raysPerPart: 50 }, ctxOf(spy.engine));
    const standard = execute(doc, 'check_assembly', { minWallMm: 1, raysPerPart: 50 }, ctxOf());
    expect(spy.calls.rays).toBeGreaterThan(0);
    const [a, b] = [injected.data as Record<string, unknown>, standard.data as Record<string, unknown>];
    expect(a['geometryQueries']).toEqual(spy.engine.provenance);
    expect(b['geometryQueries']).toEqual(meshBvhEngine.provenance);
    const without = (data: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'geometryQueries'));
    expect(without(a)).toEqual(without(b));
  });

  it('thickness off: no rays, no provenance', () => {
    const spy = spyEngine(400);
    const result = execute(sceneDoc(), 'check_assembly', {}, ctxOf(spy.engine));
    expect(spy.calls.rays).toBe(0);
    expect((result.data as Record<string, unknown>)['geometryQueries']).toBeUndefined();
  });

  it('the ray budget is the engine limit', () => {
    const result = execute(sceneDoc(), 'check_assembly', { minWallMm: 1, raysPerPart: 50 }, ctxOf(spyEngine(400, 10).engine));
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FPR_BUDGET_EXCEEDED');
    expect(result.summary).toContain('limit 10');
  });
});
