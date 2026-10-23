/**
 * Injected geometry kernel interface (architecture L9). Interface only: no WASM, no three.js, no async. Commands read it from `ctx.kernel`
 * and no-op when it is null; the composition root installs it.
 *
 * The kernel boundary is a SHAPE, not a mesh: a command hands the kernel a `ShapeRecipe` (the construction tree) and gets back an opaque,
 * kernel-owned `ShapeHandle` (an exact B-rep under OCC). Meshes only come OUT of the kernel (`tessellate`), for display and mesh exports.
 */

import type { MeshData, ShapeRecipe, Vec3 } from '../model/types';
import type { DeformLaw } from '../model/deform';

import type { ExchangeWriteRequest, ImportExchangeOptions, ImportExchangeResult } from './kernelExchange';
import type { MeshToBrepRequest, MeshToBrepResult } from './kernelMeshBrep';
import type { BlendReport, ExactMassProperties, FaceQueryPort, ImportShapesOptions, ImportShapesResult, KernelInfo } from './kernelPorts';
import type { FaceSurface, ShapeHandle } from './kernelTypes';

export type { ShapeHandle };

type EdgeCurve = 'line' | 'circle' | 'ellipse' | 'bspline' | 'other';

/** One unique edge; `index` is what `fillet_edge` / `chamfer_edge` `edgeIndices` select. */
export interface ShapeEdge {
  readonly index: number;
  /** Persistent name from the kernel's history (SC-N1, `geometry/naming/references`): `e(<face>|<face>)`; absent without history. */
  readonly name?: string;
  readonly curve: EdgeCurve;
  readonly length: number;
  readonly start: Vec3;
  readonly end: Vec3;
  /** Point at the parameter midpoint (on the curve, not the chord). */
  readonly mid: Vec3;
  /** Points along the curve, start to end (curved edges); `edgesNear` measures distance to them. */
  readonly samples?: readonly Vec3[];
  /** Bounds a single face (a cylinder's seam): no corner to fillet or chamfer. */
  readonly seam: boolean;
  /** Zero-length (a sphere or cone pole): no corner to fillet or chamfer. */
  readonly degenerate: boolean;
}

export interface ShapeFace {
  readonly index: number;
  /** Persistent name from the kernel's history (SC-N1): `<entity>:<role>`, `blend(<edge>)`, `<face>~inner`; absent without history. */
  readonly name?: string;
  readonly surface: FaceSurface;
  readonly area: number;
  /** Cylinder, cone and revolution faces (OCC): the axis line and, for a cylinder, its radius (document units). */
  readonly axis?: {
    readonly origin: Vec3;
    readonly direction: Vec3;
    readonly radius?: number;
    /** Cylinders: axial extent of the face as signed offsets from `origin` along `direction`. */
    readonly span?: readonly [number, number];
  };
  /** Planes (OCC): the outward unit normal of the face on its solid. */
  readonly normal?: Vec3;
  /** Cylinders (OCC): the solid lies inside the surface (a pin), false = outside it (a bore). */
  readonly convex?: boolean;
}

/** Exact topology of a kernel shape (B-rep faces and edges, deduplicated, kernel order). */
export interface ShapeTopology {
  readonly solids: number;
  readonly faces: readonly ShapeFace[];
  readonly edges: readonly ShapeEdge[];
  readonly vertices: number;
  readonly volume: number;
}

/** Health and lump structure of one shape (`GeometryKernel.analyze`). Lengths in document units. */
export interface ShapeAnalysis {
  /** The kernel accepts the shape as a valid solid. */
  readonly valid: boolean;
  /** Kernel status text: Manifold `ErrorStatus`, OCC `BRepCheck` summary. */
  readonly status: string;
  /** Watertight solid(s). */
  readonly closed: boolean;
  readonly volume: number;
  readonly area: number;
  /** Disconnected pieces (one entry for a connected shape). */
  readonly lumps: readonly {
    readonly volume: number;
    readonly area: number;
    readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  }[];
  /** OCC: faces outside any closed shell; Manifold cannot hold sheets, so 0. */
  readonly freeFaces: number;
}

/** Minimum distance between two shapes (`GeometryKernel.distance`). */
export interface ShapeDistance {
  /** 0 when the shapes touch or intersect. */
  readonly distance: number;
  readonly pointA: Vec3;
  readonly pointB: Vec3;
  /** One shape lies inside the other (surfaces may not touch). */
  readonly inside: boolean;
}

/** A STEP product: the solids of one component (or one loose solid), written once and shared by every occurrence that names this object. */
export interface StepAssemblyPart<S = ShapeHandle> {
  readonly shapes: readonly S[];
  /** Sub-assembly: placed uses of other parts inside this one, in component space (written once however often this part is used). */
  readonly children?: readonly StepOccurrence<S>[];
}

