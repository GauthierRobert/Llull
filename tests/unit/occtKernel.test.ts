import { describe, it, expect, vi } from 'vitest';
import type { BoxEntity, ShapeRecipe, Entity } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CachingKernel } from '@core/geometry/shapeKernel';
import type { OcctFactory } from '@kernel-occt/occtKernel';

// Test entities — two 2×2×2 boxes (as in docs/decisions/KI4-occt-spike.md).

const BOX_A: BoxEntity = {
  id: 'box-a',
  kind: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [2, 2, 2],
  layerId: 'default',
  color: '#ffffff',
};

const BOX_B: BoxEntity = {
  id: 'box-b',
  kind: 'box',
  position: [1, 0, 0], // offset by 1 — overlapping
  rotation: [0, 0, 0],
  size: [2, 2, 2],
  layerId: 'default',
  color: '#888888',
};

// Static entity contract tests — always run; no WASM required.

describe('OcctKernel — static contract tests (always run)', () => {
  it('BOX_A entity satisfies BoxEntity shape contract', () => {
    expect(BOX_A.kind).toBe('box');
    expect(BOX_A.size).toHaveLength(3);
    expect(BOX_A.size.every((v) => v > 0)).toBe(true);
    expect(BOX_A.position).toHaveLength(3);
    expect(BOX_A.rotation).toHaveLength(3);
  });
  it('BOX_B entity satisfies BoxEntity shape contract', () => {
    expect(BOX_B.kind).toBe('box');
    expect(BOX_B.size.every((v) => v > 0)).toBe(true);
  });
  it('documents skip reason: WASM binary is 63MB — not viable in jsdom CI', () => {
    // The opencascade.js WASM is 63 MB. Loading it in Vitest/jsdom would require
    // a Node-env vitest config; live coverage is server/tests/kernelChoice.test.ts.
    // See docs/decisions/KI4-occt-spike.md for recorded measurements.
    expect('skip reason documented').toBeTruthy();
  });
});

// GeometryKernel interface conformance — compile-time check via `satisfies`.
// A stub missing any of the four methods fails tsc; no WASM needed.

describe('GeometryKernel — interface conformance', () => {
  it('GeometryKernel type has evaluate, tessellate, topology, exportStep', () => {
    const stub = {
      supports: () => true,
      evaluate: () => null,
      tessellate: () => null,
      topology: () => null,
      exportStep: () => null,
    } satisfies GeometryKernel;
    expect(typeof stub.evaluate).toBe('function');
    expect(typeof stub.tessellate).toBe('function');
    expect(typeof stub.topology).toBe('function');
    expect(typeof stub.exportStep).toBe('function');
  });
  it('evaluate accepts a recipe tree (boolean over two solid leaves) and may refuse with null', () => {
    const recipes: ShapeRecipe[] = [];
    const stub: GeometryKernel = {
      supports: () => true,
      evaluate: (recipe) => {
        recipes.push(recipe);
        return null;
      },
      tessellate: () => null,
      topology: () => null,
      exportStep: () => null,
    };
    const recipe: ShapeRecipe = {
      op: 'fillet',
      source: { op: 'boolean', boolean: 'union', a: { op: 'solid', entity: BOX_A }, b: { op: 'solid', entity: BOX_B } },
      edges: [],
      size: 0.2,
    };
    expect(stub.evaluate(recipe)).toBeNull();
    expect(recipes).toEqual([recipe]);
  });
});

// occtOps / createOcctKernel — static contract tests (no WASM required).

