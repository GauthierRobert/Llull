/**
 * OpenCascade.js kernel (opt-in `?kernel=occt` / `LLULL_KERNEL=occt`; notes: docs/decisions/KI4-occt-spike.md).
 * Recipes evaluate to TopoDS_Shapes; booleans/fillets/chamfers/shells run on the B-rep; meshes only come out.
 * @invariant exact for every solid kind but `mesh` without `brep` and `pyramid` (sewn planar triangles)
 * @failure unsupported kind / non-manifold mesh / OCC refusal or failure -> null
 */
import type { BooleanOp, ShapeRecipe, Vec3 } from '@core/model/types';
import { kernelFromOps, type CachingKernel, type KernelOps } from '@core/geometry/shapeKernel';
import { errorMessage } from '@lib/errorMessage';
import { clearTangentContact } from './tangentGuard';
import { entityToOccShape, placementTransform, transformedCopy } from './occtShapes';
import { extractMeshData } from './occtMesh';
import { shapeTopology, uniqueSubShapes } from './occtTopology';
import { analyzeShape, shapeDistance } from './occtAnalysis';
import { writeStep } from './occtStep';
import { release, withOwned } from '@core/geometry/nativeObject';
import {
  type OccApi,
  type OccBuilder,
  type OccFilletMaker,
  type OccFuse,
  type OccUnifier,
  type OccValidity,
  type OccShapeList,
  type OccHandle,
  type OccOffsetMaker,
  type OccShape,
} from './occtTypes';

/** Injected loader inputs (core never fetches): Node passes `wasmBinary`, the browser `locateFile`. */
interface OcctKernelOptions {
  readonly wasmBinary?: ArrayBuffer | Uint8Array;
  readonly locateFile?: (path: string) => string;
  /** Defaults to `opencascade.js/dist/opencascade.wasm.js`. */
  readonly factory?: OcctFactory;
}

export type OcctFactory = (moduleOptions: Record<string, unknown>) => Promise<OccApi>;

let _modulePromise: Promise<OccApi> | null = null;

/** Load the OCC WASM module once (cached; throws if it cannot load). Node: see server/src/occtNode.ts. */
function getOccModule(options: OcctKernelOptions): Promise<OccApi> {
  _modulePromise ??= (async () => {
    const factory: OcctFactory = options.factory ?? (await import('opencascade.js/dist/opencascade.wasm.js')).default;
    const opts: Record<string, unknown> = { print: () => undefined }; // silence STEP transfer statistics
    if (options.wasmBinary) opts['wasmBinary'] = options.wasmBinary;
    if (options.locateFile) opts['locateFile'] = options.locateFile;
    return factory(opts);
  })();
  return _modulePromise;
}

const BOOLEAN_BUILDERS: Readonly<Record<BooleanOp, string>> = {
  union: 'BRepAlgoAPI_Fuse_3',
  subtract: 'BRepAlgoAPI_Cut_3',
  intersect: 'BRepAlgoAPI_Common_3',
};

/** `WebAssembly.RuntimeError` (a trap), read from the global: not every TS lib declares the value. */
const TrapError = (globalThis as { WebAssembly?: { RuntimeError?: new () => Error } }).WebAssembly?.RuntimeError;

/**
 * Whether an OCC throw degraded the WASM module (vs a graceful refusal). This build has no C++ exception
 * support: any C++ exception surfaces as a `ReferenceError` for a missing `___cxa_*` import — a graceful
 * refusal for fillet/chamfer/shell, but degrading for 'fragile' ops (booleans on near-tangent input then
 * return spurious nulls). A WASM trap or non-Error throw always degrades; other JS Errors are binding faults.
 */
function degradesModule(error: unknown, operation: OperationClass): boolean {
  if (!(error instanceof Error)) return true;
  if (TrapError !== undefined && error instanceof TrapError) return true; // a WASM trap
  return operation === 'fragile' && error instanceof ReferenceError && /___cxa_/.test(error.message);
}

/** 'refusal': a C++ exception is a graceful no; 'fragile': it may have degraded the module. */
type OperationClass = 'fragile' | 'refusal';

/** Run `body`, mapping any OCC exception to null and releasing every handle it registered. */
function guarded<T>(operation: OperationClass, body: (own: <H extends OccHandle | null>(handle: H) => H) => T | null): T | null {
  return withOwned(body, (error) => {
    if (degradesModule(error, operation)) nativeFailures++;
    if (error instanceof Error) console.warn(`[occtKernel] OCC operation failed: ${errorMessage(error)}`);
  });
}