/** One placed use of a part in the root assembly (STEP NEXT_ASSEMBLY_USAGE_OCCURRENCE); `rotation` radians, then `position`. */
export interface StepOccurrence<S = ShapeHandle> {
  readonly part: StepAssemblyPart<S>;
  readonly position: Vec3;
  readonly rotation: Vec3;
}

/**
 * Every operation returns null when it cannot be performed (unsupported op, degenerate geometry, kernel limitation); commands treat null as
 * a no-op. Implementors must not mutate arguments. Exact topology and STEP: OCC only (Manifold is a mesh kernel: `topology` / `exportStep`
 * -> null, and fillet / chamfer / shell recipes evaluate to null).
 */
export interface GeometryKernel {
  /** Short kernel name ('manifold', 'occt') recorded in check provenance; absent for anonymous kernels. */
  readonly name?: string;

  /** Whether this kernel can perform recipe nodes of `op` at all (Manifold: no fillet/chamfer/shell). */
  supports(op: ShapeRecipe['op']): boolean;

  /** Whether this kernel builds `deform` nodes of that law exactly (01 DEF); absent = it follows `supports('deform')`. */
  supportsDeform?(law: DeformLaw): boolean;

  /** Build (or reuse, by `recipeKey`) the kernel shape of a recipe. */
  evaluate(recipe: ShapeRecipe): ShapeHandle | null;

  /** Display mesh of a shape (output only: never fed back into the kernel). */
  tessellate(shape: ShapeHandle): MeshData | null;

  /** Exact faces/edges of a shape; null for kernels without a B-rep. */
  topology(shape: ShapeHandle): ShapeTopology | null;

  /** ISO 10303-21 (STEP AP214) text of the shapes as exact B-rep solids; null when unsupported. */
  exportStep(shapes: readonly ShapeHandle[]): string | null;

  /**
   * STEP text with real assembly structure: one root product, one product per distinct `part` object, one occurrence (placed by location,
   * geometry shared) per entry, in order; a part's `children` are nested occurrences whose locations compose down the tree. Absent / null when the kernel cannot write assemblies.
   */
  exportStepAssembly?(occurrences: readonly StepOccurrence[]): string | null;

  /** Validity, volume and lumps of a shape; absent or null when the kernel cannot tell (dependent checks report `not_run`). */
  analyze?(shape: ShapeHandle): ShapeAnalysis | null;

  /** Minimum distance between two shapes, searched up to `maxDistance` (document units; farther pairs may report a larger value). */
  distance?(a: ShapeHandle, b: ShapeHandle, maxDistance: number): ShapeDistance | null;

  /** Why the exact fillet `recipe` fails: OCCT contour statuses, faulty vertices, 4+ edge vertices (BLD M0); null for other recipes or kernels without diagnostics. */
  blendReport?(recipe: ShapeRecipe): BlendReport | null;

  /** What this kernel is and which optional ports it has (`kernel_info`, TR-KRN-04). */
  info?(): KernelInfo;

  /** Exact volume, area, centroid and inertia at unit density (TR-KRN-40); null when the kernel cannot integrate the shape. */
  massProperties?(shape: ShapeHandle): ExactMassProperties | null;

  /** Read and heal an exchange file into exact solids (TR-KRN-20/24); `text` is the Part 21 file content. */
  importShapes?(format: 'step' | 'iges', text: string, options: ImportShapesOptions): ImportShapesResult | null;

  /** STEP (AP242 / AP214 / AP203) or IGES text of a product tree with names, colours, layers and validation properties (04 XCH); null when unsupported. */
  writeExchange?(request: ExchangeWriteRequest): string | null;

  /** Read a STEP product tree (assembly structure, names, colours, healed solids) or an IGES file (04 XCH); null when unsupported. */
  importExchange?(format: 'step' | 'iges', text: string, options: ImportExchangeOptions): ImportExchangeResult | null;

  /** Prismatic B-rep of a segmented closed triangle mesh (07 MSH FR-MSH-21): exact faces for analytic groups, sewn into a solid; null when unsupported or refused. */
  meshToBrep?(request: MeshToBrepRequest): MeshToBrepResult | null;

  /** Make a document blob (`brep` recipe leaves, `BRepTools::Write` text keyed by sha256) available to `evaluate`. Idempotent. */
  loadBlob?(sha256: string, brep: string): void;

  /** Face-level queries (01 §5.9); absent on mesh kernels. */
  readonly faceQuery?: FaceQueryPort;
}

let _kernel: GeometryKernel | null = null;

/** Inject the process-default kernel (read by `defaultContext()`); null resets (tests). */
export function setGeometryKernel(k: GeometryKernel | null): void {
  _kernel = k;
}

/** The injected kernel, or null when none is installed (headless, tests). */
export function getGeometryKernel(): GeometryKernel | null {
  return _kernel;
}
