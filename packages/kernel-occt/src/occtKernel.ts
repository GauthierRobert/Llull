/**
 * OpenCascade.js (OCC WASM) geometry kernel, opt-in via `?kernel=occt` / `LLULL_KERNEL=occt`
 * (Manifold is the default). Measurements and API notes: docs/decisions/KI4-occt-spike.md.
 *
 * @layer kernel
 * @invariant implemented: booleanOp (box operands), filletEdges (mesh -> sewn solid -> fillet), tessellate (box)
 * @failure unsupported kind / non-manifold mesh / OCC failure / chamferEdges / shellSolid -> null
 */

import type { GeometryKernel, MeshData, BooleanOp } from '@core/geometry/kernel';
import type { Entity, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { entityToTriangles } from '@core/commands/exportTriangulate';
import { errorMessage } from '@lib/errorMessage';
import { cross3, dot3, sub3 } from '@lib/vec3';
import { isValidPolygon, toCounterClockwise } from '@lib/polygon';
import { clearTangentContact } from './tangentGuard';

/** Minimal typings for the subset of the OCC WASM API this kernel uses. */
interface OccHandle {
  delete(): void;
}

interface OccShape extends OccHandle {
  ShapeType(): unknown;
  Orientation_1(): { value: number };
}

interface OccTriangulation extends OccHandle {
  IsNull(): boolean;
  get(): {
    NbTriangles(): number;
    NbNodes(): number;
    Node(i: number): OccHandle & {
      X(): number;
      Y(): number;
      Z(): number;
      Transform(placement: OccHandle): void;
    };
    Triangle(i: number): OccHandle & { Value(j: number): number };
  };
}

interface OccExplorer extends OccHandle {
  More(): boolean;
  Current(): OccShape;
  Next(): void;
}

interface OccTopoDS {
  Face_1(shape: OccShape): OccShape;
  Edge_1(shape: OccShape): OccShape;
  Shell_1(shape: OccShape): OccShape;
}

/** Boolean operation or fillet builder: `Build` then `Shape`. */
interface OccBuilder extends OccHandle {
  Build(): void;
  IsDone(): boolean;
  Shape(): OccShape;
}

interface OccOffsetMaker extends OccHandle {
  PerformByJoin(...args: readonly unknown[]): void;
  IsDone(): boolean;
  Shape(): OccShape;
}

interface OccFilletMaker extends OccBuilder {
  Add_2(radius: number, edge: OccShape): void;
}

interface OccMakePolygon extends OccHandle {
  Add_1(pt: OccHandle): void;
  Close(): void;
  IsDone(): boolean;
  Wire(): OccShape;
}

interface OccMakeFace extends OccHandle {
  IsDone(): boolean;
  Face(): OccShape;
}

interface OccSewing extends OccHandle {
  Add(shape: OccShape): void;
  Perform(progress: unknown): void;
  SewedShape(): OccShape;
}

interface OccMakeSolid extends OccBuilder {
  Add(shell: OccShape): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OccApi = any; // The WASM binding is extremely wide; all narrowing is done above.

/** Injected loader inputs: core never fetches; the caller supplies WASM bytes or a locator. */
interface OcctKernelOptions {
  /** Pre-loaded WASM bytes (Node). */
  readonly wasmBinary?: ArrayBuffer | Uint8Array;
  /** Maps an asset path to a URL/path (browser). */
  readonly locateFile?: (path: string) => string;
  /** Emscripten factory of the OCC glue; defaults to `opencascade.js/dist/opencascade.wasm.js`. */
  readonly factory?: OcctFactory;
}

export type OcctFactory = (moduleOptions: Record<string, unknown>) => Promise<OccApi>;

let _modulePromise: Promise<OccApi> | null = null;

/**
 * Load and initialise the OpenCascade.js WASM module once, then cache.
 * Returns the OCC API object. Throws if the WASM cannot be loaded.
 *
 * Note: In a browser, the 63 MB WASM must be served as a static asset.
 * In Vite, add the WASM file to `publicDir` or use `vite-plugin-wasm`.
 * In Node.js (server/tests), pass the WASM as `wasmBinary` — see
 * server/src/occtNode.ts for the pattern.
 */
async function getOccModule(options: OcctKernelOptions): Promise<OccApi> {
  if (_modulePromise) return _modulePromise;

  _modulePromise = (async () => {
    const factory: OcctFactory =
      options.factory ?? (await import('opencascade.js/dist/opencascade.wasm.js')).default;

    const opts: Record<string, unknown> = {};
    if (options.wasmBinary) opts['wasmBinary'] = options.wasmBinary;
    if (options.locateFile) opts['locateFile'] = options.locateFile;

    return factory(opts);
  })();

  return _modulePromise;
}

function explorer(api: OccApi, shape: OccShape, kind: string): OccExplorer {
  return new api.TopExp_Explorer_2(
    shape,
    api.TopAbs_ShapeEnum[kind],
    api.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ) as OccExplorer;
}

/** Free a WASM heap object; OCC may already have released it, so failures are ignored. */
function release(handle: OccHandle | null): void {
  try {
    handle?.delete();
  } catch {
    /* already released */
  }
}

function extractMeshData(api: OccApi, shape: OccShape): MeshData | null {
  const mesher = new api.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false) as OccHandle & {
    Perform(): void;
  };
  mesher.Perform();

  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  const exp = explorer(api, shape, 'TopAbs_FACE');

  while (exp.More()) {
    const current = exp.Current();
    const face = (api.TopoDS as OccTopoDS).Face_1(current);
    const loc = new api.TopLoc_Location_1() as OccHandle & { Transformation(): OccHandle };
    const triangulation = api.BRep_Tool.Triangulation(face, loc) as OccTriangulation;

    if (!triangulation.IsNull()) {
      const tri = triangulation.get();
      const nNodes = tri.NbNodes();
      const nTris = tri.NbTriangles();

      // Nodes are stored in the face's own frame; `loc` carries the shape's placement (a prism's
      // top face, a transformed shape's faces), so bring them into world space.
      const placement = loc.Transformation();
      for (let i = 1; i <= nNodes; i++) {
        const node = tri.Node(i);
        node.Transform(placement);
        positions.push(node.X(), node.Y(), node.Z());
        release(node);
      }
      release(placement);

      // A REVERSED face's stored triangles wind against the solid's outward normal: flip them.
      const reversed = face.Orientation_1().value === api.TopAbs_Orientation.TopAbs_REVERSED.value;
      for (let i = 1; i <= nTris; i++) {
        const t = tri.Triangle(i);
        const [first, second, third] = [t.Value(1), t.Value(2), t.Value(3)];
        indices.push(
          vertexOffset + first - 1,
          vertexOffset + (reversed ? third : second) - 1,
          vertexOffset + (reversed ? second : third) - 1,
        );
        release(t);
      }

      vertexOffset += nNodes;
    }

    release(triangulation);
    release(face);
    release(current);
    loc.delete();
    exp.Next();
  }

  exp.delete();
  mesher.delete();

  if (positions.length === 0) return null;
  return { positions, indices };
}

/** Planar OCC face of a closed polygon wire through `corners`, or null when OCC rejects it. */
function polygonFace(api: OccApi, corners: readonly Vec3[]): OccShape | null {
  const points: OccHandle[] = corners.map(([x, y, z]) => new api.gp_Pnt_3(x, y, z));
  const poly = new api.BRepBuilderAPI_MakePolygon_1() as OccMakePolygon;
  for (const point of points) poly.Add_1(point);
  poly.Close();
  points.forEach(release);
  if (!poly.IsDone()) {
    poly.delete();
    return null;
  }
  const wire = poly.Wire();
  const makeFace = new api.BRepBuilderAPI_MakeFace_15(wire, false) as OccMakeFace;
  release(wire);
  poly.delete();
  const face = makeFace.IsDone() ? makeFace.Face() : null;
  makeFace.delete();
  return face;
}

/**
 * Rebuild a solid from MeshData: per-triangle planar faces sewn into a shell (BRepBuilderAPI_Sewing),
 * promoted with BRepBuilderAPI_MakeSolid. Degenerate triangles are skipped.
 * @failure empty / malformed mesh, open shell, MakeSolid not done -> null
 */
function meshDataToTopoDSShape(api: OccApi, mesh: MeshData): OccShape | null {
  const { positions, indices } = mesh;
  if (positions.length === 0 || indices.length === 0 || indices.length % 3 !== 0) return null;

  const vertex = (index: number): Vec3 => [
    positions[index * 3] ?? 0,
    positions[index * 3 + 1] ?? 0,
    positions[index * 3 + 2] ?? 0,
  ];
  const sewing: OccSewing = new api.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  for (let t = 0; t < indices.length; t += 3) {
    const corners: [Vec3, Vec3, Vec3] = [
      vertex(indices[t] ?? 0),
      vertex(indices[t + 1] ?? 0),
      vertex(indices[t + 2] ?? 0),
    ];
    const normal = cross3(sub3(corners[1], corners[0]), sub3(corners[2], corners[0]));
    if (dot3(normal, normal) < 1e-24) continue;
    const face = polygonFace(api, corners);
    if (face) {
      sewing.Add(face);
      release(face);
    }
  }

  const noProgress = new api.Handle_Message_ProgressIndicator_1();
  sewing.Perform(noProgress);
  noProgress.delete();
  const sewn = sewing.SewedShape() as OccShape | null;
  if (!sewn) {
    sewing.delete();
    return null;
  }

  const makeSolid: OccMakeSolid = new api.BRepBuilderAPI_MakeSolid_1();
  const shellExp = explorer(api, sewn, 'TopAbs_SHELL');
  let shellCount = 0;
  while (shellExp.More()) {
    const current = shellExp.Current();
    const shell = (api.TopoDS as OccTopoDS).Shell_1(current);
    makeSolid.Add(shell);
    release(shell);
    release(current);
    shellCount++;
    shellExp.Next();
  }
  shellExp.delete();
  release(sewn);
  sewing.delete();

  if (shellCount > 0) makeSolid.Build();
  const solid = shellCount > 0 && makeSolid.IsDone() ? makeSolid.Shape() : null;
  makeSolid.delete();
  return solid;
}

/** llull placement M = Rx·Ry·Rz (Rz applied first, radians) followed by the translation. */
function placementTransform(
  api: OccApi,
  rotation: Vec3,
  position: Vec3,
  anchorShift: Vec3 = [0, 0, 0],
): OccHandle {
  const total = new api.gp_Trsf_1();
  const offset: OccHandle = new api.gp_Vec_4(position[0], position[1], position[2]);
  total.SetTranslation_1(offset);
  release(offset);
  const axes: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
    [rotation[0], [1, 0, 0]],
    [rotation[1], [0, 1, 0]],
    [rotation[2], [0, 0, 1]],
  ];
  for (const [angle, [x, y, z]] of axes) {
    const origin: OccHandle = new api.gp_Pnt_3(0, 0, 0);
    const direction: OccHandle = new api.gp_Dir_4(x, y, z);
    const axis: OccHandle = new api.gp_Ax1_2(origin, direction);
    const turn = new api.gp_Trsf_1();
    turn.SetRotation_1(axis, angle);
    total.Multiply(turn);
    [turn, axis, direction, origin].forEach(release);
  }
  if (anchorShift.some((component) => component !== 0)) {
    const shift: OccHandle = new api.gp_Vec_4(anchorShift[0], anchorShift[1], anchorShift[2]);
    const local = new api.gp_Trsf_1();
    local.SetTranslation_1(shift);
    total.Multiply(local);
    [local, shift].forEach(release);
  }
  return total;
}

