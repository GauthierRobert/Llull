/**
 * Optional exact-kernel ports (aerospace 01 KRN, step AERO-2): kernel description (TR-KRN-04), exact mass properties (TR-KRN-40), exact
 * import (TR-KRN-20/21/24) and the face-query port (TR-KRN-90..92, §5.9). Every member of `GeometryKernel` that uses them is optional:
 * Manifold omits them and the commands refuse with `KRN_NO_EXACT_KERNEL`. Every method returns null when it cannot answer and never throws.
 */

import type { MeshData, Vec2, Vec3 } from '../model/types';
import type { FaceSurface, ShapeHandle } from './kernelTypes';
import type { InertiaTensor } from './massProperties';

/** What the active kernel is (TR-KRN-04); the composition root may add `isolation` / `fallbackReason`. */
export interface KernelInfo {
  readonly occtVersion?: string;
  /** Binary identity, e.g. "opencascade.js@1.1.1". */
  readonly build?: string;
  /** Optional capabilities present: 'topology', 'analyze', 'distance', 'massProperties', 'importShapes', 'faceQuery', 'brepBlobs', 'exportStep'. */
  readonly capabilities: readonly string[];
  /** How the host runs the kernel: a worker thread, the host process itself, or a separate OS process (native sidecar, RS-1). */
  readonly isolation?: 'worker' | 'in-process' | 'process';
  /** Set when the exact kernel failed to start and a fallback kernel is active. */
  readonly fallbackReason?: string;
}

/**
 * Exact mass properties of a shape at unit density, in document units (TR-KRN-40/41). The kernel evaluates in a part frame centred on the
 * bounding-box centre and shifts the results back, so precision does not depend on the distance from the origin.
 */
export interface ExactMassProperties {
  readonly volume: number;
  readonly area: number;
  readonly centroid: Vec3;
  /** About the centroid, per unit density (multiply by the density for kg·m² etc.); Ixy = −∫xy dV. */
  readonly inertiaAtCentroid: InertiaTensor;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  /** Relative error estimate of the volume integration, when the kernel reports one. */
  readonly relError?: number;
}

/** Healing options of an exact import (TR-KRN-11/24); lengths in mm. */
export interface ImportShapesOptions {
  readonly precision: number;
  readonly maxTolerance: number;
  readonly heal: boolean;
  readonly sew: boolean;
}

/** One imported solid: its healed B-rep (`BRepTools::Write` text, the blob payload) and its health report. */
export interface ImportedSolid {
  readonly brep: string;
  readonly name?: string;
  readonly color?: string;
  readonly validAsRead: boolean;
  readonly validAfterHeal: boolean;
  readonly actions: readonly string[];
  readonly maxToleranceMm: number;
  readonly freeEdges: number;
  readonly faces: number;
  /** Every face planar with 3 edges: probably a mesh saved as B-rep. */
  readonly faceted: boolean;
}

export interface ImportedShapes {
  readonly solids: readonly ImportedSolid[];
  /** Root content census before transfer (TR-KRN-22). */
  readonly census: {
    readonly roots: number;
    readonly solids: number;
    readonly shells: number;
    readonly openShells: number;
    readonly faces: number;
  };
  /** Items read but not imported (open shells after sewing, wires, …). */
  readonly skipped: readonly string[];
}

export type ImportShapesResult =
  | ImportedShapes
  | { readonly error: 'unreadable' | 'no_solid' | 'tessellated_only'; readonly detail: string };

/** One surface-parameter type for the whole port (TR-KRN-91). */
export type SurfaceParams =
  | { readonly type: 'plane'; readonly origin: Vec3; readonly normal: Vec3; readonly xDir: Vec3 }
  | { readonly type: 'cylinder'; readonly origin: Vec3; readonly axis: Vec3; readonly xDir: Vec3; readonly radius: number }
  | { readonly type: 'cone'; readonly apex: Vec3; readonly axis: Vec3; readonly xDir: Vec3; readonly semiAngle: number }
  | { readonly type: 'sphere'; readonly center: Vec3; readonly radius: number }
  | { readonly type: 'torus'; readonly center: Vec3; readonly axis: Vec3; readonly major: number; readonly minor: number }
  | { readonly type: 'other'; readonly kind: FaceSurface };

