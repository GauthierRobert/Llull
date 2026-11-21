/** 08 ASC M3: broad phase (BVH + OBB), mesh narrow phase, exact branch, symmetry reduction, pair cache, connection groups, fastener tag. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createResolveMemo } from '@core/commands/resolveMemo';
import type { ExecutionContext } from '@core/commands/types';
import type { CheckItem, CheckResult } from '@core/model/checkResult';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { AssemblyPart } from '@core/geometry/assemblyCheck/partTypes';
import { broadPhasePairs } from '@core/geometry/assemblyCheck/broadPhase';
import { candidatePairs } from '@core/geometry/assemblyCheck/pairClassify';
import { obbOfMesh, obbsSeparated } from '@core/geometry/assemblyCheck/obb';
import { meshClearPairs } from '@core/geometry/assemblyCheck/meshNarrowPhase';
import { createPairCache, pairCacheOnMemo } from '@core/geometry/assemblyCheck/pairCache';
import { meshBvhEngine } from '@core/geometry/geometryQueries';
import { tsSpatialIndex } from '@core/geometry/spatialIndex';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

type Data = CheckResult & {
  pairsChecked: number;
  narrowPhase: { mode: string; exactKernel: boolean; candidates: number; meshCulled: number; classified: number };
  symmetry: { mode: string; patterns: number; expanded: boolean; pairsSkipped: number; cacheHits: number; pairsEvaluated: number };
  connections: Array<{ id: string; members: number; links: number; stale: string[] }>;
};

const withKernel = (k: GeometryKernel, extra: Partial<ExecutionContext> = {}): ExecutionContext => ({
  ...defaultContext(),
  kernel: k,
  ...extra,
});

function scene(): {
  doc: () => CadDocument;
  run: (name: string, params: Record<string, unknown>) => [string, ...string[]];
  check: (p?: Record<string, unknown>, c?: ExecutionContext) => Data;
} {
  let doc = createEmptyDocument();
  return {
    doc: () => doc,
    run: (name, params) => {
      const result = execute(doc, name, params, withKernel(kernel));
      expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
      expect(result.affected.length, result.summary).toBeGreaterThan(0);
      doc = result.document;
      return [...result.affected] as [string, ...string[]];
    },
    check: (params = {}, ctx = withKernel(kernel)) => {
      const result = execute(doc, 'check_assembly', params, ctx);
      expect(result.data, result.summary).toBeDefined();
      return result.data as Data;
    },
  };
}

const box = (position: [number, number, number], side = 10): Record<string, unknown> => ({ size: [side, side, side], position });
const codes = (data: Data): string[] => data.items.map((item) => item.code);

/** A kernel that counts its distance / intersect work. */
function counting(base: GeometryKernel, patch: Partial<GeometryKernel> = {}): { kernel: GeometryKernel; distances: () => number } {
  let distances = 0;
  const wrapped: GeometryKernel = {
    ...base,
    supports: (op) => base.supports(op),
    evaluate: (recipe) => base.evaluate(recipe),
    tessellate: (shape, options) => base.tessellate(shape, options),
    topology: (shape) => base.topology(shape),
    exportStep: (shapes) => base.exportStep(shapes),
    ...(base.analyze === undefined
      ? {}
      : { analyze: (shape: Parameters<NonNullable<GeometryKernel['analyze']>>[0]) => base.analyze?.(shape) ?? null }),
    distance: (a, b, max) => (distances++, base.distance?.(a, b, max) ?? null),
    ...patch,
  };
  return { kernel: wrapped, distances: () => distances };
}

function meshOf(min: [number, number, number], max: [number, number, number]): AssemblyPart['mesh'] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  };
}

const partOf = (id: string, min: [number, number, number], max: [number, number, number]): AssemblyPart =>
  ({ id, min, max, mesh: meshOf(min, max) }) as unknown as AssemblyPart;

