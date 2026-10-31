/**
 * Optional exact-kernel ports (aerospace 01 KRN, step AERO-2): kernel description (TR-KRN-04), exact mass properties (TR-KRN-40), exact
 * import (TR-KRN-20/21/24) and the face-query port (TR-KRN-90..92, §5.9). Every member of `GeometryKernel` that uses them is optional:
 * Manifold omits them and the commands refuse with `KRN_NO_EXACT_KERNEL`. Every method returns null when it cannot answer and never throws.
 */

import type { MeshData, Vec2, Vec3 } from '../model/types';
import type { FaceSurface, ShapeHandle } from './kernelTypes';
import type { InertiaTensor } from './massProperties';
import type { NurbsCurve2Data } from '../lib/nurbs/curve2d';
import type { NurbsCurveData } from '../lib/nurbs/types';

/** What the active kernel is (TR-KRN-04); the composition root may add `isolation` / `fallbackReason`. */
export interface KernelInfo {
  readonly occtVersion?: string;
  /** Binary identity, e.g. "llull-kernel@0.1.0". */
  readonly build?: string;
  /** Optional capabilities present: 'topology', 'analyze', 'distance', 'massProperties', 'importShapes', 'faceQuery', 'brepBlobs', 'exportStep', 'writeExchange', 'importExchange', 'igesExchange'. */
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
  /** Why the numbers may be off: the adaptive integration guard tripped and the fixed Gauss rule was used (absent when nothing is to be said). */
  readonly note?: string;
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
  /** Set when the adaptive integration guard tripped on this face and its area is the fixed Gauss rule's. */
  readonly note?: string;
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
  /** Set when the adaptive integration guard tripped on a face and its area is the fixed Gauss rule's. */
  readonly note?: string;
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

/** Why an exact fillet recipe failed (or that it builds): the OCCT contour statuses, faulty vertices and 4+ edge vertices (BLD M0, `kernel.blendReport`). */
export interface BlendReport {
  readonly stage: 'contours' | 'corners' | 'validity' | 'profile' | 'setback' | 'faceBlend' | 'fullRound' | 'chamfer' | 'blend' | 'none';
  readonly contours: ReadonlyArray<{
    readonly edges: readonly number[];
    readonly status: 'ok' | 'error' | 'walking_failure' | 'startsol_failure' | 'twisted_surface';
  }>;
  /** OCCT `FaultyVertex`: the vertex and the edges of the solid meeting there. */
  readonly vertices: ReadonlyArray<{ readonly point: Vec3; readonly edges: readonly number[] }>;
  /** OCCT `HasResult` of a failed build: a partial result exists (never committed). */
  readonly partial: boolean;
  /** Vertices of selected edges where 4 or more edges of the solid meet (a documented OCCT limit, not necessarily a failure). */
  readonly unsupportedVertices: ReadonlyArray<{ readonly point: Vec3; readonly edgeCount: number; readonly selectedEdgeCount: number }>;
  readonly done: boolean;
  readonly valid: boolean;
  readonly message?: string;
  /** How a profile blend that builds was made (stage "none" only): the builder, the measured gap, a reported fallback, the corner setbacks chosen. */
  readonly notes?: BlendBuildNotes | null;
}

/** What the builder of a profile blend reports about the shape it made (DES-6c step 2). Lengths in document units. */
export interface BlendBuildNotes {
  readonly builder: 'prism' | 'rails' | 'corners' | 'union';
  /** Largest distance between a re-skinned face and its neighbour along their shared edges, and the limit it was held to (5e-6 x diagonal). */
  readonly gap?: number;
  readonly gapLimit?: number;
  /** Largest angle (radians) between the normals of two blends of a chain along their junction; the build is refused when a junction exceeds 0.0095 (0.95 x the check_blends default) plus its own crease. */
  readonly junctionG1?: number;
  /** Largest angle (radians) between the normals of two blends of a chain at the ends of their junction, where each is tangent to its own support: the crease of the part the chain was mitred across (0 for a smooth chain). */
  readonly creaseRad?: number;
  /** A conic whose chain junctions kinked faded to the circular arc at the ends that meet the next blend: how many ends and the longest fade (arc length of the ball centre, document units). */
  readonly circularFade?: { readonly ends: number; readonly reach: number; readonly reachChords: number };
  /** The step mixes convex and concave blends, so the volume check against the circular fillet was not applied. */
  readonly mixed?: boolean;
  /** The curvature profile fell back to the zero-curvature quartic: the unique edges it applies to and why. */
  readonly fallback?: { readonly edges: readonly number[]; readonly reason: string };
  /** Corner builder: the setback factor (x the least distance) that built, and per corner its vertex and the setback of each edge there. */
  readonly factor?: number;
  /** Union builder (blend_union): per joint pick its distance to the joint it named and its radius; per contour of joints the radius it got, where it came from ("joints[i]" for the pick that named it, "default") and the names of its joint edges. */
  readonly picks?: ReadonlyArray<{ readonly distance: number; readonly radius: number }>;
  readonly contours?: ReadonlyArray<{ readonly radius: number; readonly source: string; readonly edges: readonly string[] }>;
  readonly corners?: ReadonlyArray<{
    readonly vertex: Vec3;
    /** "exact": the corner patch is a star of exact-boundary sub-patches (13.21); "plate": the MakeFilling patch. */
    readonly patch?: 'exact' | 'plate';
    readonly setbacks: ReadonlyArray<{ readonly edge: number; readonly distance: number }>;
  }>;
}

/** How an exact `deform` node built, or why it was refused (01 DEF M2, `kernel.deformReport`). Lengths in document units. */
export interface DeformReport {
  readonly ok: boolean;
  /** Stable DEF_* code of the refusal ('' when built). */
  readonly code: string;
  readonly message: string;
  /** Largest deviation of a fitted face or edge from the deformed source geometry. */
  readonly maxError: number;
  readonly surfaceError: number;
  readonly curveError: number;
  /** Faces re-approximated, edges re-approximated, faces added by splitting at the places where the law is not analytic. */
  readonly faces: number;
  readonly edges: number;
  readonly splitFaces: number;
  /** A full-turn bend: the two coincident end caps were dropped and the ring sewn closed. */
  readonly ring: boolean;
  /** Smallest det J found on the surface of the body. */
  readonly minDeterminant: number;
  readonly volume: number;
  /** The largest tolerance of any sub-shape of the result (document units). */
  readonly shapeTolerance?: number;
  /** `output.preserveAnalytic`: what the rebuild of analytic faces found (01 DEF §17.11). Absent when it was not asked. */
  readonly analyticFaces?: AnalyticFaces;
}

/** Faces of an exact deformation rebuilt on an analytic surface: counts per surface type, the B-spline faces looked at, and the largest deviation of a rebuilt face. */
interface AnalyticFaces {
  readonly tried: number;
  readonly plane: number;
  readonly cylinder: number;
  readonly cone: number;
  readonly sphere: number;
  /** Recognised through the analytic surface of their source face (a twisted cylinder: its parameterisation moved, so OCCT alone does not see it). */
  readonly fromSource: number;
  /** Recognised but the rebuilt face was not a valid face: kept as fitted. */
  readonly rejected: number;
  readonly gap: number;
  /** First BRepCheck status that made a rebuild invalid (face: 1000 + status); 0 when none did. */
  readonly rejectedStatus: number;
}

/** One cross-section of a blend face (BLD M1): the contact points on both sides, the section mid point, and the circle through the three. */
export interface BlendSection {
  /** Uniform fraction of the first contact edge's parameter (0 = its start). */
  readonly t: number;
  readonly a: Vec3;
  readonly mid: Vec3;
  readonly b: Vec3;
  /** Circumradius of the section (document units); null when the three points are collinear (a flat section). */
  readonly radius: number | null;
  readonly centre: Vec3 | null;
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
  /** The end sample sits on the collapsed side of a corner star: its normals are read just inside the end and its curvatures are 0 (not measured). */
  readonly nudged?: boolean;
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
  /** `faceQuery.bspline`: the face normal is the opposite of S_u x S_v. */
  readonly reversed?: boolean;
}

/**
 * Curves to project onto faces (03 WRP): `faces` are unique face indices; the curves go along `direction` (the nearest face ahead of each sample wins) or, with
 * `closest`, to their closest point within `maxDistance`. `sampleStep` (document units) sets the sampling, `tolerance` the fit of the returned curves.
 */
export interface CurveProjectionRequest {
  readonly faces: readonly number[];
  readonly curves: readonly NurbsCurveData[];
  readonly direction?: Vec3;
  readonly closest?: { readonly maxDistance: number };
  readonly sampleStep: number;
  readonly tolerance: number;
}

/** One run of a source curve on one face: the fitted 3D curve and its pcurve in the face's own (u, v) (OCC parametrisation). */
interface ProjectedCurve {
  readonly source: number;
  readonly face: number;
  /** Parameter range of the source curve that landed on the face. */
  readonly t0: number;
  readonly t1: number;
  readonly curve: NurbsCurveData;
  readonly pcurve: NurbsCurve2Data;
}

export interface CurveProjection {
  readonly curves: readonly ProjectedCurve[];
  /** Per source curve: the covered fraction of its parameter range (1 = every part landed on a face). */
  readonly coverage: readonly number[];
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
  /** BLD M1: `count` (2..1001) cross-sections of blend `face` between its contact edges `edgeA` and `edgeB` (unique indices), at uniform fractions of `edgeA`; null when the face lacks either edge. Absent on kernels without it. */
  blendSections?(shape: ShapeHandle, face: number, edgeA: number, edgeB: number, count: number): readonly BlendSection[] | null;
  distance(
    shape: ShapeHandle,
    points: readonly Vec3[],
  ): readonly { readonly distance: number; readonly signed: number; readonly face: number }[] | null;
  bspline(shape: ShapeHandle, face: number): NurbsSurfaceData | null;
  projectCurves(shape: ShapeHandle, request: CurveProjectionRequest): CurveProjection | null;
}