/** Located face record (03 TR-GDT-03, 05 §5.1); index = `ShapeTopology.faces` index. */
export interface FaceDetail {
  readonly index: number;
  readonly surface: FaceSurface;
  readonly area: number;
  readonly centroid: Vec3;
  /** Planes: outward (material side reversed). */
  readonly normal?: Vec3;
  readonly axis?: { readonly origin: Vec3; readonly dir: Vec3 };
  /** Cylinder, sphere; torus minor; cone at the face centroid. */
  readonly radius?: number;
  /** Up to `options.samples` (default 64) points inside the trimmed face. */
  readonly samples: readonly Vec3[];
}

export interface FaceGraphFace {
  readonly index: number;
  readonly surface: SurfaceParams;
  readonly reversed: boolean;
  readonly area: number;
  /** Edge indices (`ShapeTopology.edges`), outer loop first. */
  readonly loops: readonly (readonly number[])[];
  /** `[uMin, uMax, vMin, vMax]` (OCC `BRepTools::UVBounds` order) of the trimmed face. */
  readonly uvBounds: readonly [number, number, number, number];
}

export interface FaceGraph {
  readonly faces: readonly FaceGraphFace[];
  /** Per edge index: the faces bounding it. */
  readonly edgeFaces: readonly (readonly number[])[];
  readonly edgeConvexity: readonly ('convex' | 'concave' | 'smooth' | 'unknown')[];
}

export interface FaceProjection {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly uv: Vec2;
  readonly distance: number;
}

/** Curvature sample (02 §5.8): principal curvatures k1 ≥ k2 (1 / document unit), directions, Gaussian K and mean H. */
export interface SurfaceSample {
  readonly u: number;
  readonly v: number;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly k1: number;
  readonly k2: number;
  readonly dir1: Vec3;
  readonly dir2: Vec3;
  readonly gaussian: number;
  readonly mean: number;
  readonly degenerate: boolean;
}

interface EdgeCurveSample {
  readonly t: number;
  readonly s: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly curvature: number;
  readonly dCurvatureDs: number;
  readonly torsion: number;
  readonly normal: Vec3;
}

interface EdgeContinuitySample {
  readonly t: number;
  readonly point: Vec3;
  readonly g0: number;
  readonly g1: number;
  readonly normalCurvature: readonly [number, number];
  readonly g3?: number;
}

interface NurbsSurfaceData {
  readonly degreeU: number;
  readonly degreeV: number;
  readonly poles: readonly (readonly Vec3[])[];
  readonly weights?: readonly (readonly number[])[];
  readonly knotsU: readonly number[];
  readonly multsU: readonly number[];
  readonly knotsV: readonly number[];
  readonly multsV: readonly number[];
  readonly periodicU: boolean;
  readonly periodicV: boolean;
}

/** Face-level queries for every pack (01 §5.9). A method the kernel cannot answer returns null. */
export interface FaceQueryPort {
  faceDetails(shape: ShapeHandle, options?: { readonly samples?: number }): readonly FaceDetail[] | null;
  faceContains(shape: ShapeHandle, face: number, point: Vec3, tolerance?: number): boolean | null;
  faceGraph(shape: ShapeHandle): FaceGraph | null;
  faceGeometry(shape: ShapeHandle, face: number): { readonly surface: SurfaceParams; readonly uvBounds: readonly [Vec2, Vec2] } | null;
  projectOnFace(shape: ShapeHandle, face: number, points: readonly Vec3[]): readonly (FaceProjection | null)[] | null;
  evaluateFace(shape: ShapeHandle, face: number, uv: readonly Vec2[]): readonly { readonly point: Vec3; readonly normal: Vec3 }[] | null;
  tessellateFace(shape: ShapeHandle, face: number, deflection: number): (MeshData & { readonly uv: readonly number[] }) | null;
  faceSamples(
    shape: ShapeHandle,
    face: number,
    uv: ReadonlyArray<readonly [number, number]> | { readonly nu: number; readonly nv: number },
  ): readonly SurfaceSample[] | null;
  edgeSamples(shape: ShapeHandle, edge: number, count: number): readonly EdgeCurveSample[] | null;
  edgeContinuity(shape: ShapeHandle, edge: number, count: number): readonly EdgeContinuitySample[] | null;
  distance(
    shape: ShapeHandle,
    points: readonly Vec3[],
  ): readonly { readonly distance: number; readonly signed: number; readonly face: number }[] | null;
  bspline(shape: ShapeHandle, face: number): NurbsSurfaceData | null;
}