describe('broad phase (BVH + OBB, TR-ASC-07)', () => {
  it('the BVH path (>= 200 parts) returns the pairs of the sweep, an OBB only removes pairs', () => {
    const parts = Array.from({ length: 260 }, (_, k) => {
      const x = (k % 20) * 9;
      const y = Math.floor(k / 20) * 9;
      return partOf(`p${k}`, [x, y, 0], [x + 10, y + 10, 10]);
    });
    const sweep = candidatePairs(parts, 0.5);
    const bvh = broadPhasePairs(parts, 0.5, tsSpatialIndex);
    expect(bvh).toEqual(sweep);
    expect(bvh.length).toBeGreaterThan(260);
    expect(broadPhasePairs(parts.slice(0, 50), 0.5)).toEqual(candidatePairs(parts.slice(0, 50), 0.5));
  });

  it('drops two diagonal bars whose axis-aligned boxes overlap but whose oriented boxes are apart', () => {
    const bar = (shift: number): NonNullable<AssemblyPart['mesh']> => {
      const along = [0, 10, 20, 30, 40].flatMap((t) => [t, t + shift, 0, t + 1, t + 1 + shift, 0, t, t + shift, 1]);
      return {
        positions: along,
        indices: along.map((_, i) => i).slice(0, Math.floor(along.length / 3) - (Math.floor(along.length / 3) % 3)),
      };
    };
    const a = { id: 'a', min: [0, 0, 0], max: [41, 41, 1], mesh: bar(0) } as unknown as AssemblyPart;
    const b = { id: 'b', min: [0, 8, 0], max: [41, 49, 1], mesh: bar(8) } as unknown as AssemblyPart;
    expect(candidatePairs([a, b], 0.1)).toEqual([[0, 1]]);
    expect(broadPhasePairs([a, b], 0.1)).toEqual([]);
    const [boxA, boxB] = [obbOfMesh(a.mesh), obbOfMesh(b.mesh)];
    expect(obbsSeparated(boxA!, boxB!, 0)).toBe(true);
    expect(obbsSeparated(boxA!, boxB!, 20)).toBe(false);
  });

  it('keeps a pair with a missing mesh and gives no box for an empty mesh', () => {
    expect(obbOfMesh(null)).toBeNull();
    expect(obbOfMesh({ positions: [], indices: [] })).toBeNull();
    const a = { id: 'a', min: [0, 0, 0], max: [1, 1, 1], mesh: null } as unknown as AssemblyPart;
    const b = partOf('b', [0.5, 0, 0], [2, 1, 1]);
    expect(broadPhasePairs([a, b], 0)).toEqual([[0, 1]]);
  });
});

describe('mesh narrow phase (TR-ASC-08)', () => {
  it('clears far pairs, keeps close pairs, nested boxes and parts without a mesh', () => {
    const near = [partOf('a', [0, 0, 0], [10, 10, 10]), partOf('b', [10.1, 0, 0], [20, 10, 10])];
    const far = [partOf('a', [0, 0, 0], [10, 10, 10]), partOf('c', [500, 0, 0], [510, 10, 10])];
    expect(meshClearPairs(near, [[0, 1]], 0.001, meshBvhEngine)).toEqual([false]);
    expect(meshClearPairs(far, [[0, 1]], 0.001, meshBvhEngine)).toEqual([true]);
    const nested = [partOf('outer', [0, 0, 0], [100, 100, 100]), partOf('inner', [40, 40, 40], [60, 60, 60])];
    expect(meshClearPairs(nested, [[0, 1]], 0.001, meshBvhEngine)).toEqual([false]);
    const bare = [partOf('a', [0, 0, 0], [10, 10, 10]), { ...partOf('b', [500, 0, 0], [510, 10, 10]), mesh: null } as AssemblyPart];
    expect(meshClearPairs(bare, [[0, 1]], 0.001, meshBvhEngine)).toEqual([false]);
    expect(meshClearPairs(far, [], 0.001, meshBvhEngine)).toEqual([]);
  });

  it('the batch port decides: a pair the engine finds far never reaches the kernel, else it is classified', () => {
    const s = scene();
    s.run('add_box', box([0, 0, 0]));
    s.run('add_box', box([6, 0, 0]));
    const batches: number[] = [];
    const engine = {
      ...meshBvhEngine,
      placedDistanceBatch: (
        _meshes: Parameters<typeof meshBvhEngine.placedDistanceBatch>[0],
        queries: Parameters<typeof meshBvhEngine.placedDistanceBatch>[1],
      ) => (batches.push(queries.length), queries.map(() => null)),
    };
    const culled = counting(kernel);
    const data = s.check({}, withKernel(culled.kernel, { geometryQueries: engine }));
    expect(batches).toEqual([1]);
    expect(culled.distances()).toBe(0);
    expect(data.narrowPhase).toMatchObject({ mode: 'auto', candidates: 1, meshCulled: 1, classified: 0 });
    expect(codes(data)).not.toContain('FPR_PAIR_HARD');
    const kept = counting(kernel);
    const normal = s.check({}, withKernel(kept.kernel));
    expect(normal.narrowPhase).toMatchObject({ candidates: 1, meshCulled: 0, classified: 1 });
    expect(kept.distances()).toBe(1);
    expect(codes(normal)).toContain('FPR_PAIR_HARD');
  });
});