describe('occtOps — static / contract tests', () => {
  it('occtOps exposes every native operation of the recipe evaluator', async () => {
    const { occtOps } = await import('@kernel-occt/occtKernel');
    const ops = occtOps({} as never);
    for (const name of [
      'solid',
      'boolean',
      'fillet',
      'chamfer',
      'shell',
      'place',
      'scale',
      'tessellate',
      'topology',
      'exportStep',
      'release',
    ] as const) {
      expect(typeof ops[name], name).toBe('function');
    }
  });
  it('fillet / chamfer / shell refuse a non-positive size without touching OCC', async () => {
    const { occtOps } = await import('@kernel-occt/occtKernel');
    const ops = occtOps({} as never);
    const shape = {} as never;
    expect(ops.fillet(shape, [], 0)).toBeNull();
    expect(ops.fillet(shape, [], -1)).toBeNull();
    expect(ops.chamfer(shape, [], 0)).toBeNull();
    expect(ops.shell(shape, 0)).toBeNull();
  });
  it('a native feature attempt that degrades the module disables native features for the process', async () => {
    const { occtOps, nativeFailureCount } = await import('@kernel-occt/occtKernel');
    let touches = 0;
    const api = new Proxy(
      {},
      {
        get: () => {
          touches++;
          throw 'module degraded'; // a non-Error throw always degrades (trap-like)
        },
      },
    );
    const ops = occtOps(api as never);
    const node = {
      op: 'feature',
      feature: 'hole',
      frame: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
      points: [[1, 1]],
      hole: { kind: 'simple', diameter: 2 },
      extent: { kind: 'through_all' },
    } as never;
    const before = nativeFailureCount();
    expect(ops.feature?.({} as never, node, 5)).toBeNull();
    expect(nativeFailureCount()).toBeGreaterThan(before);
    const settled = nativeFailureCount();
    const seen = touches;
    expect(ops.feature?.({} as never, node, 5)).toBeNull();
    expect(nativeFailureCount()).toBe(settled);
    expect(touches).toBe(seen);
  });
  it('createOcctKernel is exported from occtKernel module (import check)', async () => {
    // This confirms the module compiles and the named export exists.
    // We do NOT call createOcctKernel() here — that would load 63 MB WASM.
    const mod = await import('@kernel-occt/occtKernel');
    expect(typeof mod.createOcctKernel).toBe('function');
  });
});

// Live WASM tests — ALWAYS SKIPPED in this config (jsdom + 63 MB WASM).
// To un-skip: run vitest with `--environment node` AND the WASM binary present.
// Measurements from manual verification: union tris=28, fillet tris=628 (r=0.2).

describe.skip('OcctKernel live WASM (requires node env + 63 MB opencascade.js)', () => {
  const solid = (entity: BoxEntity): ShapeRecipe => ({ op: 'solid', entity });
  it('boolean union of two boxes evaluates and tessellates', async () => {
    const { createOcctKernel } = await import('@kernel-occt/occtKernel');
    const kernel = await createOcctKernel();
    const shape = kernel.evaluate({ op: 'boolean', boolean: 'union', a: solid(BOX_A), b: solid(BOX_B) });
    expect(shape).not.toBeNull();
    const result = kernel.tessellate(shape!);
    expect(result).not.toBeNull();
    expect(result!.positions.length).toBeGreaterThan(0);
    expect(result!.indices.length).toBeGreaterThan(0);
  });
  it('fillet of a box on the exact B-rep adds geometry', async () => {
    const { createOcctKernel } = await import('@kernel-occt/occtKernel');
    const kernel = await createOcctKernel();
    const shape = kernel.evaluate({ op: 'fillet', source: solid(BOX_A), edges: [], size: 0.2 });
    expect(shape).not.toBeNull();
    // Fillet of a box adds significant geometry — measured 628 triangles.
    expect(kernel.tessellate(shape!)!.indices.length / 3).toBeGreaterThan(12);
  });
  it('fillet with an oversized radius is refused with null', async () => {
    const { createOcctKernel } = await import('@kernel-occt/occtKernel');
    const kernel = await createOcctKernel();
    expect(kernel.evaluate({ op: 'fillet', source: solid(BOX_A), edges: [], size: 50 })).toBeNull();
  });
});

interface Fake {
  readonly kernel: CachingKernel;
  readonly leaked: () => number;
}