let nativeFailures = 0;

/** Operations that degraded the module since load; a host that can restart it (worker kernel) should when this grows. */
export function nativeFailureCount(): number {
  return nativeFailures;
}

/**
 * Fillet/chamfer the selected unique edges (all when empty); `sizeEnd` = radius varying linearly along the edge.
 * @failure size <= 0, a selected index out of range, no edge, builder not done -> null
 */
function roundEdges(
  api: OccApi,
  shape: OccShape,
  edgeIndices: readonly number[],
  size: number,
  makeBuilder: (solid: OccShape) => OccFilletMaker,
  sizeEnd?: number,
): OccShape | null {
  if (!(size > 0) || (sizeEnd !== undefined && !(sizeEnd > 0))) return null;
  return guarded('refusal', (own) => {
    const edges = uniqueSubShapes(api, shape, 'TopAbs_EDGE').map(own);
    if (edgeIndices.some((index) => edges[index] === undefined)) return null;
    const selected = edgeIndices.length > 0 ? edgeIndices.map((i) => edges[i] as OccShape) : edges;
    if (selected.length === 0) return null;
    const maker = own(makeBuilder(shape));
    for (const current of selected) {
      try {
        const edge = own(api.TopoDS.Edge_1(current) as OccShape);
        if (sizeEnd === undefined) maker.Add_2(size, edge);
        else maker.Add_3(size, sizeEnd, edge);
      } catch {
        /* degenerate or seam edge */
      }
    }
    maker.Build();
    return maker.IsDone() ? validOrNull(api, maker.Shape(), own) : null;
  });
}

/** `shape` when BRepCheck finds it valid: OCC fillets can report done yet return a broken solid on which later booleans hang. */
function validOrNull(api: OccApi, shape: OccShape, own: <H extends OccHandle | null>(handle: H) => H): OccShape | null {
  const check = own(new api.BRepCheck_Analyzer(shape, true) as OccValidity);
  return check.IsValid_2() ? shape : null;
}

/** Fillet `edges` of `solid` in one builder (`shape`: ChFi3d section type); null when not done. */
function filletAll(
  api: OccApi,
  solid: OccShape,
  edges: readonly OccShape[],
  radius: number,
  shape: unknown,
  own: <T extends OccHandle>(handle: T) => T,
): OccShape | null {
  const maker = own(new api.BRepFilletAPI_MakeFillet(solid, shape) as OccFilletMaker);
  for (const edge of edges) maker.Add_2(radius, edge);
  maker.Build();
  return maker.IsDone() ? maker.Shape() : null;
}

/**
 * One multi-argument fuse of `shapes` whose boundary section edges (joints) are filleted by `radius`;
 * buried intersection curves are dropped; disjoint solids return their plain union.
 * @failure fuse not done, every fillet strategy refused -> null
 */
function blendedUnion(api: OccApi, shapes: readonly OccShape[], radius: number): OccShape | null {
  const [first, ...rest] = shapes;
  if (first === undefined || rest.length === 0 || !(radius > 0)) return null;
  return guarded('fragile', (own) => {
    const argumentsList = own(new api.TopTools_ListOfShape_1() as OccShapeList);
    argumentsList.Append_1(first);
    const tools = own(new api.TopTools_ListOfShape_1() as OccShapeList);
    for (const shape of rest) tools.Append_1(shape);
    const fuse = own(new api.BRepAlgoAPI_Fuse_1() as OccFuse);
    fuse.SetArguments(argumentsList);
    fuse.SetTools(tools);
    fuse.Build();
    if (!fuse.IsDone()) return null;
    const fused = fuse.Shape();
    const list = own(new api.TopTools_ListOfShape_1() as OccShapeList);
    list.Assign(fuse.SectionEdges());
    const boundary = uniqueSubShapes(api, fused, 'TopAbs_EDGE').map(own);
    const joints: OccShape[] = [];
    while (list.Size() > 0) {
      const edge = own(api.TopoDS.Edge_1(list.First_1()) as OccShape);
      list.RemoveFirst();
      if (api.BRep_Tool.Degenerated(edge) === true) continue;
      if (boundary.some((candidate) => candidate.IsSame(edge))) joints.push(edge);
    }
    if (joints.length === 0) return fused;
    return filletAll(api, fused, joints, radius, api.ChFi3d_FilletShape.ChFi3d_Rational, own);
  });
}