describe('narrow phase exact branch (kernel-optional)', () => {
  const exactKernel = (): { kernel: GeometryKernel; distances: () => number } =>
    counting(kernel, { name: 'occt', info: () => ({ active: 'occt-native', capabilities: ['analyze', 'distance'] }) });

  it('auto on the mesh kernel reports exactKernel false; an exact kernel reports true and classifies the same pairs', () => {
    const s = scene();
    s.run('add_box', box([0, 0, 0]));
    s.run('add_box', box([6, 0, 0]));
    const mesh = s.check();
    expect(mesh.narrowPhase.exactKernel).toBe(false);
    const exact = exactKernel();
    const data = s.check({}, withKernel(exact.kernel));
    expect(data.narrowPhase.exactKernel).toBe(true);
    expect(codes(data)).toEqual(codes(mesh));
    expect(exact.distances()).toBe(1);
  });

  it('narrowPhase "exact" needs the exact kernel: not_run on the mesh kernel, classified with one', () => {
    const s = scene();
    s.run('add_box', box([0, 0, 0]));
    s.run('add_box', box([6, 0, 0]));
    const refused = s.check({ narrowPhase: 'exact' });
    expect(codes(refused)).toContain('FPR_KERNEL_UNSUPPORTED');
    expect(codes(refused)).not.toContain('FPR_PAIR_HARD');
    expect(refused.items.find((item) => item.code === 'FPR_KERNEL_UNSUPPORTED')?.status).toBe('not_run');
    expect(codes(s.check({ narrowPhase: 'exact' }, withKernel(exactKernel().kernel)))).toContain('FPR_PAIR_HARD');
  });
});