/** Copy of `shape` moved by `placement`; the input shape is released. */
function placed(api: OccApi, shape: OccShape, placement: OccHandle): OccShape {
  const transformer = new api.BRepBuilderAPI_Transform_2(shape, placement, true) as {
    Shape(): OccShape;
    delete(): void;
  };
  const moved = transformer.Shape();
  transformer.delete();
  release(placement);
  release(shape);
  return moved;
}

/**
 * Cylinder (centered, axis +Z), sphere and torus (centered) and cone (base-center, apex +height) built at the
 * origin then placed with the entity's rotation and position; non-positive sizes -> null.
 */
function revolvedPrimitive(api: OccApi, entity: Entity): OccShape | null {
  let anchorShift: Vec3 = [0, 0, 0];
  let maker: { Shape(): OccShape; delete(): void };
  if (entity.kind === 'cylinder') {
    if (!(entity.radius > 0 && entity.height > 0)) return null;
    maker = new api.BRepPrimAPI_MakeCylinder_1(entity.radius, entity.height);
    anchorShift = [0, 0, -entity.height / 2];
  } else if (entity.kind === 'sphere') {
    if (!(entity.radius > 0)) return null;
    maker = new api.BRepPrimAPI_MakeSphere_1(entity.radius);
  } else if (entity.kind === 'cone') {
    if (!(entity.radius > 0 && entity.height > 0)) return null;
    maker = new api.BRepPrimAPI_MakeCone_1(entity.radius, 0, entity.height);
  } else if (entity.kind === 'torus') {
    if (!(entity.tubeRadius > 0 && entity.ringRadius > entity.tubeRadius)) return null;
    maker = new api.BRepPrimAPI_MakeTorus_1(entity.ringRadius, entity.tubeRadius);
  } else {
    return null;
  }
  const shape = maker.Shape();
  maker.delete();
  return placed(api, shape, placementTransform(api, entity.rotation, entity.position, anchorShift));
}