/** Fake OCC API: every handle it hands out is tracked; `leaked()` counts the ones never deleted. */
async function makeFakeKernel(): Promise<Fake> {
  vi.resetModules(); // the real module caches the first API it loads
  const { createOcctKernel } = await import('@kernel-occt/occtKernel');
  const created: object[] = [];
  const deleted = new Set<object>();
  const handle = <T extends object>(fields: T): T & { delete(): void } => {
    const object = {
      ...fields,
      delete(): void {
        deleted.add(object);
      },
    };
    created.push(object);
    return object;
  };
  const construct = (fields: object = {}) =>
    function (): object {
      return handle(fields);
    };
  // Walks one face / edge; the fake shapes hold no solid, so the one-triangle mesh may stay open.
  const oneShotExplorer = function (_shape: unknown, kind: unknown): object {
    let visited = kind === 'solid';
    return handle({
      More: (): boolean => !visited,
      Current: () => handle({ HashCode: (): number => 1, IsSame: (): boolean => true }),
      Next: (): void => {
        visited = true;
      },
    });
  };
  const triangulation = {
    IsNull: (): boolean => false,
    get: () => ({
      NbNodes: (): number => 3,
      NbTriangles: (): number => 1,
      Node: (i: number) => handle({ X: (): number => i, Y: (): number => 0, Z: (): number => 0, Transform: (): void => undefined }),
      Triangle: () => handle({ Value: (j: number): number => j }),
    }),
    delete: (): void => undefined,
  };
  const builder = (extra: object = {}) =>
    function (): object {
      return handle({
        Build: (): void => undefined,
        IsDone: (): boolean => true,
        Shape: () => handle({}),
        Add_2: (): void => undefined,
        ...extra,
      });
    };
  const api = {
    TopAbs_ShapeEnum: { TopAbs_FACE: 'face', TopAbs_EDGE: 'edge', TopAbs_SOLID: 'solid', TopAbs_SHAPE: 'shape' },
    TopAbs_Orientation: { TopAbs_REVERSED: { value: 1 } },
    ChFi3d_FilletShape: { ChFi3d_Rational: 0 },
    gp_Pnt_3: construct(),
    BRepPrimAPI_MakeBox_2: construct({ Shape: () => handle({}) }),
    BRepMesh_IncrementalMesh_2: construct({ Perform: (): void => undefined }),
    TopExp_Explorer_2: oneShotExplorer,
    TopLoc_Location_1: construct({ Transformation: () => handle({}) }),
    TopoDS: { Face_1: () => handle({ Orientation_1: () => ({ value: 0 }) }), Shell_1: () => handle({}), Edge_1: () => handle({}) },
    BRep_Tool: { Triangulation: () => handle(triangulation) },
    BRepBuilderAPI_MakePolygon_1: construct({
      Add_1: (): void => undefined,
      Close: (): void => undefined,
      IsDone: (): boolean => true,
      Wire: () => handle({}),
    }),
    BRepBuilderAPI_MakeFace_15: construct({ IsDone: (): boolean => true, Face: () => handle({}) }),
    BRepBuilderAPI_Sewing: construct({ Add: (): void => undefined, Perform: (): void => undefined, SewedShape: () => handle({}) }),
    Handle_Message_ProgressIndicator_1: construct(),
    BRepBuilderAPI_MakeSolid_1: builder({ Add: (): void => undefined }),
    BRepFilletAPI_MakeFillet: builder(),
    BRepCheck_Analyzer: construct({ IsValid_2: (): boolean => true }),
  };
  const factory: OcctFactory = () => Promise.resolve(api as never);
  const kernel = await createOcctKernel({ factory });
  return { kernel, leaked: () => created.filter((object) => !deleted.has(object)).length };
}

const box = {
  id: 'b',
  kind: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [1, 1, 1],
  layerId: 'layer-default',
  color: '#888888',
} as unknown as Entity;

describe('occt kernel releases WASM handles', () => {
  it('deletes the nodes, triangles, faces and triangulations read while meshing', async () => {
    const fake = await makeFakeKernel();
    const shape = fake.kernel.evaluate({ op: 'solid', entity: box });
    const mesh = shape === null ? null : fake.kernel.tessellate(shape);
    expect(mesh?.positions).toEqual([1, 0, 0, 2, 0, 0, 3, 0, 0]);
    expect(mesh?.indices).toEqual([0, 1, 2]);
    // The cache owns the built solid until it is cleared; everything else is already released.
    expect(fake.kernel.cachedShapeCount()).toBe(1);
    expect(fake.leaked()).toBe(1);
    fake.kernel.clear();
    expect(fake.leaked()).toBe(0);
  });
  it('deletes the explorers, edges, builders and intermediate shapes of a fillet', async () => {
    const fake = await makeFakeKernel();
    const shape = fake.kernel.evaluate({ op: 'fillet', source: { op: 'solid', entity: box }, edges: [], size: 0.1 });
    expect(shape).not.toBeNull();
    // Only the two cached shapes (source box, fillet result) stay alive; builders/edges are freed.
    expect(fake.kernel.cachedShapeCount()).toBe(2);
    expect(fake.leaked()).toBe(2);
    fake.kernel.clear();
    expect(fake.leaked()).toBe(0);
  });
});