describe('symmetry reduction and pair cache (TR-ASC-09 / 10)', () => {
  const ring = (): ReturnType<typeof scene> => {
    const s = scene();
    const [seed] = s.run('add_box', box([20, 0, 0], 12));
    s.run('array_polar', { id: seed, count: 12, center: [0, 0, 0], as: 'instances' });
    return s;
  };
  const close = (a: CheckItem, b: CheckItem): void => {
    expect(a.code).toBe(b.code);
    expect(a.ids).toEqual(b.ids);
    for (const [key, value] of Object.entries(a.values))
      if (key !== 'penetrationEstimateMm') expect(b.values[key] ?? NaN).toBeCloseTo(value, 6);
  };

  it('a 12-fold ring evaluates one class and reports every concrete pair, equal to the audit run', () => {
    const s = ring();
    const spy = counting(kernel);
    const auto = s.check({}, withKernel(spy.kernel));
    const autoCalls = spy.distances();
    const audit = counting(kernel);
    const off = s.check({ symmetry: 'off' }, withKernel(audit.kernel));
    expect(auto.symmetry).toMatchObject({ mode: 'auto', patterns: 1, expanded: true, pairsEvaluated: 1, pairsSkipped: 11 });
    expect(autoCalls).toBe(1);
    expect(off.symmetry).toMatchObject({ mode: 'off', patterns: 0, pairsSkipped: 0 });
    expect(audit.distances()).toBe(12);
    const hard = (data: Data): CheckItem[] => data.items.filter((item) => item.code === 'FPR_PAIR_HARD');
    expect(hard(auto)).toHaveLength(12);
    hard(auto).forEach((item, i) => close(item, hard(off)[i] as CheckItem));
    expect(auto.items.map((item) => item.code)).toEqual(off.items.map((item) => item.code));
  });

  it('a linear instance row maps (i, i + 1) pairs to one class; scaled instances are not reduced', () => {
    const s = scene();
    const [seed] = s.run('add_box', box([0, 0, 0]));
    s.run('array_linear', { id: seed, count: 6, offset: [8, 0, 0], as: 'instances' });
    expect(s.check().symmetry).toMatchObject({ pairsEvaluated: 1, pairsSkipped: 4 });
    const scaled = scene();
    const [seed2] = scaled.run('add_box', box([0, 0, 0]));
    const made = execute(scaled.doc(), 'array_linear', { id: seed2, count: 3, offset: [8, 0, 0], as: 'instances' }, withKernel(kernel));
    const entities = { ...made.document.entities };
    for (const id of made.affected) entities[id] = { ...entities[id], scale: [1, 1, 1.0001] } as never;
    const data = execute({ ...made.document, entities }, 'check_assembly', {}, withKernel(kernel)).data as Data;
    expect(data.symmetry.pairsSkipped).toBe(0);
  });

  it('a host pair cache serves the second run: no kernel call, same items; cache false and a resolveMemo behave', () => {
    const s = ring();
    const cache = createPairCache(100);
    const first = s.check({}, withKernel(kernel, { pairCache: cache }));
    expect(first.symmetry.cacheHits).toBe(0);
    const spy = counting(kernel);
    const second = s.check({}, withKernel(spy.kernel, { pairCache: cache }));
    expect(spy.distances()).toBe(0);
    expect(second.symmetry).toMatchObject({ cacheHits: 1, pairsEvaluated: 0 });
    expect(second.items.map((item) => item.findingKey)).toEqual(first.items.map((item) => item.findingKey));
    const uncached = counting(kernel);
    s.check({ cache: false }, withKernel(uncached.kernel, { pairCache: cache }));
    expect(uncached.distances()).toBe(1);
    const memo = createResolveMemo();
    const ctx = withKernel(kernel, { resolveMemo: memo });
    expect(s.check({}, ctx).symmetry.cacheHits).toBe(0);
    expect(s.check({}, ctx).symmetry.cacheHits).toBe(1);
  });

  it('the cache is keyed by content: another tolerance misses, an evicted entry is recomputed', () => {
    const s = ring();
    const cache = createPairCache(1);
    s.check({}, withKernel(kernel, { pairCache: cache }));
    expect(s.check({ touchToleranceMm: 0.5 }, withKernel(kernel, { pairCache: cache })).symmetry.cacheHits).toBe(0);
    const direct = pairCacheOnMemo(createResolveMemo(), kernel);
    expect(direct.getOrCompute('k', () => ({ pair: undefined })).hit).toBe(false);
    expect(direct.getOrCompute('k', () => ({ pair: undefined })).hit).toBe(true);
  });

  it('an unrelated pair of plain parts is cached by recipe hashes across runs', () => {
    const s = scene();
    s.run('add_box', box([0, 0, 0]));
    s.run('add_box', box([6, 0, 0]));
    const cache = createPairCache();
    s.check({}, withKernel(kernel, { pairCache: cache }));
    expect(s.check({}, withKernel(kernel, { pairCache: cache })).symmetry.cacheHits).toBe(1);
  });
});