/**
 * Prism of an XY polygon from z=0 to z=depth. The outline is made counter-clockwise first (a
 * clockwise face would extrude inside-out); degenerate or non-finite profiles -> null.
 */
function extrudedProfile(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'extrusion' || !isValidPolygon(entity.profile) || !(entity.depth > 0)) {
    return null;
  }
  const outline = toCounterClockwise(entity.profile).map(([x, y]): Vec3 => [x, y, 0]);
  const face = polygonFace(api, outline);
  if (face === null) return null;
  const direction: OccHandle = new api.gp_Vec_4(0, 0, entity.depth);
  const maker = new api.BRepPrimAPI_MakePrism_1(face, direction, false, true) as {
    Shape(): OccShape;
    delete(): void;
  };
  const shape = maker.Shape();
  [maker, direction, face].forEach(release);
  return placed(api, shape, placementTransform(api, entity.rotation, entity.position));
}

/** Closed triangle-mesh solid (world space) rebuilt as a sewn OCC solid; open meshes -> null. */
function meshSolid(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'mesh') return null;
  const shape = meshDataToTopoDSShape(api, entity.mesh);
  const moved = [...entity.rotation, ...entity.position].some((value) => value !== 0);
  return shape !== null && moved
    ? placed(api, shape, placementTransform(api, entity.rotation, entity.position))
    : shape;
}