/** Post-boolean ShapeUpgrade_UnifySameDomain (else a fused seam splits an edge and a fillet rounds half); `shape` on failure. */
function unified(api: OccApi, shape: OccShape, own: <H extends OccHandle | null>(handle: H) => H): OccShape {
  try {
    const unifier = own(new api.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false) as OccUnifier);
    unifier.AllowInternalEdges(false);
    unifier.Build();
    return unifier.Shape();
  } catch {
    return shape;
  }
}

/** Closed hollow: the solid minus its inward offset by `thickness` (a sealed internal cavity). */
function hollow(api: OccApi, solid: OccShape, thickness: number): OccShape | null {
  if (!(thickness > 0)) return null;
  const cavity = guarded('refusal', (own) => {
    const offset = own(new api.BRepOffsetAPI_MakeOffsetShape_1() as OccOffsetMaker);
    offset.PerformByJoin(
      solid,
      -thickness,
      1e-4,
      api.BRepOffset_Mode.BRepOffset_Skin,
      false,
      false,
      api.GeomAbs_JoinType.GeomAbs_Arc,
      false,
    );
    return offset.IsDone() ? offset.Shape() : null;
  });
  if (cavity === null) return null;
  return guarded('fragile', (own) => {
    own(cavity);
    const cut = own(new api.BRepAlgoAPI_Cut_3(solid, cavity) as OccBuilder);
    cut.Build();
    return cut.IsDone() ? cut.Shape() : null;
  });
}

function transformed(api: OccApi, shape: OccShape, makeTransform: () => OccHandle): OccShape | null {
  return guarded('refusal', (own) => transformedCopy(api, shape, own(makeTransform())));
}

/** Booleans of two primitive leaves: open a hair-gap at a sphere/box point contact (tangentGuard). */
function untangle(a: ShapeRecipe, b: ShapeRecipe): [ShapeRecipe, ShapeRecipe] {
  if (a.op !== 'solid' || b.op !== 'solid') return [a, b];
  const [entityA, entityB] = clearTangentContact(a.entity, b.entity);
  return [entityA === a.entity ? a : { op: 'solid', entity: entityA }, entityB === b.entity ? b : { op: 'solid', entity: entityB }];
}

export function occtOps(api: OccApi): KernelOps<OccShape> {
  return {
    name: 'occt',
    failureEpoch: nativeFailureCount,
    solid: (entity) => guarded('refusal', () => entityToOccShape(api, entity)),
    prepareBoolean: untangle,
    boolean: (op: BooleanOp, a, b) =>
      guarded('fragile', (own) => {
        const builder = own(new api[BOOLEAN_BUILDERS[op]](a, b) as OccBuilder);
        return builder.IsDone() ? unified(api, builder.Shape(), own) : null;
      }),
    fillet: (shape, edges, radius, radiusEnd) =>
      roundEdges(
        api,
        shape,
        edges,
        radius,
        (solid) => new api.BRepFilletAPI_MakeFillet(solid, api.ChFi3d_FilletShape.ChFi3d_Rational),
        radiusEnd,
      ),
    blend: (shapes, radius) => blendedUnion(api, shapes, radius),
    chamfer: (shape, edges, distance) => roundEdges(api, shape, edges, distance, (solid) => new api.BRepFilletAPI_MakeChamfer(solid)),
    shell: (shape, thickness) => hollow(api, shape, thickness),
    place: (shape, position: Vec3, rotation: Vec3) => transformed(api, shape, () => placementTransform(api, rotation, position)),
    scale: (shape, factor) =>
      factor > 0
        ? transformed(api, shape, () => {
            const transform = new api.gp_Trsf_1();
            const origin: OccHandle = new api.gp_Pnt_3(0, 0, 0);
            transform.SetScale(origin, factor);
            release(origin);
            return transform as OccHandle;
          })
        : null,
    tessellate: (shape) => guarded('fragile', () => extractMeshData(api, shape)),
    topology: (shape) => guarded('fragile', () => shapeTopology(api, shape)),
    exportStep: (shapes) => guarded('fragile', () => writeStep(api, shapes)),
    analyze: (shape) => guarded('fragile', () => analyzeShape(api, shape)),
    distance: (a, b) => guarded('fragile', () => shapeDistance(api, a, b)),
    release,
  };
}

export async function createOcctKernel(options: OcctKernelOptions = {}): Promise<CachingKernel> {
  const api = await getOccModule(options);
  return kernelFromOps(occtOps(api));
}