describe('connection groups (TR-ASC-11, D2)', () => {
  it('add / delete: ids, patterns, layers, groups; stored in doc.prototype.connections; pure', () => {
    const s = scene();
    const [a] = s.run('add_box', box([0, 0, 0]));
    const [b] = s.run('add_box', box([10, 0, 0]));
    const before = JSON.stringify(s.doc());
    const [id] = s.run('add_connection_group', { name: 'bolts', kind: 'bolted', members: { ids: [a, b] }, reason: 'M8 bolts' });
    expect(id).toMatch(/^conn-\d+\.\d+$/);
    expect(s.doc().prototype?.connections?.[id as string]).toMatchObject({ kind: 'bolted', declaredBy: 'agent', reason: 'M8 bolts' });
    const again = execute(createEmptyDocument(), 'add_connection_group', {
      name: 'x',
      kind: 'welded',
      members: { ids: [a, b] },
      reason: 'r',
    });
    expect(again.error?.code).toBe('CONN_UNKNOWN_MEMBER');
    expect(JSON.stringify(s.doc())).not.toBe(before);
    s.run('delete_connection_group', { id });
    expect(s.doc().prototype?.connections).toEqual({});
    const [layer] = Object.keys(s.doc().layers);
    s.run('add_connection_group', { name: 'layer', kind: 'bonded', members: { layerId: layer }, reason: 'glued' });
    s.run('group_entities', { ids: [a, b], name: 'pair' });
    const group = Object.keys(s.doc().groups)[0];
    s.run('add_connection_group', {
      name: 'grp',
      kind: 'welded',
      members: { groupId: group },
      detect: { toleranceMm: 1, faceAngleDeg: 5, cylindrical: 'include' },
      reason: 'weld',
    });
  });

  it('rejects empty reason, no or several selectors, unknown members, 2D members and too few parts; is a no-op', () => {
    const s = scene();
    const [a] = s.run('add_box', box([0, 0, 0]));
    const [b] = s.run('add_box', box([10, 0, 0]));
    const [line] = s.run('draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    const doc = s.doc();
    const fail = (params: Record<string, unknown>, code: string): void => {
      const result = execute(doc, 'add_connection_group', { name: 'g', kind: 'bolted', reason: 'why', ...params }, withKernel(kernel));
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe(code);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    };
    fail({ members: { ids: [a, b] }, reason: '  ' }, 'CONN_REASON_EMPTY');
    fail({ members: {} }, 'CONN_MEMBERS_EMPTY');
    fail({ members: { ids: [a, b], layerId: 'x' } }, 'CONN_MEMBERS_EMPTY');
    fail({ members: { ids: [a, 'ghost'] } }, 'CONN_UNKNOWN_MEMBER');
    fail({ members: { patternOf: 'ghost' } }, 'CONN_UNKNOWN_MEMBER');
    fail({ members: { layerId: 'ghost' } }, 'CONN_UNKNOWN_MEMBER');
    fail({ members: { groupId: 'ghost' } }, 'CONN_UNKNOWN_MEMBER');
    fail({ members: { ids: [a, line] } }, 'CONN_UNKNOWN_MEMBER');
    fail({ members: { ids: [a] } }, 'CONN_MEMBERS_EMPTY');
    const missing = execute(doc, 'delete_connection_group', { id: 'conn-9.9' }, withKernel(kernel));
    expect(missing.document).toBe(doc);
    expect(missing.affected).toEqual([]);
  });

  it('a group connects touching parts (no RESTING_ONLY); without it touching faces stay resting-only (D2)', () => {
    const s = scene();
    const [base] = s.run('add_box', box([0, 0, 0]));
    const [top] = s.run('add_box', box([0, 0, 10]));
    s.run('set_part_grounded', { ids: [base], grounded: true });
    expect(codes(s.check())).toContain('FPR_PART_RESTING_ONLY');
    s.run('add_connection_group', { name: 'g', kind: 'bolted', members: { ids: [base, top] }, reason: 'bolted flange' });
    const data = s.check();
    expect(codes(data)).not.toContain('FPR_PART_RESTING_ONLY');
    expect(codes(data)).not.toContain('FPR_PART_FLOATING');
    expect(data.connections).toEqual([expect.objectContaining({ members: 2, links: 1, stale: [] })]);
  });

  it('patternOf follows the pattern: a group on the seed connects every instance', () => {
    const s = scene();
    const [plate] = s.run('add_box', { size: [200, 20, 5], position: [0, 0, -7.5] });
    const [box0] = s.run('add_box', box([-80, 0, 0]));
    const [seed] = s.run('array_linear', { id: box0, count: 4, offset: [50, 0, 0], as: 'instances' });
    s.run('set_part_grounded', { ids: [plate], grounded: true });
    const loose = s.check();
    expect(codes(loose)).toContain('FPR_PART_RESTING_ONLY');
    s.run('add_connection_group', { name: 'feet', kind: 'bolted', members: { patternOf: seed }, reason: 'feet' });
    s.run('add_connection_group', { name: 'plate', kind: 'welded', members: { ids: [plate, seed] }, reason: 'weld' });
    const data = s.check();
    expect(data.connections.find((g) => g.members === 4)).toBeDefined();
    expect(codes(data)).not.toContain('FPR_PART_FLOATING');
    expect(codes(data)).not.toContain('FPR_PART_RESTING_ONLY');
  });

  it('detect joins only member pairs that touch with facing faces within the tolerance and the cylindrical rule', () => {
    const build = (detect: Record<string, unknown>): { data: Data; ids: string[] } => {
      const s = scene();
      const [base] = s.run('add_box', box([0, 0, 0]));
      const [top] = s.run('add_box', box([0, 0, 10]));
      const [far] = s.run('add_box', box([0, 0, 40]));
      const [rod] = s.run('add_cylinder', { radius: 2, height: 10, position: [30, 0, 0] });
      const [rod2] = s.run('add_cylinder', { radius: 2, height: 10, position: [34, 0, 0] });
      s.run('set_part_grounded', { ids: [base, rod], grounded: true });
      s.run('add_connection_group', { name: 'g', kind: 'bolted', members: { ids: [base, top, far, rod, rod2] }, detect, reason: 'r' });
      return { data: s.check(), ids: [base, top, far, rod, rod2] };
    };
    const linked = (run: { data: Data; ids: string[] }): string[] => {
      const open = run.data.items.filter((i) => i.code === 'FPR_PART_FLOATING' || i.code === 'FPR_PART_RESTING_ONLY').flatMap((i) => i.ids);
      return run.ids.filter((id) => !open.includes(id));
    };
    const include = build({ toleranceMm: 0.1, faceAngleDeg: 20, cylindrical: 'include' });
    expect(include.data.connections[0]?.links).toBe(2);
    const [base, top, far, rod, rod2] = include.ids;
    expect(linked(include)).toEqual(expect.arrayContaining([base, top, rod, rod2]));
    expect(linked(include)).not.toContain(far);
    const exclude = build({ toleranceMm: 0.1, faceAngleDeg: 20, cylindrical: 'exclude' });
    expect(exclude.data.connections[0]?.links).toBe(1);
    expect(linked(exclude)).toContain(top);
    expect(linked(exclude)).not.toContain(rod2);
    const only = build({ toleranceMm: 0.1, faceAngleDeg: 20, cylindrical: 'only' });
    expect(only.data.connections[0]?.links).toBe(1);
    expect(linked(only)).toContain(rod2);
    expect(linked(only)).not.toContain(top);
    const wrongAngle = build({ toleranceMm: 0.1, faceAngleDeg: 0, cylindrical: 'include' });
    expect(wrongAngle.data.connections[0]?.links).toBe(1);
    const tight = build({ toleranceMm: 1e-9, faceAngleDeg: 20, cylindrical: 'include' });
    expect(tight.data.connections[0]?.links).toBeLessThanOrEqual(2);
  });

  it('a stale member is FPR_CONN_STALE (warn) and ignored', () => {
    const s = scene();
    const [a] = s.run('add_box', box([0, 0, 0]));
    const [b] = s.run('add_box', box([10, 0, 0]));
    const [c] = s.run('add_box', box([20, 0, 0]));
    s.run('add_connection_group', { name: 'g', kind: 'bolted', members: { ids: [a, b, c] }, reason: 'r' });
    s.run('delete_entities', { ids: [c] });
    const data = s.check();
    const stale = data.items.find((item) => item.code === 'FPR_CONN_STALE');
    expect(stale?.status).toBe('warn');
    expect(stale?.ids).toEqual([c]);
    expect(data.connections[0]).toMatchObject({ members: 2, stale: [c] });
  });
});

describe('fastener tag (FR-ASC-12)', () => {
  it('set_fastener tags and clears; refuses unknown / 2D / no change', () => {
    const s = scene();
    const [a] = s.run('add_box', box([0, 0, 0]));
    const [line] = s.run('draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    s.run('set_fastener', { ids: [a], fastener: true });
    expect(s.doc().entities[a]?.fastener).toBe(true);
    const doc = s.doc();
    for (const params of [
      { ids: [a], fastener: true },
      { ids: ['ghost'], fastener: true },
      { ids: [line], fastener: true },
      { ids: [a, a], fastener: true },
    ]) {
      const result = execute(doc, 'set_fastener', params, withKernel(kernel));
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    s.run('set_fastener', { ids: [a], fastener: false });
    expect('fastener' in (s.doc().entities[a] ?? {})).toBe(false);
  });

  it('a fastener overlapping its host is FPR_FASTENER_THREAD (info, still a link); two plain parts stay a clash', () => {
    const s = scene();
    const [host] = s.run('add_box', box([0, 0, 0], 20));
    const [screw] = s.run('add_box', box([5, 5, 5], 10));
    const clash = s.check();
    expect(codes(clash)).toContain('FPR_PAIR_CONTAINED');
    s.run('set_fastener', { ids: [screw], fastener: true });
    s.run('set_part_grounded', { ids: [host], grounded: true });
    const data = s.check();
    const thread = data.items.find((item) => item.code === 'FPR_FASTENER_THREAD');
    expect(thread?.status).toBe('info');
    expect(thread?.ids).toEqual([host, screw].sort());
    expect(codes(data)).not.toContain('FPR_PAIR_CONTAINED');
    expect(codes(data)).not.toContain('FPR_PART_FLOATING');
  });
});