/** Kinds with no exact OCC maker here: their world-space triangles are sewn into a solid. */
const TRIANGULATED_KINDS: ReadonlySet<Entity['kind']> = new Set(['wedge', 'pyramid', 'revolution']);

/** Primitive tessellation never reads components; instances are not boolean operands. */
const NO_COMPONENTS = createEmptyDocument();

/** Signed volume of a triangle soup (9 numbers per triangle); negative when wound inward. */
function soupVolume(positions: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const [a, b, c] = [
      positions.slice(i, i + 3),
      positions.slice(i + 3, i + 6),
      positions.slice(i + 6, i + 9),
    ];
    sum += dot3(a as unknown as Vec3, cross3(b as unknown as Vec3, c as unknown as Vec3));
  }
  return sum / 6;
}

/** Sewn solid from the entity's own (already world-space, outward-wound) triangles. */
function tessellatedSolid(api: OccApi, entity: Entity): OccShape | null {
  const positions: number[] = [];
  for (const triangle of entityToTriangles(entity, NO_COMPONENTS)) {
    for (const [x, y, z] of triangle) positions.push(x, y, z);
  }
  if (positions.length === 0) return null;
  if (soupVolume(positions) < 0) {
    for (let i = 0; i + 8 < positions.length; i += 9) {
      positions.splice(
        i + 3,
        6,
        ...positions.slice(i + 6, i + 9),
        ...positions.slice(i + 3, i + 6),
      );
    }
  }
  const indices = Array.from({ length: positions.length / 3 }, (_, corner) => corner);
  return meshDataToTopoDSShape(api, { positions, indices });
}

/** Every solid kind a boolean can take (rotation + position honoured); 2D shapes -> null. */
function entityToOccShape(api: OccApi, entity: Entity): OccShape | null {
  if (TRIANGULATED_KINDS.has(entity.kind)) return tessellatedSolid(api, entity);
  if (entity.kind === 'extrusion') return extrudedProfile(api, entity);
  if (entity.kind === 'mesh') return meshSolid(api, entity);
  if (entity.kind !== 'box') return revolvedPrimitive(api, entity);
  const [sx, sy, sz] = entity.size;
  if (sx <= 0 || sy <= 0 || sz <= 0) return null;
  const [px, py, pz] = entity.position;
  const rotated = entity.rotation.some((angle) => angle !== 0);
  const [ox, oy, oz] = rotated
    ? [-sx / 2, -sy / 2, -sz / 2]
    : [px - sx / 2, py - sy / 2, pz - sz / 2];
  const origin: OccHandle = new api.gp_Pnt_3(ox, oy, oz);
  const maker = new api.BRepPrimAPI_MakeBox_2(origin, sx, sy, sz) as {
    Shape(): OccShape;
    delete(): void;
  };
  const shape = maker.Shape();
  origin.delete();
  maker.delete();
  return rotated
    ? placed(api, shape, placementTransform(api, entity.rotation, entity.position))
    : shape;
}

const BOOLEAN_BUILDERS: Readonly<Record<BooleanOp, string>> = {
  union: 'BRepAlgoAPI_Fuse_3',
  subtract: 'BRepAlgoAPI_Cut_3',
  intersect: 'BRepAlgoAPI_Common_3',
};

/** Run `body`, mapping any OCC exception to null and releasing every handle it registered. */
function withHandles(
  body: (own: <T extends OccHandle | null>(handle: T) => T) => MeshData | null,
): MeshData | null {
  const owned: Array<OccHandle | null> = [];
  try {
    return body((handle) => {
      owned.push(handle);
      return handle;
    });
  } catch (error) {
    // A number is a native C++ exception pointer (OCC rejecting the input: expected, silent); an
    // Error is a binding or programming fault worth surfacing.
    if (error instanceof Error)
      console.warn(`[occtKernel] OCC operation failed: ${errorMessage(error)}`);
    return null;
  } finally {
    owned.forEach(release);
  }
}

/**
 * Fillet or chamfer the selected edges of a closed mesh solid (both builders share `Add_2(size,
 * edge)`): rebuild a sewn solid, add the edges, build, mesh the result.
 * @failure size <= 0, empty or non-closed mesh, builder not done -> null
 */
function roundEdges(
  api: OccApi,
  label: string,
  mesh: MeshData,
  edgeIndices: number[],
  size: number,
  makeBuilder: (solid: OccShape) => OccFilletMaker,
): MeshData | null {
  if (!(size > 0) || mesh.positions.length === 0) return null;
  return withHandles((own) => {
    const solid = own(meshDataToTopoDSShape(api, mesh));
    if (!solid) {
      console.warn(
        `[occtKernel] ${label}: could not reconstruct a manifold solid from MeshData ` +
          '(non-manifold mesh, open shell, or degenerate triangles). Returning null.',
      );
      return null;
    }
    const maker = own(makeBuilder(solid));
    const edgeExp = explorer(api, solid, 'TopAbs_EDGE');
    const edgeSet = edgeIndices.length > 0 ? new Set(edgeIndices) : null;
    for (let edgeIdx = 0; edgeExp.More(); edgeIdx++, edgeExp.Next()) {
      if (edgeSet && !edgeSet.has(edgeIdx)) continue;
      const current = edgeExp.Current();
      const edge = (api.TopoDS as OccTopoDS).Edge_1(current);
      try {
        maker.Add_2(size, edge);
      } catch {
        // Degenerate or seam edge: skip.
      }
      release(edge);
      release(current);
    }
    edgeExp.delete();
    maker.Build();
    return maker.IsDone() ? extractMeshData(api, own(maker.Shape())) : null;
  });
}

/**
 * Create an OCC-backed geometry kernel.
 * @param options injected `wasmBinary` / `locateFile` (see OcctKernelOptions)
 */
export async function createOcctKernel(options: OcctKernelOptions = {}): Promise<GeometryKernel> {
  const api = await getOccModule(options);

  return {
    booleanOp(op: BooleanOp, a: Entity, b: Entity): MeshData | null {
      const [operandA, operandB] = clearTangentContact(a, b);
      return withHandles((own) => {
        const shapeA = own(entityToOccShape(api, operandA));
        const shapeB = shapeA && own(entityToOccShape(api, operandB));
        if (!shapeA || !shapeB) return null;
        const builder = own(new api[BOOLEAN_BUILDERS[op]](shapeA, shapeB) as OccBuilder);
        builder.Build();
        return builder.IsDone() ? extractMeshData(api, own(builder.Shape())) : null;
      });
    },

    /** @param edgeIndices 0-based edge indices to fillet; empty = all edges */
    filletEdges(shape: MeshData, edgeIndices: number[], radius: number): MeshData | null {
      return roundEdges(api, 'filletEdges', shape, edgeIndices, radius, (solid) => {
        return new api.BRepFilletAPI_MakeFillet(solid, api.ChFi3d_FilletShape.ChFi3d_Rational);
      });
    },

    /** @param edgeIndices 0-based edge indices to chamfer; empty = all edges */
    chamferEdges(shape: MeshData, edgeIndices: number[], distance: number): MeshData | null {
      return roundEdges(api, 'chamferEdges', shape, edgeIndices, distance, (solid) => {
        return new api.BRepFilletAPI_MakeChamfer(solid);
      });
    },

    /** Closed hollow: the solid minus its inward offset by `thickness` (a sealed internal cavity). */
    shellSolid(shape: MeshData, thickness: number): MeshData | null {
      if (!(thickness > 0) || shape.positions.length === 0) return null;
      return withHandles((own) => {
        const solid = own(meshDataToTopoDSShape(api, shape));
        if (!solid) return null;
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
        if (!offset.IsDone()) return null;
        const cavity = own(offset.Shape());
        const cut = own(new api.BRepAlgoAPI_Cut_3(solid, cavity) as OccBuilder);
        cut.Build();
        return cut.IsDone() ? extractMeshData(api, own(cut.Shape())) : null;
      });
    },

    tessellate(entity: Entity): MeshData | null {
      return withHandles((own) => {
        const shape = own(entityToOccShape(api, entity));
        return shape && extractMeshData(api, shape);
      });
    },
  };
}
